/** Optional, explicit OpenRouter comparison for downloaded podcast audio.
 * The on-device transcription queue and canonical transcript never use this. */
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { recordApiSpend, saveMaiTranscript } from '../database/queries';
import { notifyLibraryChange } from './libraryEvents';

export const OPENROUTER_KEY = '@openrouter_transcription_key';
export const MAI_MODEL = 'microsoft/mai-transcribe-2';
const ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
const active = new Map();

export const estimateMaiCost = (durationSec) => Math.max(0, Number(durationSec) || 0) / 3600 * 0.10;
export const isMaiTesting = (episodeId) => active.has(episodeId);
export const cancelMaiTest = (episodeId) => active.get(episodeId)?.abort();

const toRows = (data, offsetMs, chunkEndMs) => {
    const words = Array.isArray(data?.words) ? data.words : [];
    const rows = [];
    if (words.length) {
        let group = [];
        const flush = () => {
            if (!group.length) return;
            const text = group.map(w => String(w.word || '').trim()).filter(Boolean).join(' ').trim();
            const start = offsetMs + Math.round(Number(group[0].start) * 1000);
            const end = offsetMs + Math.round(Number(group[group.length - 1].end) * 1000);
            if (text && Number.isFinite(start) && Number.isFinite(end)) rows.push({ start, end: Math.max(start + 1, end), text });
            group = [];
        };
        for (const word of words) {
            if (!String(word?.word || '').trim() || !Number.isFinite(Number(word.start)) || !Number.isFinite(Number(word.end))) continue;
            group.push(word);
            if (/[.!?…]["'”’)]?$/.test(String(word.word).trim()) || group.length >= 35) flush();
        }
        flush();
    } else if (Array.isArray(data?.segments)) {
        for (const s of data.segments) {
            const text = String(s?.text || '').trim();
            const start = offsetMs + Math.round(Number(s.start) * 1000);
            const end = offsetMs + Math.round(Number(s.end) * 1000);
            if (text && Number.isFinite(start) && Number.isFinite(end)) rows.push({ start, end: Math.max(start + 1, end), text });
        }
    }
    if (!rows.length && String(data?.text || '').trim()) {
        rows.push({ start: offsetMs, end: Math.max(offsetMs + 1, chunkEndMs), text: data.text.trim() });
    }
    return rows;
};

const requestChunk = async (key, chunk, signal) => {
    const encoded = await FileSystem.readAsStringAsync(`file://${chunk.path}`, {
        encoding: FileSystem.EncodingType.Base64,
    });
    if (signal.signal.aborted) throw new Error('MAI test cancelled');
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; signal.abort(); }, 55000);
    let response;
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MAI_MODEL,
                input_audio: { data: encoded, format: chunk.format },
                response_format: 'verbose_json',
                timestamp_granularities: ['word', 'segment'],
            }),
            signal: signal.signal,
        });
    } catch (error) {
        if (timedOut) throw new Error('OpenRouter took too long for this audio chunk');
        if (signal.signal.aborted) throw new Error('MAI test cancelled');
        throw new Error(error?.message || 'Could not reach OpenRouter');
    } finally {
        clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `OpenRouter returned HTTP ${response.status}`);
    return data;
};

/** Saves only when every chunk succeeds. A repeat run replaces the prior MAI
 * result in one DB transaction, so cancelled or failed tests preserve it. */
export const testMaiTranscription = async (episode, onProgress = () => {}) => {
    if (!episode?.local_audio_path) throw new Error('Download this podcast first');
    if (active.has(episode.id)) throw new Error('MAI test already running');
    const key = ((await AsyncStorage.getItem(OPENROUTER_KEY)) || '').trim();
    if (!key) throw new Error('Add your OpenRouter API key in Settings → Cloud transcription test');
    if (!NativeModules.AudioImport?.splitPodcastChunks) throw new Error('Audio splitting is unavailable in this app build');
    const controller = new AbortController();
    active.set(episode.id, controller);
    const tempDir = `${FileSystem.cacheDirectory}mai-${String(episode.id).replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}`;
    try {
        await FileSystem.makeDirectoryAsync(tempDir, { intermediates: true });
        const chunks = await NativeModules.AudioImport.splitPodcastChunks(
            episode.local_audio_path, tempDir, Number(episode.duration || 0) * 1000
        );
        if (controller.signal.aborted) throw new Error('MAI test cancelled');
        const segments = [];
        let costUsd = 0;
        let audioSeconds = 0;
        for (let i = 0; i < chunks.length; i++) {
            if (controller.signal.aborted) throw new Error('MAI test cancelled');
            const data = await requestChunk(key, chunks[i], controller);
            segments.push(...toRows(data, Number(chunks[i].startMs), Number(chunks[i].endMs)));
            costUsd += Number(data?.usage?.cost) || 0;
            audioSeconds += Number(data?.usage?.seconds) || 0;
            onProgress(Math.round((i + 1) / chunks.length * 100));
        }
        if (controller.signal.aborted) throw new Error('MAI test cancelled');
        await saveMaiTranscript(episode.id, segments, { costUsd, audioSeconds });
        // OpenRouter prices this one itself, by the second of audio it heard;
        // the statistics screen shows it beside the token-priced passes.
        await recordApiSpend({
            provider: 'openrouter', service: 'transcription', model: MAI_MODEL,
            episodeId: episode.id, episodeTitle: episode.title, source: episode.podcast_title,
            audioSeconds, cost: costUsd,
        });
        notifyLibraryChange({ type: 'mai-transcript-complete', episodeId: episode.id });
        return { costUsd, segments: segments.length };
    } finally {
        active.delete(episode.id);
        await FileSystem.deleteAsync(tempDir, { idempotent: true }).catch(() => {});
    }
};
