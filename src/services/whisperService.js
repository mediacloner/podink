import { initWhisper } from 'whisper.rn';
import { AppState, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureWhisperModel } from './downloadService';
import { saveTranscripts } from '../database/queries';
import { log } from './logService';

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

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Whisper context management ────────────────────────────────────────────────
//
// The native Whisper context must be explicitly released before re-initializing.
// Reusing a context that was busy (or failed) causes native crashes on Android.

let whisperContext   = null;
let loadedModelType  = null;
let initializingPromise = null;

/**
 * Release the native Whisper context and clear all references.
 *
 * A 5-second hard timeout prevents a permanent hang: calling release()
 * immediately after stop() can deadlock on Android — release() waits for the
 * native transcription thread, which is itself waiting to finish its abort
 * sequence. If release() doesn't return within 5 s we abandon the reference
 * and continue so the queue can recover.
 */
const _releaseContext = async () => {
    const ctx = whisperContext;
    whisperContext  = null;
    loadedModelType = null;
    if (!ctx) return;

    if (Platform.OS === 'android') {
        // release() always throws ConcurrentModificationException on Android.
        // We abandon the reference so _doInit creates a fresh context.
        // This leaks ~74 MB — but only on abort/error. After successful
        // transcription the context is reused (no release called = no leak).
        log('SYSTEM', 'Abandoning whisper context (Android — cannot release)');
        return;
    }

    log('SYSTEM', 'Releasing whisper context…');
    await Promise.race([
        ctx.release().catch((e) => { log('SYSTEM', 'release() error (ignored)', { error: String(e) }); }),
        _sleep(5000).then(() => { log('SYSTEM', 'release() timed out (5s) — abandoned'); }),
    ]);
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

    // Bail immediately if an abort was requested while we were waiting to init
    if (_abortCurrent) throw new Error('Cancelled');

    // Already loaded with the right model — reuse it
    if (whisperContext && loadedModelType === modelType) return whisperContext;

    // Wrong model loaded (user changed setting) — abandon old context
    if (whisperContext) await _releaseContext();

    log('SYSTEM', 'Loading whisper model', { modelType });
    let modelFilePath;
    try {
        modelFilePath = await ensureWhisperModel(modelType);
    } catch (e) {
        log('SYSTEM', 'ensureWhisperModel FAILED', { modelType, error: e?.message || String(e) });
        throw e;
    }
    try {
        whisperContext = await initWhisper({ filePath: modelFilePath.replace('file://', '') });
    } catch (e) {
        log('SYSTEM', 'initWhisper FAILED', { modelType, error: e?.message || String(e) });
        throw e;
    }
    loadedModelType = modelType;
    log('SYSTEM', 'Whisper model loaded', { modelType });
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
let _abortResolve  = null;  // resolves the abort promise to instantly unblock Promise.race
let _generation    = 0;     // incremented on reset — lets orphaned _runNext detect staleness

// Listeners notified whenever queue state changes (for UI polling-free updates)
const _listeners = new Set();
const _notify    = () => { const fns = [..._listeners]; fns.forEach(fn => fn()); };

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
 *
 * Recovery from stuck states is handled by: _abortResolve (instant cancel),
 * generation counter (stale _runNext detection), and the manual Reset button.
 */
export const restoreQueue = async () => {
    log('SYSTEM', 'restoreQueue called — hard reset flags');
    // Hard-reset all runtime flags at startup. The previous JS session's
    // in-memory state is unreliable — the only source of truth is AsyncStorage.
    _processing   = false;
    _activeId     = null;
    _abortCurrent = false;
    _currentStop  = null;
    _queue.length = 0;
    _persistedItems.clear();

    // The 90-second startup watchdog has been removed. Recovery is now
    // handled by: _abortResolve (instant cancel), generation counter
    // (stale _runNext detection), and the manual Reset button in Settings.

    try {
        const raw = await AsyncStorage.getItem(QUEUE_PERSIST_KEY);
        if (!raw) return;
        const items = JSON.parse(raw);
        // DON'T auto-start transcriptions on restore — just remember them.
        // Auto-starting after a crash creates zombie amplification: each crash
        // leaves native whisper threads running, and restarting adds more.
        // The user can manually re-transcribe from the Library screen.
        // Clear the persisted queue so they don't re-enqueue on next restart.
        await AsyncStorage.removeItem(QUEUE_PERSIST_KEY).catch(() => {});
        log('SYSTEM', 'Cleared restored queue (manual re-transcribe required)', {
            count: items.length,
            ids: items.map(i => i.id),
        });
    } catch (_) {}
};

// Resume queue when app comes back to foreground
AppState.addEventListener('change', (state) => {
    log('SYSTEM', 'AppState changed', { state, processing: _processing, activeId: _activeId, queueLen: _queue.length });
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

/** Returns the ID currently being aborted (cancel in progress), or null. */
export const getAbortingId = () => (_abortCurrent ? _activeId : null);

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

    const gen   = _generation; // snapshot — if reset happens, gen !== _generation
    const entry = _queue.shift();
    _activeId = entry.id;
    log('SERVICE', 'Transcription started', { id: entry.id, gen, remainingQueue: _queue.map(e => e.id) });
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

            // Bail if a reset happened while we were awaiting (resetService sets
            // _abortCurrent=false so that flag alone can't catch stale runs).
            if (gen !== _generation) throw new Error('Cancelled');

            const context = await initializeWhisper();

            // Abort could have been requested while the model was loading,
            // OR a reset happened (generation changed).
            if (_abortCurrent || gen !== _generation) throw new Error('Cancelled');

            const nativePath = entry.audioFilePath.replace('file://', '');

            let completedChunks = 0;
            let totalChunks     = 5;
            let lastRaw         = -1;
            let negativeCount   = 0; // Android: whisper.rn sends only negatives

            const normalizeProgress = (p) => {
                // Android quirk: whisper.rn fires onProgress with negative
                // values (-1, -2, …) meaning "working, no exact %".
                // Estimate slow progress from callback count so the UI
                // shows activity instead of "…" forever.
                if (p < 0) {
                    negativeCount++;
                    return Math.min(95, negativeCount);
                }
                if (lastRaw >= 95 && p > 0 && p < lastRaw) {
                    totalChunks     = Math.round(100 / p);
                    completedChunks = Math.round((p / 100) * totalChunks);
                    lastRaw         = p;
                    return null;
                }
                lastRaw = p;
                return Math.min(99, Math.round((completedChunks / totalChunks) * 100 + (p / totalChunks)));
            };

            let _progressCount = 0;
            const { promise, stop } = context.transcribe(nativePath, {
                language: 'en',
                onProgress: (p) => {
                    // Ignore zombie callbacks from cancelled native threads.
                    // On Android, release() times out and the old whisper thread
                    // keeps running, firing onProgress on stale closures.
                    if (_activeId !== entry.id) return;

                    _progressCount++;
                    if (_progressCount <= 3 || _progressCount % 20 === 0) {
                        log('SERVICE', 'onProgress', { id: entry.id, raw: p, count: _progressCount });
                    }
                    const smooth = normalizeProgress(p);
                    if (smooth !== null && entry.onProgress) entry.onProgress(smooth);
                },
            });

            _currentStop = stop;
            log('SERVICE', 'transcribe() called, waiting for result…', { id: entry.id });

            // Abort promise: resolved instantly by dequeueTranscription() so
            // Promise.race unblocks even if the native stop() never settles the
            // transcribe promise (confirmed Android bug via debug logs).
            const abortGuard = new Promise((resolve) => { _abortResolve = resolve; });

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
                result = await Promise.race([promise, timeoutGuard, abortGuard]);
            } finally {
                clearTimeout(_watchdog);
                _abortResolve = null;
            }
            _currentStop = null;

            // The user cancelled while transcription was running.
            // On Android, stop() often does NOT cause the transcribe promise to
            // settle — the abortGuard wins the race instead. Either way, discard.
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
            log('SERVICE', 'Transcription completed', { id: entry.id, segments: segments.length });

            // Reuse the context for the next transcription — on Android,
            // release() never works and leaks memory. iOS releases in _doInit
            // if the model changes.
            break; // success — exit retry loop

        } catch (e) {
            _currentStop = null;
            lastError = e;
            log('SERVICE', 'Transcription error', {
                id: entry.id, error: e?.message || String(e), attempt, aborted: _abortCurrent,
                stack: e?.stack?.slice(0, 400),
            });

            // Abandon the context so the next attempt gets a fresh one.
            // On Android, this nulls out refs (native can't be released).
            // On iOS, this calls ctx.release().
            await _releaseContext();

            // Don't retry a user-initiated abort, a reset, or exhausted retries.
            if (_abortCurrent || gen !== _generation || attempt >= MAX_RETRIES) break;
            // Otherwise fall through to the next attempt
        }
    }

    _abortCurrent = false;

    if (lastError !== null) {
        entry.reject(lastError);
    }

    // If a reset happened while we were running, our shared-state references
    // are stale — resetService already cleaned everything up. Just bail.
    if (gen !== _generation) {
        log('SERVICE', 'Stale _runNext after reset — skipping cleanup', { id: entry.id, gen, curGen: _generation });
        return;
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────
    _persistedItems.delete(entry.id);
    _persistQueue();
    _processing = false;
    _activeId   = null;
    log('SERVICE', 'Cleanup done', { id: entry.id, hadError: lastError !== null, nextInQueue: _queue.length });
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

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue an episode for transcription. Returns a promise that resolves with
 * segments when this episode's turn comes and transcription completes.
 */
export const enqueueTranscription = (id, audioFilePath, onProgress, onStart) => {
    // Allow re-enqueue if the active job for this ID is already being aborted.
    // Without this, tapping "Transcribe" immediately after "Cancel" is silently
    // rejected because _activeId still equals id while the abort cleanup runs.
    const isBeingAborted = _activeId === id && _abortCurrent;
    if (!isBeingAborted && (_activeId === id || _queue.some(e => e.id === id))) {
        log('SERVICE', 'Enqueue rejected (already queued)', { id });
        return Promise.reject(new Error('Already queued'));
    }
    log('QUEUE', 'Enqueue', { id, activeId: _activeId, queueBefore: _queue.map(e => e.id), processing: _processing });

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
    log('QUEUE', 'Dequeue requested', { id, activeId: _activeId, queue: _queue.map(e => e.id), processing: _processing });
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
    if (_activeId === id) {
        _abortCurrent = true; // suppress retries for this abort
        if (_currentStop) { _currentStop(); _currentStop = null; }
        // Resolve the abort promise to instantly unblock Promise.race in _runNext.
        // On Android, stop() does NOT reliably settle the transcribe promise,
        // so this is the primary abort mechanism.
        if (_abortResolve) { _abortResolve(); _abortResolve = null; }
        _notify(); // let UI know abort started so it can clear the active state immediately
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
    log('SERVICE', 'Reset requested', { activeId: _activeId, queue: _queue.map(e => e.id), processing: _processing, gen: _generation });
    // Bump generation so any orphaned _runNext from before the reset
    // will bail on its next await (it captured the old generation).
    _generation++;
    // Signal abort so the retry loop exits immediately if it's mid-attempt
    _abortCurrent = true;

    // Abort the native transcription
    if (_currentStop) {
        try { _currentStop(); } catch (_) {}
        _currentStop = null;
    }
    // Unblock Promise.race if still waiting
    if (_abortResolve) { _abortResolve(); _abortResolve = null; }

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
