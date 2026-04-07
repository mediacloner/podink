/**
 * whisperService — FIFO transcription queue with on-device Whisper.
 *
 * Architecture:
 *   - Single worker processes one item at a time from the queue
 *   - AbortController pattern: one signal cancels init, transcribe, or sleep
 *   - Context reuse: on Android, the native context is reused after success
 *     and abandoned (leaked) on error — release() is broken on Android
 *   - No retries: errors fail the item and advance the queue
 *   - Timeout: dynamic per-job limit based on episode duration (min 10 min)
 *   - Heartbeat: 5-minute no-progress watchdog (relaxed for parallel decode)
 *   - Pre-flight: validates audio file before enqueue AND before transcription
 *   - Background safety: full abort on background to prevent onHostDestroy ANR
 *   - Persistence: queue survives app restart but does NOT auto-start
 */

import { initWhisper } from 'whisper.rn';
import { AppState, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { ensureWhisperModel } from './downloadService';
import { saveTranscriptsIncremental, finalizeTranscript, deleteEpisodeTranscript } from '../database/queries';
import { log } from './logService';

const DEFAULT_TIMEOUT_MS    = 10 * 60 * 1000; // 10 minutes for short/unknown episodes
const HEARTBEAT_MS          = 5 * 60 * 1000;   // 5 minutes without progress = stuck (relaxed for nProcessors parallel decode)
const MIN_AUDIO_SIZE        = 4096;             // 4 KB minimum
const LARGE_FILE_BYTES      = 50 * 1024 * 1024; // 50 MB — assume long episode when duration unknown
const MIN_FREE_DISK_BYTES   = 200 * 1024 * 1024; // 200 MB free required before transcription
const INCREMENTAL_SAVE_MS   = 2 * 60 * 1000;     // flush accumulated segments to DB every 2 min

/** Compute per-job timeout from episode duration (or file size as fallback). */
const _computeTimeoutMs = (durationSec, fileSizeBytes = 0) => {
    if (durationSec > 0) {
        // ~0.6x realtime worst case + 5 min buffer for model init/IO
        return Math.max(DEFAULT_TIMEOUT_MS, durationSec * 0.6 * 1000 + 5 * 60 * 1000);
    }
    // Duration unknown — use file size heuristic
    if (fileSizeBytes > LARGE_FILE_BYTES) return 60 * 60 * 1000; // 60 min
    return DEFAULT_TIMEOUT_MS;
};

const QUEUE_KEY = '@transcription_queue_v1';
const IS_ANDROID = Platform.OS === 'android';

// ─── Audio pre-flight check ──────────────────────────────────────────────────

export const validateAudio = async (filePath) => {
    const uri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    const info = await FileSystem.getInfoAsync(uri);

    if (!info.exists) throw new Error('Audio file not found');
    if (info.size < MIN_AUDIO_SIZE) throw new Error(`Audio file too small (${info.size} bytes)`);

    // Read first 4 bytes to check for valid audio header
    const head = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        length: 4,
        position: 0,
    });
    const bytes = Uint8Array.from(atob(head), c => c.charCodeAt(0));

    // ID3 tag (mp3 with metadata)
    const isID3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    // MPEG sync word (raw mp3 frame)
    const isMPEG = bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0;
    // OGG container
    const isOGG = bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
    // RIFF/WAV
    const isRIFF = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    // M4A/AAC (ftyp box)
    const isM4A = bytes[0] === 0x00 && bytes[3] === 0x66;

    if (!isID3 && !isMPEG && !isOGG && !isRIFF && !isM4A) {
        throw new Error('Invalid audio file (unrecognized header)');
    }

    log('SERVICE', 'Audio validated', { size: info.size, isID3, isMPEG, isOGG, isRIFF, isM4A });
};

// ─── Android foreground service ──────────────────────────────────────────────

const FgService = IS_ANDROID ? NativeModules.TranscriptionService : null;

const _startFg = () => {
    if (!FgService) return;
    FgService.start('Transcribing podcasts', `Processing ${_queue.length + 1} episode(s)…`);
};
const _stopFg = () => { if (FgService) FgService.stop(); };

// ─── Whisper context (singleton, reused on Android) ──────────────────────────

let _ctx         = null;  // native whisper context
let _ctxModel    = null;  // model type currently loaded
let _ctxPromise  = null;  // dedup concurrent init calls

const _initCtx = async () => {
    let model = 'base';
    try { const s = await AsyncStorage.getItem('@whisper_model'); if (s) model = s; } catch (_) {}
    if (IS_ANDROID && model.includes('q8')) model = 'base';

    if (_ctx && _ctxModel === model) return _ctx;

    // Model changed — abandon old (can't release on Android)
    if (_ctx) {
        _ctx = null; _ctxModel = null;
        if (!IS_ANDROID) {
            // iOS: best-effort release
            log('SYSTEM', 'Releasing whisper context (iOS)');
            try { await Promise.race([_ctx?.release(), new Promise(r => setTimeout(r, 5000))]); } catch (_) {}
        }
    }

    log('SYSTEM', 'Loading whisper model', { model });
    const path = await ensureWhisperModel(model);
    _ctx = await initWhisper({ filePath: path.replace('file://', '') });
    _ctxModel = model;
    log('SYSTEM', 'Whisper model loaded', { model });
    return _ctx;
};

const _getCtx = () => {
    if (!_ctxPromise) _ctxPromise = _initCtx().finally(() => { _ctxPromise = null; });
    return _ctxPromise;
};

/** Abandon the context so next call to _getCtx creates a fresh one. */
const _abandonCtx = () => {
    log('SYSTEM', IS_ANDROID ? 'Abandoning context (Android)' : 'Releasing context');
    const old = _ctx;
    _ctx = null; _ctxModel = null;
    if (old && !IS_ANDROID) old.release().catch(() => {});
};

// Pre-warm on app focus
export const initializeWhisper = () => _getCtx().catch(() => {});

// ─── Queue state ─────────────────────────────────────────────────────────────

const _queue     = [];     // { id, audioFilePath, onProgress, onStart, resolve, reject }
let _activeId    = null;
let _running     = false;  // true while _process is executing
let _abort       = null;   // { resolve, current: true } — single abort controller
let _processStartedAt = 0; // timestamp when _process started (for staleness detection)
let _activeTimeoutMs  = DEFAULT_TIMEOUT_MS; // dynamic timeout for the current job

const _listeners = new Set();
const _notify    = () => { const fns = [..._listeners]; fns.forEach(fn => fn()); };

export const onQueueChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };
export const getActiveId   = () => _activeId;
export const getAbortingId = () => (_abort?.current ? _activeId : null);
export const getQueueIds   = () => _queue.map(e => e.id);

// ─── Persistence ─────────────────────────────────────────────────────────────

let _activeEntry = null;  // ref to the item currently being processed

const _persistQueue = () => {
    const items = [
        ...(_activeEntry ? [{ id: _activeEntry.id, audioFilePath: _activeEntry.audioFilePath }] : []),
        ..._queue.map(e => ({ id: e.id, audioFilePath: e.audioFilePath })),
    ];
    AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items)).catch(() => {});
};

// ─── Core worker ─────────────────────────────────────────────────────────────

const _process = async (entry) => {
    _activeId    = entry.id;
    _activeEntry = entry;
    _processStartedAt = Date.now();
    _notify();
    _startFg();
    if (entry.onStart) entry.onStart();

    let timeoutTimer = null;
    let heartbeatTimer = null;

    try {
        // Pre-flight: validate audio file before loading model
        await validateAudio(entry.audioFilePath);

        // Compute dynamic timeout from duration (or file size fallback)
        const uri = entry.audioFilePath.startsWith('file://') ? entry.audioFilePath : `file://${entry.audioFilePath}`;
        const fileInfo = await FileSystem.getInfoAsync(uri);
        _activeTimeoutMs = _computeTimeoutMs(entry.durationSec || 0, fileInfo.size || 0);
        log('SERVICE', 'Dynamic timeout', { durationSec: entry.durationSec, fileSize: fileInfo.size, timeoutMin: Math.round(_activeTimeoutMs / 60000) });

        // Disk space pre-flight
        const freeBytes = await FileSystem.getFreeDiskStorageAsync();
        if (freeBytes < MIN_FREE_DISK_BYTES) {
            throw new Error(`Low disk space (${Math.round(freeBytes / 1024 / 1024)} MB free, need ${Math.round(MIN_FREE_DISK_BYTES / 1024 / 1024)} MB)`);
        }

        // Clear any partial transcript from a previous interrupted attempt
        await deleteEpisodeTranscript(entry.id);

        const ctx = await _getCtx();

        // Check abort AFTER init (cancel during model load)
        if (_abort?.current) throw new Error('Cancelled');

        const nativePath = entry.audioFilePath.replace('file://', '');
        let progressAlive = true;
        let lastProgressAt = Date.now();

        const totalMs = (entry.durationSec || 0) * 1000;
        let _maxPct = 0;      // monotonic progress — never goes backwards
        let _decodedMs = 0;   // running sum of decoded audio time (accurate with nProcessors>1)

        // Incremental segment accumulator — flushes to DB periodically
        const _pendingSegments = [];
        let _lastFlushAt = Date.now();
        const _flushSegments = async () => {
            if (_pendingSegments.length === 0) return;
            const batch = _pendingSegments.splice(0);
            try {
                await saveTranscriptsIncremental(entry.id, batch);
                log('SERVICE', 'Incremental save', { id: entry.id, saved: batch.length });
            } catch (e) {
                // Put them back on failure so we don't lose data
                _pendingSegments.unshift(...batch);
                log('SERVICE', 'Incremental save failed', { id: entry.id, error: e?.message });
            }
        };

        // Update foreground notification with progress (every 10% on Android)
        let _lastNotifiedPct = -1;
        const _updateNotification = (pct) => {
            const rounded = Math.floor(pct / 10) * 10;
            if (IS_ANDROID && FgService && rounded > _lastNotifiedPct) {
                _lastNotifiedPct = rounded;
                FgService.start('Transcribing', `${rounded}% complete\u2026`);
            }
        };

        // Reduce parallel decode for long episodes to halve peak RAM (~250MB vs ~500MB)
        const isLongEpisode = (entry.durationSec || 0) > 30 * 60;
        const nProc = IS_ANDROID ? (isLongEpisode ? 1 : 2) : 1;
        if (isLongEpisode) log('SERVICE', 'Long episode — using nProcessors=1 for RAM safety', { durationSec: entry.durationSec });

        const { promise, stop } = ctx.transcribe(nativePath, {
            language: 'en',
            maxThreads: IS_ANDROID ? 4 : 0,   // Pixel 7: 4 perf cores. 0 = auto on iOS.
            nProcessors: nProc,
            onProgress: (p) => {
                if (!progressAlive || _activeId !== entry.id) return;
                lastProgressAt = Date.now();
                // On iOS, 0-100 positive values work directly.
                // On Android, only negative values arrive — use onNewSegments instead.
                if (p >= 0) {
                    const clamped = Math.min(99, p);
                    if (clamped > _maxPct) {
                        _maxPct = clamped;
                        if (entry.onProgress) entry.onProgress(_maxPct);
                        _updateNotification(_maxPct);
                    }
                }
            },
            onNewSegments: (data) => {
                if (!progressAlive || _activeId !== entry.id) return;
                lastProgressAt = Date.now();
                // Accumulate segments for incremental saving + progress tracking
                if (data.segments?.length > 0) {
                    for (const seg of data.segments) {
                        _pendingSegments.push({ start: seg.t0 * 10, end: seg.t1 * 10, text: seg.text });
                        // Running sum of decoded time — accurate even with nProcessors=2
                        // (each chunk covers a different time range, so summing durations = total decoded)
                        _decodedMs += (seg.t1 - seg.t0) * 10;
                    }
                    // Flush to DB every INCREMENTAL_SAVE_MS
                    if (Date.now() - _lastFlushAt >= INCREMENTAL_SAVE_MS) {
                        _lastFlushAt = Date.now();
                        _flushSegments(); // fire-and-forget (async)
                    }
                    // Progress from total decoded time (works correctly with parallel chunks)
                    if (IS_ANDROID && totalMs > 0) {
                        const pct = Math.min(99, Math.round((_decodedMs / totalMs) * 100));
                        if (pct > _maxPct) {
                            _maxPct = pct;
                            if (entry.onProgress) entry.onProgress(_maxPct);
                            _updateNotification(_maxPct);
                        }
                    }
                }
            },
        });

        // Store stop handle for dequeueTranscription
        _abort = _abort || {};
        _abort.stop = stop;

        // Abort promise — dequeueTranscription resolves this instantly
        const abortGuard = new Promise(resolve => {
            _abort.resolve = resolve;
        });

        // Timeout watchdog — kills hung native transcriptions (Fix #2: clearable)
        const timeout = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error('Transcription timed out')), _activeTimeoutMs);
        });

        // Heartbeat watchdog — detects stalls (no progress for 2 min)
        const heartbeat = new Promise((_, reject) => {
            const check = () => {
                if (!progressAlive) return; // job done, stop checking
                const silent = Date.now() - lastProgressAt;
                if (silent >= HEARTBEAT_MS) {
                    reject(new Error(`Transcription stalled (no progress for ${Math.round(silent / 1000)}s)`));
                    return;
                }
                heartbeatTimer = setTimeout(check, 30000); // re-check every 30s
            };
            heartbeatTimer = setTimeout(check, HEARTBEAT_MS);
        });

        log('SERVICE', 'transcribe() started', { id: entry.id });

        let result;
        try {
            result = await Promise.race([promise, abortGuard, timeout, heartbeat]);
        } finally {
            progressAlive = false;
            _abort.resolve = null;
            _abort.stop = null;
            // Fix #2: clear timers so they don't fire after completion
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (heartbeatTimer) clearTimeout(heartbeatTimer);
        }

        if (_abort?.current) throw new Error('Cancelled');

        // Success — collect any remaining segments from result that weren't in onNewSegments
        const resultSegments = (result?.segments || []).map(seg => ({
            start: seg.t0 * 10,
            end:   seg.t1 * 10,
            text:  seg.text,
        }));
        // If onNewSegments didn't fire (iOS path), all segments are in resultSegments
        if (_pendingSegments.length === 0 && resultSegments.length > 0) {
            _pendingSegments.push(...resultSegments);
        }
        // Final flush of any remaining accumulated segments
        await _flushSegments();
        await finalizeTranscript(entry.id);
        log('SERVICE', 'Transcription completed', { id: entry.id, segments: resultSegments.length });
        entry.resolve(resultSegments);
        // Context reused — no abandon needed

    } catch (e) {
        const msg = e?.message || String(e);
        log('SERVICE', 'Transcription failed', { id: entry.id, error: msg });

        // Abandon context on error so next item gets a fresh one
        // (the old native thread may still be busy)
        _abandonCtx();

        entry.reject(e);
    } finally {
        _activeEntry = null;
        _processStartedAt = 0;
        _activeTimeoutMs = DEFAULT_TIMEOUT_MS;
        // Safety: clear timers in case catch path didn't reach the inner finally
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
    }
};

// ─── Queue runner ────────────────────────────────────────────────────────────

const _runNext = async () => {
    if (_running || _queue.length === 0) return;
    _running = true;
    _abort = { current: false, resolve: null, stop: null };

    const entry = _queue.shift();
    log('SERVICE', 'Processing next', { id: entry.id, remaining: _queue.map(e => e.id) });

    await _process(entry);

    // Cleanup
    _activeId = null;
    _running  = false;
    _abort    = null;
    _persistQueue();
    _notify();

    if (_queue.length === 0) {
        _stopFg();
        log('SERVICE', 'Queue empty');
    } else {
        // Next tick — avoid ANR on Android from tight service stop/start
        setTimeout(_runNext, 0);
    }
};

// ─── App lifecycle ───────────────────────────────────────────────────────────

AppState.addEventListener('change', (state) => {
    log('SYSTEM', 'AppState', { state, running: _running, activeId: _activeId, queueLen: _queue.length });

    if (state === 'active') {
        // Fix #3: Detect stale _running flag.
        // If _process has been running for > TRANSCRIBE_TIMEOUT_MS, it's stuck.
        // Force-reset so _runNext can process remaining items.
        if (_running && _processStartedAt > 0) {
            const elapsed = Date.now() - _processStartedAt;
            if (elapsed > _activeTimeoutMs + 5000) {
                log('SYSTEM', 'Stale _running detected, force-resetting', { elapsed, activeId: _activeId });
                _abandonCtx();
                _activeId = null;
                _activeEntry = null;
                _running = false;
                _abort = null;
                _processStartedAt = 0;
                _stopFg();
                _persistQueue();
                _notify();
            }
        }
        setTimeout(_runNext, 300);
    }
    // NOTE: We intentionally do NOT stop transcription on background.
    // The Android foreground service keeps the process alive and prevents
    // onHostDestroy from being called while transcription is active.
    // The 10-min timeout + heartbeat protect against hangs.
});

// ─── Public API ──────────────────────────────────────────────────────────────

export const enqueueTranscription = async (id, audioFilePath, onProgress, onStart, durationSec = 0) => {
    // Fix #5: Validate audio at enqueue time — fail fast before touching the queue
    await validateAudio(audioFilePath);

    const isAborting = _activeId === id && _abort?.current;
    if (!isAborting && (_activeId === id || _queue.some(e => e.id === id))) {
        log('SERVICE', 'Enqueue rejected (duplicate)', { id });
        throw new Error('Already queued');
    }
    log('QUEUE', 'Enqueue', { id, activeId: _activeId, queue: _queue.map(e => e.id), running: _running });

    if (FgService && !_running && _queue.length === 0) {
        FgService.requestBatteryExemption();
    }

    return new Promise((resolve, reject) => {
        _queue.push({ id, audioFilePath, onProgress, onStart, durationSec, resolve, reject });
        _persistQueue();
        _notify();
        setTimeout(_runNext, 0);
    });
};

export const dequeueTranscription = (id) => {
    log('QUEUE', 'Dequeue', { id, activeId: _activeId, queue: _queue.map(e => e.id) });

    // Remove from waiting queue
    const idx = _queue.findIndex(e => e.id === id);
    if (idx !== -1) {
        _queue[idx].reject(new Error('Cancelled'));
        _queue.splice(idx, 1);
        _persistQueue();
        _notify();
    }

    // Abort active transcription
    if (_activeId === id && _abort) {
        _abort.current = true;
        if (_abort.stop) { _abort.stop(); _abort.stop = null; }
        if (_abort.resolve) { _abort.resolve(); _abort.resolve = null; }
        _notify();
    }
};

export const resetService = async () => {
    log('SERVICE', 'Reset', { activeId: _activeId, queue: _queue.map(e => e.id), running: _running });

    // Abort current
    if (_abort) {
        _abort.current = true;
        if (_abort.stop) { try { _abort.stop(); } catch (_) {} _abort.stop = null; }
        if (_abort.resolve) { _abort.resolve(); _abort.resolve = null; }
    }

    // Reject all queued
    for (const e of _queue) { try { e.reject(new Error('Queue reset')); } catch (_) {} }
    _queue.length = 0;

    // Clear persistence
    await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});

    // Abandon context
    _abandonCtx();

    // Reset state
    _running          = false;
    _activeId         = null;
    _activeEntry      = null;
    _abort            = null;
    _processStartedAt = 0;
    _activeTimeoutMs  = DEFAULT_TIMEOUT_MS;

    _stopFg();
    _notify();
};

export const restoreQueue = async () => {
    log('SYSTEM', 'restoreQueue');
    _running = false; _activeId = null; _activeEntry = null;
    _abort = null; _queue.length = 0; _processStartedAt = 0;

    try {
        const raw = await AsyncStorage.getItem(QUEUE_KEY);
        if (!raw) return;
        const items = JSON.parse(raw);
        // Don't auto-start — clears persisted queue to prevent zombie loops.
        await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
        log('SYSTEM', 'Cleared restored queue', { count: items.length });
    } catch (_) {}
};
