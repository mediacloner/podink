import { initWhisper } from 'whisper.rn';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureWhisperModel } from './downloadService';
import { saveTranscripts } from '../database/queries';

// ─── Whisper context singleton ────────────────────────────────────────────────

let whisperContext = null;
let loadedModelType = null;
let initializingPromise = null;

const _doInit = async () => {
    let modelType = 'base';
    try {
        const saved = await AsyncStorage.getItem('@whisper_model');
        if (saved) modelType = saved;
    } catch (e) {}

    if (Platform.OS === 'android' && modelType.includes('q8')) {
        modelType = 'base';
    }

    if (whisperContext && loadedModelType === modelType) return whisperContext;

    if (whisperContext && loadedModelType !== modelType) {
        try { await whisperContext.release(); } catch (_) {}
        whisperContext = null;
        loadedModelType = null;
    }

    const modelFilePath = await ensureWhisperModel(modelType);
    whisperContext = await initWhisper({ filePath: modelFilePath.replace('file://', '') });
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
let _processing = false;

// Listeners notified whenever queue state changes (for UI polling-free updates)
const _listeners = new Set();
const _notify = () => _listeners.forEach(fn => fn());

export const onQueueChange = (fn) => {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
};

/** Returns the ID that is currently being transcribed, or null. */
export const getActiveId  = () => _processing && _queue.length > 0 ? null : (_activeId ?? null);

// Track the active id separately so callers can read it synchronously.
let _activeId = null;

export const getQueueIds = () => _queue.map(e => e.id);

const _runNext = async () => {
    if (_processing || _queue.length === 0) return;
    _processing = true;

    const entry = _queue.shift();
    _activeId = entry.id;
    _notify();

    if (entry.onStart) entry.onStart();

    try {
        const context = await initializeWhisper();
        const nativePath = entry.audioFilePath.replace('file://', '');

        let completedChunks = 0;
        let totalChunks = 5;
        let lastRaw = -1;

        const normalizeProgress = (p) => {
            if (p < 0) return null;
            if (lastRaw >= 95 && p > 0 && p < lastRaw) {
                totalChunks = Math.round(100 / p);
                completedChunks = Math.round((p / 100) * totalChunks);
                lastRaw = p;
                return null;
            }
            lastRaw = p;
            return Math.min(99, Math.round((completedChunks / totalChunks) * 100 + (p / totalChunks)));
        };

        const { promise } = context.transcribe(nativePath, {
            language: 'en',
            onProgress: (p) => {
                const smooth = normalizeProgress(p);
                if (smooth !== null && entry.onProgress) entry.onProgress(smooth);
            },
        });

        const result = await promise;
        const segments = (result.segments || []).map(seg => ({
            start: seg.t0 * 10,
            end:   seg.t1 * 10,
            text:  seg.text,
        }));
        await saveTranscripts(entry.id, segments);
        entry.resolve(segments);
    } catch (e) {
        entry.reject(e);
    } finally {
        _processing = false;
        _activeId = null;
        _notify();
        _runNext();
    }
};

/**
 * Enqueue an episode for transcription. Returns a promise that resolves with
 * segments when this episode's turn comes and transcription completes.
 *
 * @param {string} id            - Unique episode ID (used for queue state tracking)
 * @param {string} audioFilePath - Local file path
 * @param {function} onProgress  - Called with 0-99 as transcription progresses
 * @param {function} onStart     - Called when this item starts processing
 */
export const enqueueTranscription = (id, audioFilePath, onProgress, onStart) => {
    // Don't add duplicates
    if (_activeId === id || _queue.some(e => e.id === id)) {
        return Promise.reject(new Error('Already queued'));
    }

    return new Promise((resolve, reject) => {
        _queue.push({ id, audioFilePath, onProgress, onStart, resolve, reject });
        _notify();
        _runNext();
    });
};

/**
 * Remove an episode from the queue (only works if it hasn't started yet).
 */
export const dequeueTranscription = (id) => {
    const idx = _queue.findIndex(e => e.id === id);
    if (idx !== -1) {
        _queue[idx].reject(new Error('Cancelled'));
        _queue.splice(idx, 1);
        _notify();
    }
};

// Legacy export kept for any other callers
export const transcribeAudio = (audioFilePath, onProgress) =>
    enqueueTranscription(audioFilePath, audioFilePath, onProgress, null);
