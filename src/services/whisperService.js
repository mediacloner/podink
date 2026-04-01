import { initWhisper } from 'whisper.rn';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureWhisperModel } from './downloadService';

let whisperContext = null;
let loadedModelType = null;

export const initializeWhisper = async () => {
    console.log("=> initializeWhisper triggered");

    // Load preferred model from settings, default to 'base'
    let modelType = 'base';
    try {
        const saved = await AsyncStorage.getItem('@whisper_model');
        if (saved) modelType = saved;
    } catch (e) {
        console.error('Failed to load preferred model', e);
    }

    // Return cached context only if it matches the currently selected model
    if (whisperContext && loadedModelType === modelType) {
        console.log("Context already exists for model, returning cached context");
        return whisperContext;
    }

    // Model changed — release old context before reinitializing
    if (whisperContext && loadedModelType !== modelType) {
        console.log(`Model changed from ${loadedModelType} to ${modelType}, reinitializing`);
        try { await whisperContext.release(); } catch (_) {}
        whisperContext = null;
        loadedModelType = null;
    }

    // Download or find the model locally
    console.log(`Ensuring model exists: ${modelType}`);
    const modelFilePath = await ensureWhisperModel(modelType);
    console.log(`Model file path resolved: ${modelFilePath}`);

    // Initialize whisper context (0.5.5 API)
    console.log(`Initializing whisper context...`);
    whisperContext = await initWhisper({
        filePath: modelFilePath.replace('file://', ''),
    });
    loadedModelType = modelType;
    console.log(`Whisper context successfully initialized`);

    return whisperContext;
};

export const transcribeAudio = async (audioFilePath, onProgress) => {
    console.log(`=> transcribeAudio triggered with file: ${audioFilePath}`);
    const context = await initializeWhisper();

    const nativePath = audioFilePath.replace('file://', '');
    console.log("=> Step 2: Starting Transcription natively on path: " + nativePath);

    // Progress normalization state.
    // The native layer fires two mixed signals into the same callback:
    //   1. Whisper C++ internal progress: 0→100% per chunk (fires many times per chunk)
    //   2. Java chunk-completion milestone: 20%, 40%… once after each chunk finishes
    // We detect the milestone by the drop from ≥95 to a positive non-zero value,
    // then compute a smooth linear 0→100% across the whole file.
    let completedChunks = 0;
    let totalChunks = 5; // reasonable default until first milestone reveals the real count
    let lastRaw = -1;

    const normalizeProgress = (p) => {
        // Ignore audio-decoding phase (native emits negative values during convertToDiskWav)
        if (p < 0) return null;

        // Detect Java milestone: fires after C++ reaches ~100%, drops to chunk-fraction value
        if (lastRaw >= 95 && p > 0 && p < lastRaw) {
            totalChunks = Math.round(100 / p);
            completedChunks = Math.round((p / 100) * totalChunks);
            lastRaw = p;
            return null; // milestone handled — don't emit raw value
        }

        lastRaw = p;

        // Smooth overall: completed portion + current chunk's contribution
        return Math.min(99, Math.round(
            (completedChunks / totalChunks) * 100 + (p / totalChunks)
        ));
    };

    try {
        const { promise } = context.transcribe(nativePath, {
            language: 'en',
            // No maxLen: Whisper outputs natural sentence-level segments (~200 for 1h)
            // instead of one segment per token (~8000). Word timing is interpolated
            // in TranscriptHighlighter so tokenTimestamps is not needed.
            onProgress: (p) => {
                const smooth = normalizeProgress(p);
                if (smooth !== null) {
                    console.log(`Transcription progress: ${smooth}%`);
                    if (onProgress) onProgress(smooth);
                }
            }
        });
        
        const transcriptionResult = await promise;
        console.log("Transcription Complete!");
        
        return (transcriptionResult.segments || []).map((seg) => ({
            start: seg.t0 * 10,
            end:   seg.t1 * 10,
            text:  seg.text,
        }));
    } catch (e) {
        console.error("Transcription execution failed:", e);
        throw e;
    }
};
