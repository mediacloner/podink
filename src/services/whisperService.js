/**
 * whisperService — FIFO transcription queue with on-device Sherpa-ONNX.
 *
 * Architecture:
 *   - Single worker processes one item at a time from the queue
 *   - STT engine via @siteed/sherpa-onnx.rn (Moonshine / SenseVoice)
 *   - No retries: errors fail the item and advance the queue
 *   - Timeout: dynamic per-job limit based on episode duration (min 10 min)
 *   - Pre-flight: validates audio file before enqueue AND before transcription
 *   - Background safety: Android foreground service + WakeLock
 *   - Persistence: queue survives app restart but does NOT auto-start
 */

import { ASR } from '@siteed/sherpa-onnx.rn';
import { AppState, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { ensureSherpaModel, getSherpaModelPath, SHERPA_MODELS } from './downloadService';
import { saveTranscriptsIncremental, finalizeTranscript, deleteEpisodeTranscript } from '../database/queries';
import { log } from './logService';

const DEFAULT_TIMEOUT_MS    = 10 * 60 * 1000; // 10 minutes for short/unknown episodes
const MIN_AUDIO_SIZE        = 4096;             // 4 KB minimum
const LARGE_FILE_BYTES      = 50 * 1024 * 1024; // 50 MB — assume long episode when duration unknown
const MIN_FREE_DISK_BYTES   = 200 * 1024 * 1024; // 200 MB free required before transcription
const DEFAULT_MODEL_KEY     = 'moonshine_base';

/** Compute per-job timeout from episode duration (or file size as fallback). */
const _computeTimeoutMs = (durationSec, fileSizeBytes = 0) => {
    if (durationSec > 0) {
        return Math.max(DEFAULT_TIMEOUT_MS, durationSec * 0.25 * 1000 + 5 * 60 * 1000);
    }
    if (fileSizeBytes > LARGE_FILE_BYTES) return 30 * 60 * 1000; // 30 min for large unknown files
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

    const isID3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const isMPEG = bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0;
    const isOGG = bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
    const isRIFF = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
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
    FgService.start('Transcribing podcasts', `Processing ${_queue.length + 1} episode(s)\u2026`);
};
const _stopFg = () => { if (FgService) FgService.stop(); };

// ─── STT engine (singleton ASR, reused across jobs) ─────────────────────────

let _ctxModel    = null;  // model key currently loaded
let _ctxPromise  = null;  // dedup concurrent init calls

const _initCtx = async () => {
    let modelKey = DEFAULT_MODEL_KEY;
    try {
        const saved = await AsyncStorage.getItem('@whisper_model');
        if (saved && SHERPA_MODELS[saved]) modelKey = saved;
    } catch (_) {}

    if (_ctxModel === modelKey) return;

    // Release old engine if switching models
    if (_ctxModel) {
        try { await ASR.release(); } catch (_) {}
        _ctxModel = null;
    }

    log('SYSTEM', 'Loading STT model', { modelKey });
    const folderPath = await ensureSherpaModel(modelKey);
    const model = SHERPA_MODELS[modelKey];

    const result = await ASR.initialize({
        modelDir: folderPath,
        modelType: model.modelType,
        modelFiles: model.modelFiles,
        numThreads: 4,
        debug: false,
    });

    if (!result.success) {
        throw new Error(result.error || 'Failed to initialize STT');
    }

    _ctxModel = modelKey;
    log('SYSTEM', 'STT model loaded', { modelKey });
};

const _getCtx = () => {
    if (!_ctxPromise) _ctxPromise = _initCtx().finally(() => { _ctxPromise = null; });
    return _ctxPromise;
};

const _abandonCtx = () => {
    log('SYSTEM', 'Destroying STT context');
    _ctxModel = null;
    ASR.release().catch(() => {});
};

// Pre-warm on app focus
export const initializeWhisper = () => _getCtx().catch(() => {});

// ─── Text-to-segment conversion ─────────────────────────────────────────────

/** Split full transcript text into segments at sentence boundaries.
 *  Estimates timestamps proportionally from total duration. */
const textToSegments = (text, durationMs) => {
    if (!text || !text.trim()) return [];

    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const totalLen = sentences.reduce((sum, s) => sum + s.length, 0);
    const segments = [];
    let offset = 0;

    for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;
        const start = Math.round((offset / totalLen) * durationMs);
        offset += sentence.length;
        const end = Math.round((offset / totalLen) * durationMs);
        segments.push({ start, end, text: trimmed });
    }

    return segments;
};

// ─── Whisper hallucination filter ───────────────────────────────────────────

/** Whisper Tiny gets stuck in repetition loops during music / silence / ad reads,
 *  emitting the same word or phrase dozens of times. sherpa-onnx doesn't expose
 *  Whisper's compression-ratio + temperature-fallback safeguards, so we strip
 *  the loops here. Two heuristics:
 *    (1) Near-zero-duration tokens that match any of the last 12 segments — the
 *        unmistakable "Whisper exhausted" tail (all collapse to one timestamp).
 *    (2) N-gram cycle (N=1..6): if segments[i..i+N-1] equals the last N accepted,
 *        they form a third repeat of a 2-cycle pattern — drop them. */
const dedupeHallucinations = (segments) => {
    if (segments.length === 0) return segments;
    const result = [];
    let i = 0;
    while (i < segments.length) {
        const seg = segments[i];
        const dur = seg.end - seg.start;

        if (dur < 80 && result.length > 0) {
            const recent = result.slice(-12);
            if (recent.some(r => r.text === seg.text)) { i++; continue; }
        }

        let dropped = 0;
        for (let n = 1; n <= 6; n++) {
            if (result.length < n || i + n > segments.length) break;
            let match = true;
            for (let j = 0; j < n; j++) {
                if (result[result.length - n + j].text !== segments[i + j].text) {
                    match = false;
                    break;
                }
            }
            if (match) dropped = n; // prefer longest match
        }
        if (dropped > 0) { i += dropped; continue; }

        result.push(seg);
        i++;
    }
    return result;
};

// ─── Queue state ─────────────────────────────────────────────────────────────

const _queue     = [];     // { id, audioFilePath, onProgress, onStart, resolve, reject }
let _activeId    = null;
let _running     = false;
let _abort       = null;   // { resolve, current: true }
let _processStartedAt = 0;
let _activeTimeoutMs  = DEFAULT_TIMEOUT_MS;

const _listeners = new Set();
const _notify    = () => { const fns = [..._listeners]; fns.forEach(fn => fn()); };

export const onQueueChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };
export const getActiveId   = () => _activeId;
export const getAbortingId = () => (_abort?.current ? _activeId : null);
export const getQueueIds   = () => _queue.map(e => e.id);

// ─── Persistence ─────────────────────────────────────────────────────────────

let _activeEntry = null;

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

    try {
        // Pre-flight: validate audio file
        await validateAudio(entry.audioFilePath);

        // Compute dynamic timeout
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

        await _getCtx();
        if (_abort?.current) throw new Error('Cancelled');

        const nativePath = entry.audioFilePath.replace('file://', '');

        // Update notification
        if (IS_ANDROID && FgService) {
            FgService.start('Transcribing', 'Processing audio\u2026');
        }

        // @siteed/sherpa-onnx.rn handles MP3/M4A/OGG decoding natively on Android
        // No manual WAV conversion needed
        log('SERVICE', 'recognizeFromFile() started', { id: entry.id });

        // Timeout watchdog
        const timeout = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error('Transcription timed out')), _activeTimeoutMs);
        });

        // Abort guard — dequeueTranscription resolves this
        _abort = _abort || {};
        const abortGuard = new Promise(resolve => {
            _abort.resolve = resolve;
        });

        let result;
        try {
            result = await Promise.race([ASR.recognizeFromFile(nativePath), abortGuard, timeout]);
        } finally {
            _abort.resolve = null;
            if (timeoutTimer) clearTimeout(timeoutTimer);
        }

        if (_abort?.current) throw new Error('Cancelled');

        if (!result?.success) {
            throw new Error(result?.error || 'Transcription returned no result');
        }

        // The library returns one segment per fixed-length recognition window
        // (e.g. 29s for Moonshine), with all text in that window collapsed into
        // a single string. That granularity is too coarse for sync — when the
        // player distributes words evenly across 29s, drift can exceed 10s.
        //
        // Subdivide each window into sentence-level sub-segments, distributing
        // time proportionally by character count. Sentences are typically 3–6s,
        // shrinking the per-word interpolation error to a tolerable range.
        let segments;
        if (result.segments && result.segments.length > 0) {
            segments = result.segments.flatMap(seg => {
                const winStart = Math.round(seg.startMs);
                const winDur   = Math.max(0, Math.round(seg.endMs - seg.startMs));
                return textToSegments(seg.text, winDur).map(s => ({
                    start: winStart + s.start,
                    end:   winStart + s.end,
                    text:  s.text,
                }));
            }).filter(s => s.text.length > 0);
        } else {
            segments = textToSegments(result.text, result.durationMs || (entry.durationSec * 1000) || 0);
        }

        const beforeDedupe = segments.length;
        segments = dedupeHallucinations(segments);
        log('SERVICE', 'Segments built', {
            nativeWindows: result.segments?.length ?? 0,
            beforeDedupe,
            afterDedupe: segments.length,
            droppedHallucinations: beforeDedupe - segments.length,
        });

        await saveTranscriptsIncremental(entry.id, segments);
        await finalizeTranscript(entry.id);

        if (IS_ANDROID && FgService) {
            FgService.start('Transcribing', 'Complete!');
        }

        log('SERVICE', 'Transcription completed', { id: entry.id, segments: segments.length, textLen: result.text?.length });
        entry.resolve(segments);

    } catch (e) {
        const msg = e?.message || String(e);
        log('SERVICE', 'Transcription failed', { id: entry.id, error: msg });
        _abandonCtx();
        entry.reject(e);
    } finally {
        _activeEntry = null;
        _processStartedAt = 0;
        _activeTimeoutMs = DEFAULT_TIMEOUT_MS;
        if (timeoutTimer) clearTimeout(timeoutTimer);
    }
};

// ─── Queue runner ────────────────────────────────────────────────────────────

const _runNext = async () => {
    if (_running || _queue.length === 0) return;
    _running = true;
    _abort = { current: false, resolve: null };

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
        setTimeout(_runNext, 0);
    }
};

// ─── App lifecycle ───────────────────────────────────────────────────────────

AppState.addEventListener('change', (state) => {
    log('SYSTEM', 'AppState', { state, running: _running, activeId: _activeId, queueLen: _queue.length });

    if (state === 'active') {
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
});

// ─── Public API ──────────────────────────────────────────────────────────────

export const enqueueTranscription = async (id, audioFilePath, onProgress, onStart, durationSec = 0) => {
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

    // Abort active transcription (resolve the abort guard)
    if (_activeId === id && _abort) {
        _abort.current = true;
        if (_abort.resolve) { _abort.resolve(); _abort.resolve = null; }
        _notify();
    }
};

export const resetService = async () => {
    log('SERVICE', 'Reset', { activeId: _activeId, queue: _queue.map(e => e.id), running: _running });

    if (_abort) {
        _abort.current = true;
        if (_abort.resolve) { _abort.resolve(); _abort.resolve = null; }
    }

    for (const e of _queue) { try { e.reject(new Error('Queue reset')); } catch (_) {} }
    _queue.length = 0;

    await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});

    _abandonCtx();

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
        await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
        log('SYSTEM', 'Cleared restored queue', { count: items.length });
    } catch (_) {}
};
