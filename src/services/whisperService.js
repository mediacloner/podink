import { initWhisper } from 'whisper.rn';
import { AppState, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureWhisperModel } from './downloadService';
import { saveTranscripts } from '../database/queries';

const QUEUE_PERSIST_KEY = '@transcription_queue_v1';

// Android-only foreground service — keeps the process alive during background transcription
const FgService = Platform.OS === 'android' ? NativeModules.TranscriptionService : null;

const _startFgService = () => {
    if (!FgService) return;
    const count = _persistedItems.size;
    FgService.start(
        'Transcribing podcasts',
        `Processing ${count} episode${count !== 1 ? 's' : ''}…`,
    );
};

const _stopFgService = () => {
    if (FgService) FgService.stop();
};

// ─── Whisper context management ────────────────────────────────────────────────
//
// The native Whisper context must be explicitly released before re-initializing.
// Reusing a context that was busy (or failed) causes native crashes on Android.

let whisperContext   = null;
let loadedModelType  = null;
let initializingPromise = null;

/** Release the native Whisper context and clear all references. */
const _releaseContext = async () => {
    const ctx = whisperContext;
    whisperContext  = null;
    loadedModelType = null;
    if (ctx) {
        try { await ctx.release(); } catch (_) {}
    }
};

const _doInit = async () => {
    let modelType = 'base';
    try {
        const saved = await AsyncStorage.getItem('@whisper_model');
        if (saved) modelType = saved;
    } catch (_) {}

    // q8 quantization is unsupported on Android — fall back to base
    if (Platform.OS === 'android' && modelType.includes('q8')) {
        modelType = 'base';
    }

    // Already loaded with the right model — reuse it
    if (whisperContext && loadedModelType === modelType) return whisperContext;

    // Wrong model loaded (user changed setting) — release first
    if (whisperContext) await _releaseContext();

    const modelFilePath = await ensureWhisperModel(modelType);
    whisperContext  = await initWhisper({ filePath: modelFilePath.replace('file://', '') });
    loadedModelType = modelType;
    return whisperContext;
};

export const initializeWhisper = () => {
    if (!initializingPromise) {
        initializingPromise = _doInit().finally(() => { initializingPromise = null; });
    }
    return initializingPromise;
};

// ─── FIFO transcription queue ─────────────────────────────────────────────────

// Each entry: { id, audioFilePath, onProgress, onStart, resolve, reject }
const _queue = [];
let _processing    = false;
let _activeId      = null;
let _currentStop   = null;  // stop() handle for the running transcription
let _abortCurrent  = false; // true when dequeueTranscription cancelled the active job

// Listeners notified whenever queue state changes (for UI polling-free updates)
const _listeners = new Set();
const _notify    = () => _listeners.forEach(fn => fn());

// ─── Queue persistence (survives app restarts) ─────────────────────────────────

// Persisted map: id -> audioFilePath for all pending + active items
const _persistedItems = new Map();

const _persistQueue = () => {
    const items = Array.from(_persistedItems.entries())
        .map(([id, audioFilePath]) => ({ id, audioFilePath }));
    AsyncStorage.setItem(QUEUE_PERSIST_KEY, JSON.stringify(items)).catch(() => {});
};

/**
 * Restore any unfinished transcriptions from the previous session.
 * Call this once on app startup after the DB is ready.
 */
export const restoreQueue = async () => {
    try {
        const raw = await AsyncStorage.getItem(QUEUE_PERSIST_KEY);
        if (!raw) return;
        const items = JSON.parse(raw);
        for (const { id, audioFilePath } of items) {
            if (_activeId === id || _queue.some(e => e.id === id)) continue;
            enqueueTranscription(id, audioFilePath, null, null).catch(() => {});
        }
    } catch (_) {}
};

// Resume queue when app comes back to foreground
AppState.addEventListener('change', (state) => {
    if (state === 'active') {
        // Use setTimeout so React Native bridge has time to settle after
        // coming back from background before we hit the Whisper native layer.
        setTimeout(_scheduleNext, 300);
    }
});

export const onQueueChange = (fn) => {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
};

/** Returns the ID that is currently being transcribed, or null. */
export const getActiveId = () => _activeId;

export const getQueueIds = () => _queue.map(e => e.id);

// ─── Core processing loop ──────────────────────────────────────────────────────

const MAX_RETRIES            = 2;
const RETRY_DELAY_MS         = 1500;
// If a single transcription takes longer than this, the native Whisper thread
// is considered hung. We abort it and let the retry logic decide what to do.
const TRANSCRIPTION_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

/**
 * Schedule the next item from outside of the current call stack.
 * Using setTimeout(0) prevents stack growth from recursive calls and
 * gives Android's foreground service a chance to fully start/stop between items.
 */
const _scheduleNext = () => setTimeout(_runNext, 0);

const _runNext = async () => {
    if (_processing || _queue.length === 0) return;
    _processing = true;

    const entry = _queue.shift();
    _activeId = entry.id;
    _notify();

    // Start foreground service before heavy work so Android doesn't ANR
    _startFgService();
    if (entry.onStart) entry.onStart();

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 0) {
                // Release the broken context before retrying so the native layer
                // starts completely fresh. Also give the system a brief breather.
                await _releaseContext();
                await _sleep(RETRY_DELAY_MS * attempt);
            }

            const context = await initializeWhisper();
            const nativePath = entry.audioFilePath.replace('file://', '');

            let completedChunks = 0;
            let totalChunks     = 5;
            let lastRaw         = -1;

            const normalizeProgress = (p) => {
                if (p < 0) return null;
                if (lastRaw >= 95 && p > 0 && p < lastRaw) {
                    totalChunks     = Math.round(100 / p);
                    completedChunks = Math.round((p / 100) * totalChunks);
                    lastRaw         = p;
                    return null;
                }
                lastRaw = p;
                return Math.min(99, Math.round((completedChunks / totalChunks) * 100 + (p / totalChunks)));
            };

            const { promise, stop } = context.transcribe(nativePath, {
                language: 'en',
                onProgress: (p) => {
                    const smooth = normalizeProgress(p);
                    if (smooth !== null && entry.onProgress) entry.onProgress(smooth);
                },
            });

            _currentStop = stop;

            // Watchdog: if Whisper hangs and the promise never settles,
            // fire stop() after the timeout and let the catch/retry path handle it.
            let _watchdog = null;
            const timeoutGuard = new Promise((_, reject) => {
                _watchdog = setTimeout(() => {
                    if (_currentStop) { _currentStop(); _currentStop = null; }
                    reject(new Error('Transcription timeout'));
                }, TRANSCRIPTION_TIMEOUT_MS);
            });

            let result;
            try {
                result = await Promise.race([promise, timeoutGuard]);
            } finally {
                clearTimeout(_watchdog);
            }
            _currentStop = null;

            // The user cancelled while transcription was running.
            // whisper.rn resolves (not rejects) when stop() is called, returning
            // whatever partial segments were ready. Discard them and treat as cancel.
            if (_abortCurrent) {
                throw new Error('Cancelled');
            }

            const segments = (result.segments || []).map(seg => ({
                start: seg.t0 * 10,
                end:   seg.t1 * 10,
                text:  seg.text,
            }));

            await saveTranscripts(entry.id, segments);
            entry.resolve(segments);
            lastError = null;

            // Always release context after a successful transcription so the
            // next job begins with a clean native state. The model re-load
            // overhead (~1-2 s) is worth the stability guarantee.
            await _releaseContext();
            break; // success — exit retry loop

        } catch (e) {
            _currentStop = null;
            lastError = e;
            // Ensure the context is torn down before the next attempt.
            // Calling transcribe() on a context that threw will crash natively.
            await _releaseContext();

            // Don't retry a user-initiated abort or if we've exhausted retries.
            if (_abortCurrent || attempt >= MAX_RETRIES) break;
            // Otherwise fall through to the next attempt
        }
    }

    _abortCurrent = false;

    if (lastError !== null) {
        entry.reject(lastError);
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────
    _persistedItems.delete(entry.id);
    _persistQueue();
    _processing = false;
    _activeId   = null;
    _notify();

    if (_queue.length === 0) {
        // Nothing left — stop the service and we're done.
        _stopFgService();
    } else {
        // Schedule the next item off the current call stack.
        // Separating stop/start of the foreground service into different
        // event-loop turns avoids the Android 8+ ANR where startForeground()
        // is not called quickly enough after startForegroundService().
        _scheduleNext();
    }
};

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue an episode for transcription. Returns a promise that resolves with
 * segments when this episode's turn comes and transcription completes.
 */
export const enqueueTranscription = (id, audioFilePath, onProgress, onStart) => {
    if (_activeId === id || _queue.some(e => e.id === id)) {
        return Promise.reject(new Error('Already queued'));
    }

    if (FgService && _persistedItems.size === 0) {
        FgService.requestBatteryExemption();
    }

    return new Promise((resolve, reject) => {
        _persistedItems.set(id, audioFilePath);
        _persistQueue();
        _queue.push({ id, audioFilePath, onProgress, onStart, resolve, reject });
        _notify();
        _scheduleNext();
    });
};

/**
 * Remove an episode from the queue.
 * If it is currently being transcribed, the transcription is aborted.
 */
export const dequeueTranscription = (id) => {
    // Case 1: job is waiting in the queue — remove it
    const idx = _queue.findIndex(e => e.id === id);
    if (idx !== -1) {
        _queue[idx].reject(new Error('Cancelled'));
        _queue.splice(idx, 1);
        _persistedItems.delete(id);
        _persistQueue();
        _notify();
    }

    // Case 2: job is actively transcribing — abort the native side
    if (_activeId === id && _currentStop) {
        _abortCurrent = true; // suppress retries for this abort
        _currentStop();
        _currentStop = null;
        // _runNext's catch block will handle cleanup and reject the promise
    }
};

/**
 * Force-reset the entire transcription service.
 * Use this as a last resort when the queue appears stuck and retries have
 * been exhausted (e.g. Whisper hung in native code, _processing stuck true).
 *
 * Effects:
 *   - Aborts any running native Whisper transcription
 *   - Rejects all pending queue promises
 *   - Clears AsyncStorage persistence (items will NOT be re-queued on restart)
 *   - Releases the native Whisper context
 *   - Stops the Android foreground service
 */
export const resetService = async () => {
    // Signal abort so the retry loop exits immediately if it's mid-attempt
    _abortCurrent = true;

    // Abort the native transcription
    if (_currentStop) {
        try { _currentStop(); } catch (_) {}
        _currentStop = null;
    }

    // Reject every waiting promise so callers don't hang
    for (const entry of _queue) {
        try { entry.reject(new Error('Queue reset')); } catch (_) {}
    }
    _queue.length = 0;

    // Wipe persistence so restored items don't come back
    _persistedItems.clear();
    await AsyncStorage.removeItem(QUEUE_PERSIST_KEY).catch(() => {});

    // Tear down the native context
    await _releaseContext();

    // Reset all flags
    _processing   = false;
    _activeId     = null;
    _abortCurrent = false;

    // Stop the foreground service
    _stopFgService();

    // Notify all UI listeners so they clear their queue/active state
    _notify();
};

// Legacy export kept for any other callers
export const transcribeAudio = (audioFilePath, onProgress) =>
    enqueueTranscription(audioFilePath, audioFilePath, onProgress, null);
