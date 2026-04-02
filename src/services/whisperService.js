/**
 * whisperService — FIFO transcription queue with on-device Whisper.
 *
 * Architecture:
 *   - Single worker processes one item at a time from the queue
 *   - AbortController pattern: one signal cancels init, transcribe, or sleep
 *   - Context reuse: on Android, the native context is reused after success
 *     and abandoned (leaked) on error — release() is broken on Android
 *   - No retries: errors fail the item and advance the queue
 *   - No timeout: transcription runs until done or user cancels
 *   - Persistence: queue survives app restart but does NOT auto-start
 */

import { initWhisper } from 'whisper.rn';
import { AppState, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureWhisperModel } from './downloadService';
import { saveTranscripts } from '../database/queries';
import { log } from './logService';

const QUEUE_KEY = '@transcription_queue_v1';
const IS_ANDROID = Platform.OS === 'android';

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
    _notify();
    _startFg();
    if (entry.onStart) entry.onStart();

    try {
        const ctx = await _getCtx();

        // Check abort AFTER init (cancel during model load)
        if (_abort?.current) throw new Error('Cancelled');

        const nativePath = entry.audioFilePath.replace('file://', '');
        let progressAlive = true;

        const { promise, stop } = ctx.transcribe(nativePath, {
            language: 'en',
            onProgress: (p) => {
                if (!progressAlive || _activeId !== entry.id) return;
                // On Android, only negative values arrive — no real percentage.
                // On iOS, 0-100 positive values.
                if (p >= 0 && entry.onProgress) entry.onProgress(Math.min(99, p));
            },
        });

        // Store stop handle for dequeueTranscription
        _abort = _abort || {};
        const prevStop = _abort.stop;
        _abort.stop = stop;

        // Abort promise — dequeueTranscription resolves this instantly
        const abortGuard = new Promise(resolve => {
            _abort.resolve = resolve;
        });

        log('SERVICE', 'transcribe() started', { id: entry.id });

        let result;
        try {
            result = await Promise.race([promise, abortGuard]);
        } finally {
            progressAlive = false;
            _abort.resolve = null;
            _abort.stop = null;
        }

        if (_abort?.current) throw new Error('Cancelled');

        // Success
        const segments = (result?.segments || []).map(seg => ({
            start: seg.t0 * 10,
            end:   seg.t1 * 10,
            text:  seg.text,
        }));

        await saveTranscripts(entry.id, segments);
        log('SERVICE', 'Transcription completed', { id: entry.id, segments: segments.length });
        entry.resolve(segments);
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

// Resume when app returns to foreground
AppState.addEventListener('change', (state) => {
    log('SYSTEM', 'AppState', { state, running: _running, activeId: _activeId, queueLen: _queue.length });
    if (state === 'active') setTimeout(_runNext, 300);
});

// ─── Public API ──────────────────────────────────────────────────────────────

export const enqueueTranscription = (id, audioFilePath, onProgress, onStart) => {
    const isAborting = _activeId === id && _abort?.current;
    if (!isAborting && (_activeId === id || _queue.some(e => e.id === id))) {
        log('SERVICE', 'Enqueue rejected (duplicate)', { id });
        return Promise.reject(new Error('Already queued'));
    }
    log('QUEUE', 'Enqueue', { id, activeId: _activeId, queue: _queue.map(e => e.id), running: _running });

    if (FgService && !_running && _queue.length === 0) {
        FgService.requestBatteryExemption();
    }

    return new Promise((resolve, reject) => {
        _queue.push({ id, audioFilePath, onProgress, onStart, resolve, reject });
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
    _running     = false;
    _activeId    = null;
    _activeEntry = null;
    _abort       = null;

    _stopFg();
    _notify();
};

export const restoreQueue = async () => {
    log('SYSTEM', 'restoreQueue');
    _running = false; _activeId = null; _activeEntry = null;
    _abort = null; _queue.length = 0;

    try {
        const raw = await AsyncStorage.getItem(QUEUE_KEY);
        if (!raw) return;
        const items = JSON.parse(raw);
        // Don't auto-start — clears persisted queue to prevent zombie loops.
        await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
        log('SYSTEM', 'Cleared restored queue', { count: items.length });
    } catch (_) {}
};
