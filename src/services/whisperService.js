/**
 * whisperService — FIFO transcription queue with on-device Sherpa-ONNX.
 *
 * Architecture:
 *   - Single worker processes one item at a time from the queue
 *   - STT engine via @siteed/sherpa-onnx.rn (Whisper / SenseVoice)
 *   - Streaming: native emits one 'SherpaAsrWindowResult' event per ~29s
 *     window; each window is deduped, saved incrementally, and broadcast as
 *     progress (onProgress / onTranscriptProgress / libraryEvents)
 *   - Real cancellation: dequeue/timeout flips a native AtomicBoolean, so
 *     decoding stops at the next window boundary instead of running to EOF
 *   - Resume: partial rows + matching model marker restart from the last
 *     saved end-time instead of wiping
 *   - No retries: errors fail the item and advance the queue
 *   - Timeout: dynamic per-job limit based on episode duration (min 10 min)
 *   - Pre-flight: validates audio file before enqueue AND before transcription
 *   - Background safety: Android foreground service + WakeLock
 *   - Persistence: queue survives app restart and restoreQueue re-enqueues
 *     episodes that are still downloaded but untranscribed
 */

import { ASR } from '@siteed/sherpa-onnx.rn';
import { AppState, DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { ensureSherpaModel, isSherpaModelDownloaded, SHERPA_MODELS } from './downloadService';
import {
    saveTranscriptsIncremental,
    finalizeTranscript,
    deleteEpisodeTranscript,
    getTranscriptLastEndMs,
    getEpisodeById,
} from '../database/queries';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

const DEFAULT_TIMEOUT_MS    = 10 * 60 * 1000; // 10 minutes for short/unknown episodes
const MIN_AUDIO_SIZE        = 4096;             // 4 KB minimum
const LARGE_FILE_BYTES      = 50 * 1024 * 1024; // 50 MB — assume long episode when duration unknown
const MIN_FREE_DISK_BYTES   = 200 * 1024 * 1024; // 200 MB free required before transcription
const DEFAULT_MODEL_KEY     = 'whisper_tiny_en';

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
const WINDOW_EVENT = 'SherpaAsrWindowResult';
// Must track native OFFLINE_WHISPER_MAX_WINDOW_SECONDS (29s) in ASRHandler.kt —
// used to estimate total duration when the episode duration is unknown.
const WINDOW_MS = 29 * 1000;
const JOB_MARKER_PREFIX = '@transcript_job_';
const NOTIF_THROTTLE_MS = 10 * 1000; // at most one notification update per 10s

// ─── Audio pre-flight check ──────────────────────────────────────────────────

export const validateAudio = async (filePath) => {
    const uri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    const info = await FileSystem.getInfoAsync(uri);

    if (!info.exists) throw new Error('Audio file not found');
    if (info.size < MIN_AUDIO_SIZE) throw new Error(`Audio file too small (${info.size} bytes)`);

    // Read first 12 bytes to check for valid audio header. M4A/MP4 needs >= 8:
    // bytes 0-3 are the ftyp box size, 4-7 are the 'ftyp' literal.
    const head = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        length: 12,
        position: 0,
    });
    const bytes = Uint8Array.from(atob(head), c => c.charCodeAt(0));

    const isID3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const isMPEG = bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0;
    const isOGG = bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
    const isRIFF = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    // ISO-BMFF (M4A/MP4/AAC): 'ftyp' (0x66 0x74 0x79 0x70) at offset 4, after the
    // 4-byte big-endian box size. (The old check tested bytes[3]===0x66, which is
    // the box-size low byte — never 'f' — so every M4A was wrongly rejected.)
    const isM4A = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;

    if (!isID3 && !isMPEG && !isOGG && !isRIFF && !isM4A) {
        throw new Error('Invalid audio file (unrecognized header)');
    }

    log('SERVICE', 'Audio validated', { size: info.size, isID3, isMPEG, isOGG, isRIFF, isM4A });
};

// ─── Android foreground service ──────────────────────────────────────────────

const FgService = IS_ANDROID ? NativeModules.TranscriptionService : null;
const SherpaNative = IS_ANDROID ? NativeModules.SherpaOnnx : null;

// Every start() re-acquires the wake lock, so per-window refreshes extend the
// CPU budget for the whole job. durationSec sizes that budget natively.
const _startFg = (title, message, durationSec = 0) => {
    if (!FgService) return;
    FgService.start(title, message, durationSec || 0);
};
const _stopFg = () => { if (FgService) FgService.stop(); };

let _notifPermissionRequested = false;
/** Android 13+ hides FGS notifications without POST_NOTIFICATIONS; the service
 *  still runs when denied, the user just loses the progress notification. */
const _ensureNotificationPermission = async () => {
    if (!IS_ANDROID || Platform.Version < 33 || _notifPermissionRequested) return;
    _notifPermissionRequested = true;
    try {
        const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
        const has = await PermissionsAndroid.check(perm);
        if (!has) await PermissionsAndroid.request(perm);
    } catch (_) {}
};

/** Stop native decoding (takes effect at the next ~29s window boundary). */
const _cancelNative = () => {
    try {
        if (SherpaNative && typeof SherpaNative.cancelAsrFileRecognition === 'function') {
            SherpaNative.cancelAsrFileRecognition();
        }
    } catch (_) {}
};

// ─── STT engine (singleton ASR, reused across jobs) ─────────────────────────

let _ctxModel    = null;  // model key currently loaded
let _ctxPromise  = null;  // dedup concurrent init calls

const _initCtx = async (allowDownload = true) => {
    let modelKey = DEFAULT_MODEL_KEY;
    try {
        const saved = await AsyncStorage.getItem('@whisper_model');
        if (saved && SHERPA_MODELS[saved]) {
            modelKey = saved;
        } else if (saved) {
            // Stored model no longer exists in the lineup (e.g. retired
            // Moonshine keys) — persist the fallback so Settings shows
            // what the engine actually loads.
            await AsyncStorage.setItem('@whisper_model', DEFAULT_MODEL_KEY);
        }
    } catch (_) {}

    if (_ctxModel === modelKey) return;

    // The app-start pre-warm (allowDownload=false) must NOT silently pull the
    // ~99 MB model over a metered/offline connection. Only fetch it as part of
    // an explicit transcription. The error is typed so the pre-warm catch can
    // swallow it; the model gets downloaded from Settings (with progress UI).
    if (!allowDownload && !(await isSherpaModelDownloaded(modelKey))) {
        const err = new Error('Model not downloaded');
        err.code = 'MODEL_NOT_DOWNLOADED';
        throw err;
    }

    // Release old engine if switching models
    if (_ctxModel) {
        try { await ASR.release(); } catch (_) {}
        _ctxModel = null;
    }

    log('SYSTEM', 'Loading STT model', { modelKey });
    const folderPath = await ensureSherpaModel(modelKey);
    const model = SHERPA_MODELS[modelKey];

    // numThreads omitted on purpose: native defaults to clamp(cores/2, 2, 6),
    // which beats a hardcoded 4 on both budget and flagship CPUs.
    const result = await ASR.initialize({
        modelDir: folderPath,
        modelType: model.modelType,
        modelFiles: model.modelFiles,
        debug: false,
    });

    if (!result.success) {
        throw new Error(result.error || 'Failed to initialize STT');
    }

    _ctxModel = modelKey;
    log('SYSTEM', 'STT model loaded', { modelKey });
};

const _getCtx = (allowDownload = true) => {
    if (!_ctxPromise) _ctxPromise = _initCtx(allowDownload).finally(() => { _ctxPromise = null; });
    return _ctxPromise;
};

const _abandonCtx = () => {
    log('SYSTEM', 'Destroying STT context');
    _ctxModel = null;
    ASR.release().catch(() => {});
};

// Pre-warm on app focus — never auto-downloads the model (that would pull
// ~99 MB silently at launch, e.g. for v1 upgraders whose stored Moonshine key
// is retired). Cold-start cost is only paid when the model is already present.
export const initializeWhisper = () => _getCtx(false).catch(() => {});

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
const dedupeHallucinations = (segments, wordLevel = false) => {
    if (segments.length === 0) return segments;

    // Word-level input (whisper token timestamps) is the DEFAULT model's primary
    // path: per-word segments have ~200-500ms durations, so the old median-based
    // skip turned this filter into a permanent no-op exactly where the loops
    // occur. Run a word-safe cleaner instead of skipping.
    if (wordLevel) return dedupeWordLevel(segments);

    // Sentence/window-level input: the n-gram + sub-80ms heuristics are safe
    // here (sentence segments don't have the legitimate adjacent-word repeats
    // that motivated the skip).
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

/** Conservative word-safe loop remover for per-word (token timestamp) segments.
 *  English effectively never repeats one word 4+ times in a row, so >=4-run
 *  collapses kill 'thank thank thank thank...' loops while preserving legitimate
 *  'had had' / 'that that'. Multi-word phrase loops ('thank you ' x N) are caught
 *  by the n-gram detector once a third repetition appears. */
const dedupeWordLevel = (segments) => {
    const norm = (t) => (t || '').trim().toLowerCase();
    const result = [];
    let i = 0;
    while (i < segments.length) {
        const seg = segments[i];
        const t = norm(seg.text);

        // (a) Collapse a run of >= 4 consecutive identical words to nothing.
        let runLen = 1;
        while (i + runLen < segments.length && norm(segments[i + runLen].text) === t) runLen++;
        if (runLen >= 4) { i += runLen; continue; }

        // (b) Sub-80ms collapsed-tail duplicate of any of the last 12 words.
        if ((seg.end - seg.start) < 80 && result.length > 0) {
            const recent = result.slice(-12);
            if (recent.some(r => norm(r.text) === t)) { i++; continue; }
        }

        // (c) N-gram phrase cycle (N=2..6): drop the candidate only when the last
        //     N accepted match the next N AND were themselves a repeat (>= third
        //     repetition), so a single legitimate adjacent phrase repeat survives.
        let dropped = 0;
        for (let n = 2; n <= 6; n++) {
            if (result.length < 2 * n || i + n > segments.length) break;
            let matchNext = true, matchPrev = true;
            for (let j = 0; j < n; j++) {
                if (norm(result[result.length - n + j].text) !== norm(segments[i + j].text)) { matchNext = false; break; }
            }
            if (!matchNext) continue;
            for (let j = 0; j < n; j++) {
                if (norm(result[result.length - 2 * n + j].text) !== norm(result[result.length - n + j].text)) { matchPrev = false; break; }
            }
            if (matchNext && matchPrev) dropped = n;
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
let _lastProgressAt   = 0;  // last window event time — drives the stall watchdog

// No single window decode should take this long; no window for this long means
// a genuinely hung/dead job (not merely a slow/long/backgrounded healthy one).
const STALL_LIMIT_MS = 10 * 60 * 1000;

const _listeners = new Set();
// Per-listener try/catch: a throwing onQueueChange subscriber must not abort the
// notify loop (or, when called inside cleanup, skip the rest of the cleanup).
const _notify    = () => { [..._listeners].forEach(fn => { try { fn(); } catch (_) {} }); };

export const onQueueChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };
export const getActiveId   = () => _activeId;
export const getAbortingId = () => (_abort?.current ? _activeId : null);
export const getQueueIds   = () => _queue.map(e => e.id);

// ─── Streaming progress ──────────────────────────────────────────────────────

const _progressListeners = new Set();

/** Subscribe to partial transcript progress: cb({ episodeId, percent, partial: true }). */
export const onTranscriptProgress = (fn) => {
    _progressListeners.add(fn);
    return () => _progressListeners.delete(fn);
};

const _emitProgress = (episodeId, percent) => {
    const payload = { episodeId, percent, partial: true };
    [..._progressListeners].forEach(fn => { try { fn(payload); } catch (_) {} });
    try { notifyLibraryChange({ type: 'transcript-progress', episodeId, percent }); } catch (_) {}
};

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

/** Convert one native window's payload into player segments (sentence-level
 *  when only window text exists, word-level when token timestamps exist). */
const _windowToSegments = (ev) => {
    let segs;
    let wordLevel = false;
    if (ev.segments && ev.segments.length > 0) {
        // Native ev.segments come from per-word token timestamps.
        wordLevel = true;
        segs = ev.segments.map(s => ({
            start: Math.round(s.startMs),
            end:   Math.round(s.endMs),
            text:  (s.text || '').trim(),
        }));
    } else {
        const winStart = Math.round(ev.startMs);
        const winDur   = Math.max(0, Math.round(ev.endMs - ev.startMs));
        segs = textToSegments(ev.text, winDur).map(s => ({
            start: winStart + s.start,
            end:   winStart + s.end,
            text:  s.text,
        }));
    }
    return dedupeHallucinations(segs.filter(s => s.text.length > 0), wordLevel);
};

/** Overall episode progress for one window event, clamped to 1..99 (100 is
 *  reserved for completion). endMs is absolute, so resumed jobs report true
 *  episode progress, not progress-of-remainder. */
const _windowPercent = (ev, durationMs, resumeMs = 0) => {
    let pct = 0;
    if (durationMs > 0) {
        pct = (ev.endMs / durationMs) * 100;            // absolute — correct on resume
    } else if (ev.endMs > 0 && ev.totalWindows > 0) {
        // Unknown duration: ev.endMs is absolute, but totalWindows covers only
        // the remaining audio after resumeMs. Estimate the full length so a
        // resumed job doesn't visibly jump backward to ~1% and climb again.
        const estTotalMs = resumeMs + ev.totalWindows * WINDOW_MS;
        pct = estTotalMs > 0 ? (ev.endMs / estTotalMs) * 100 : 0;
    } else if (ev.totalWindows > 0) {
        pct = (ev.windowIndex / ev.totalWindows) * 100; // last-resort
    }
    return Math.max(1, Math.min(99, Math.round(pct)));
};

const _process = async (entry) => {
    _activeId    = entry.id;
    _activeEntry = entry;
    _processStartedAt = Date.now();
    _lastProgressAt = Date.now();
    // Capture the abort token created by _runNext for THIS invocation. A wedged
    // older _process (frozen native promise + frozen timer that fires late) must
    // not act on the module-level _abort/_activeEntry once a newer job owns them.
    const myAbort = _abort;
    _notify();
    await _ensureNotificationPermission();
    _startFg('Transcribing podcasts', 'Preparing…', entry.durationSec || 0);
    // A throwing onStart callback (UI setState etc.) must not bypass the try
    // block and wedge the queue with _running stuck true.
    if (entry.onStart) { try { entry.onStart(); } catch (_) {} }

    const jobId     = `${entry.id}:${Date.now()}`;
    const markerKey = `${JOB_MARKER_PREFIX}${entry.id}`;
    let timeoutTimer = null;
    let windowSub    = null;

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

        await _getCtx();
        if (_abort?.current) throw new Error('Cancelled');

        // Resume only when the native side supports a start offset AND the
        // previous attempt's marker proves the partial rows came from the
        // same model; otherwise wipe the partial rows and start at 0.
        const hasOptionsApi = !!(SherpaNative && typeof SherpaNative.recognizeFromFileWithOptions === 'function');
        let resumeMs = 0;
        if (hasOptionsApi) {
            try {
                const rawMarker = await AsyncStorage.getItem(markerKey);
                const marker = rawMarker ? JSON.parse(rawMarker) : null;
                if (marker?.modelKey === _ctxModel) {
                    resumeMs = Math.max(0, Math.round(await getTranscriptLastEndMs(entry.id)));
                }
            } catch (_) { resumeMs = 0; }
        }
        if (resumeMs > 0) {
            log('SERVICE', 'Resuming from partial transcript', { id: entry.id, resumeMs });
        } else {
            // Clear any partial transcript from a previous incompatible attempt
            await deleteEpisodeTranscript(entry.id);
        }
        await AsyncStorage.setItem(markerKey, JSON.stringify({ modelKey: _ctxModel })).catch(() => {});

        const nativePath = entry.audioFilePath.replace('file://', '');
        const durationMs = (entry.durationSec || 0) * 1000;

        _startFg('Transcribing podcasts', 'Processing audio\u2026', entry.durationSec || 0);

        // Per-window streaming: native emits one event per ~29s decoded window.
        // Saves are serialized through a promise chain so windows commit in
        // order; stale events (other jobs, post-abort) are dropped by jobId.
        let windowsReceived = 0;
        let lastNotifAt = Date.now();
        let saveChain = Promise.resolve();
        const collected = [];

        windowSub = DeviceEventEmitter.addListener(WINDOW_EVENT, (ev) => {
            if (!ev || ev.jobId !== jobId || myAbort.current) return;
            windowsReceived += 1;
            _lastProgressAt = Date.now();
            const segs = _windowToSegments(ev);
            saveChain = saveChain.then(async () => {
                if (myAbort.current || segs.length === 0) return;
                await saveTranscriptsIncremental(entry.id, segs);
                collected.push(...segs);
            }).catch((err) => {
                log('SERVICE', 'Incremental save failed', { id: entry.id, error: err?.message || String(err) });
            });

            const percent = _windowPercent(ev, durationMs, resumeMs);
            if (entry.onProgress) { try { entry.onProgress(percent); } catch (_) {} }
            _emitProgress(entry.id, percent);

            // Throttled notification update; every start() also re-acquires the
            // wake lock, extending the CPU budget for the rest of the job.
            const now = Date.now();
            if (now - lastNotifAt >= NOTIF_THROTTLE_MS) {
                lastNotifAt = now;
                _startFg('Transcribing podcasts', `Transcribing\u2026 ${percent}%`, entry.durationSec || 0);
            }
        });

        // @siteed/sherpa-onnx.rn handles MP3/M4A/OGG decoding natively on Android
        log('SERVICE', 'recognizeFromFile started', { id: entry.id, jobId, resumeMs, streaming: hasOptionsApi });

        // Stall watchdog (not a total-elapsed deadline): a healthy long job on a
        // slow device keeps emitting window events every ~29s, so killing it on
        // total elapsed time falsely fails near-complete long episodes. Cancel
        // only when NO window has arrived for STALL_LIMIT_MS — a truly hung job.
        // (The non-streaming short-file fallback emits no windows, but completes
        // well within the limit.) Guard with myAbort so a stale process's late
        // interval tick can't kill a successor job's native decode.
        const timeout = new Promise((_, reject) => {
            timeoutTimer = setInterval(() => {
                if (Date.now() - _lastProgressAt > STALL_LIMIT_MS) {
                    if (_abort === myAbort) _cancelNative();
                    clearInterval(timeoutTimer);
                    timeoutTimer = null;
                    reject(new Error('Transcription stalled'));
                }
            }, 30 * 1000);
        });

        // Abort guard — dequeueTranscription resolves this
        const abortGuard = new Promise(resolve => {
            myAbort.resolve = resolve;
        });

        const recognize = hasOptionsApi
            ? SherpaNative.recognizeFromFileWithOptions(nativePath, { startMs: resumeMs, jobId, emitWindowEvents: true })
            : ASR.recognizeFromFile(nativePath);

        // Attach a no-op rejection handler to the losing recognize promise: when
        // abortGuard/timeout wins the race, a later native rejection would
        // otherwise surface as an unhandled promise rejection.
        recognize.catch?.(() => {});

        let result;
        try {
            result = await Promise.race([recognize, abortGuard, timeout]);
        } finally {
            myAbort.resolve = null;
            if (timeoutTimer) clearInterval(timeoutTimer);
        }

        if (myAbort.current || result?.cancelled) throw new Error('Cancelled');

        if (!result?.success) {
            throw new Error(result?.error || 'Transcription returned no result');
        }

        // Stop listening, then drain pending window saves before finalizing.
        windowSub.remove();
        windowSub = null;
        await saveChain;

        let segments;
        if (windowsReceived > 0) {
            // Streaming path: everything was already persisted per window.
            segments = collected;
        } else if (result.segments && result.segments.length > 0) {
            // Non-streaming fallback (short files / no window events). One
            // segment per fixed-length recognition window is too coarse for
            // sync — subdivide into sentence-level sub-segments, distributing
            // time proportionally by character count.
            segments = dedupeHallucinations(result.segments.flatMap(seg => {
                const winStart = Math.round(seg.startMs);
                const winDur   = Math.max(0, Math.round(seg.endMs - seg.startMs));
                return textToSegments(seg.text, winDur).map(s => ({
                    start: winStart + s.start,
                    end:   winStart + s.end,
                    text:  s.text,
                }));
            }).filter(s => s.text.length > 0));
            await saveTranscriptsIncremental(entry.id, segments);
        } else if (resumeMs === 0) {
            // Text-only fallback smears timestamps across the full duration —
            // only valid when this job covered the whole episode (no resume).
            // Derive a real effective duration: prefer the native processedEndMs,
            // then the decoded sample length (samplesLength/sampleRate), then the
            // feed duration. If it's still 0, every sentence would get start=end=0
            // and INSERT OR IGNORE against UNIQUE(episode_id,start,end) would drop
            // all but the first — so synthesize strictly increasing timestamps.
            const nativeDurMs = (result.samplesLength && result.sampleRate)
                ? Math.round((result.samplesLength / result.sampleRate) * 1000)
                : 0;
            const effDurMs = result.processedEndMs || result.durationMs || nativeDurMs || durationMs || 0;
            let segs = textToSegments(result.text, effDurMs);
            if (effDurMs <= 0 && segs.length > 1) {
                segs = segs.map((s, i) => ({ start: i * 1000, end: i * 1000 + 999, text: s.text }));
            }
            segments = dedupeHallucinations(segs);
            await saveTranscriptsIncremental(entry.id, segments);
        } else {
            segments = [];
        }

        await finalizeTranscript(entry.id);
        await AsyncStorage.removeItem(markerKey).catch(() => {});

        if (entry.onProgress) { try { entry.onProgress(100); } catch (_) {} }
        try { notifyLibraryChange({ type: 'transcript-complete', episodeId: entry.id }); } catch (_) {}
        _startFg('Transcribing podcasts', 'Complete!', 0);

        log('SERVICE', 'Transcription completed', { id: entry.id, windows: windowsReceived, segments: segments.length });
        entry.resolve(segments);

    } catch (e) {
        const msg = e?.message || String(e);
        log('SERVICE', 'Transcription failed', { id: entry.id, error: msg });
        // Marker stays on purpose: saved partial rows + marker let the next
        // attempt resume instead of restarting from zero.
        // Only tear down the engine if we still own the active slot — a wedged
        // older process must not release the engine the live job is using.
        if (_abort === myAbort) _abandonCtx();
        try { notifyLibraryChange({ type: 'transcript-error', episodeId: entry.id }); } catch (_) {}
        entry.reject(e);
    } finally {
        if (windowSub) windowSub.remove();
        if (timeoutTimer) clearInterval(timeoutTimer);
        // Only reset shared active-job state if we still own it — a stale process
        // must not clobber a successor job's persistence/stale-detection state.
        if (_abort === myAbort) {
            _activeEntry = null;
            _processStartedAt = 0;
            _activeTimeoutMs = DEFAULT_TIMEOUT_MS;
        }
    }
};

// ─── Queue runner ────────────────────────────────────────────────────────────

const _runNext = async () => {
    if (_running || _queue.length === 0) return;
    _running = true;
    _abort = { current: false, resolve: null };

    const entry = _queue.shift();
    log('SERVICE', 'Processing next', { id: entry.id, remaining: _queue.map(e => e.id) });

    // try/finally: _process settles entry's own promise (resolve/reject) in its
    // own catch, so this guarantees queue-state cleanup ALWAYS runs even if
    // _process throws for any reason — otherwise _running stays true forever and
    // the whole queue wedges.
    try {
        await _process(entry);
    } finally {
        _activeId = null;
        _running  = false;
        _abort    = null;
        _processStartedAt = 0;
        _persistQueue();
        _notify(); // per-listener safe

        if (_queue.length === 0) {
            _stopFg();
            log('SERVICE', 'Queue empty');
        } else {
            setTimeout(_runNext, 0);
        }
    }
};

// ─── App lifecycle ───────────────────────────────────────────────────────────

AppState.addEventListener('change', (state) => {
    log('SYSTEM', 'AppState', { state, running: _running, activeId: _activeId, queueLen: _queue.length });

    if (state === 'active') {
        // Reap only a genuinely hung/dead job: base the staleness check on time
        // since the LAST window event (_lastProgressAt), not total elapsed time.
        // A healthy long job (or one backgrounded for a while) keeps emitting
        // windows, so total-elapsed would falsely kill it on resume. JS timers
        // freeze in background, so this wall-clock check is the real backstop
        // for a process the OS killed while _running stayed true.
        if (_running && _lastProgressAt > 0) {
            const sinceProgress = Date.now() - _lastProgressAt;
            if (sinceProgress > STALL_LIMIT_MS + 60000) {
                log('SYSTEM', 'Stale _running detected, force-resetting', { sinceProgress, activeId: _activeId });
                _cancelNative();
                _abandonCtx();
                _activeId = null;
                _activeEntry = null;
                _running = false;
                _abort = null;
                _processStartedAt = 0;
                _lastProgressAt = 0;
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

    // Abort active transcription: stop the native decoder (takes effect at
    // the next window boundary) and resolve the JS abort guard as backstop.
    if (_activeId === id && _abort) {
        _abort.current = true;
        _cancelNative();
        if (_abort.resolve) { _abort.resolve(); _abort.resolve = null; }
        _notify();
    }
};

export const resetService = async () => {
    log('SERVICE', 'Reset', { activeId: _activeId, queue: _queue.map(e => e.id), running: _running });

    if (_abort) {
        _abort.current = true;
        _cancelNative();
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
    _lastProgressAt   = 0;
    _activeTimeoutMs  = DEFAULT_TIMEOUT_MS;

    _stopFg();
    _notify();
};

/** Re-enqueue persisted queue items whose episodes are still downloaded and
 *  still lack a transcript, then auto-start. Items whose episodes were
 *  deleted or already finished are dropped. */
export const restoreQueue = async () => {
    log('SYSTEM', 'restoreQueue');
    _running = false; _activeId = null; _activeEntry = null;
    _abort = null; _queue.length = 0; _processStartedAt = 0; _lastProgressAt = 0;

    let items = [];
    try {
        const raw = await AsyncStorage.getItem(QUEUE_KEY);
        if (raw) items = JSON.parse(raw) || [];
    } catch (_) { items = []; }
    await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
    if (items.length === 0) return;

    let restored = 0;
    for (const item of items) {
        if (!item?.id) continue;
        try {
            const ep = await getEpisodeById(item.id);
            if (!ep || !ep.is_downloaded || !ep.local_audio_path || ep.has_transcript) continue;
            // Fire-and-forget: the returned promise resolves only when the
            // transcription finishes; completion is broadcast via libraryEvents.
            enqueueTranscription(item.id, ep.local_audio_path, null, null, ep.duration || 0)
                .catch(() => {});
            restored += 1;
        } catch (_) {}
    }
    log('SYSTEM', 'restoreQueue re-enqueued', { restored, persisted: items.length });
};
