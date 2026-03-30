import { initWhisper } from 'whisper.rn';
import { NativeEventEmitter, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureWhisperModel } from './downloadService';

let whisperContext = null;

export const initializeWhisper = async () => {
    // Check if context is already initialized
    if (whisperContext) return whisperContext;

    // Load preferred model from settings, default to 'base'
    let modelType = 'base';
    try {
        const saved = await AsyncStorage.getItem('@whisper_model');
        if (saved) modelType = saved;
    } catch (e) {
        console.error('Failed to load preferred model', e);
    }

    // Download or find the model locally
    const modelFilePath = await ensureWhisperModel(modelType);

    // Initialize whisper context (0.5.5 API)
    whisperContext = await initWhisper({
        filePath: modelFilePath.replace('file://', ''),
    });
    
    return whisperContext;
};

export const transcribeAudio = async (audioFilePath, onProgress) => {
    const context = await initializeWhisper();

    let subscription;
    if (onProgress) {
        const emitter = new NativeEventEmitter(NativeModules.RNWhisper);
        subscription = emitter.addListener('@RNWhisperTranscribeProgress', ({ progress }) => {
            onProgress(progress);
        });
    }

    const nativePath = audioFilePath.replace('file://', '');
    console.log("Starting Transcription...");
    try {
        const { promise } = context.transcribe(nativePath, {
            language: 'en',
            maxLen: 1,
            tokenTimestamps: true,
        });
        const transcriptionResult = await promise;
        console.log("Transcription Complete!");
        return (transcriptionResult.segments || []).map((seg) => ({
            start: seg.t0 * 10,
            end:   seg.t1 * 10,
            text:  seg.text,
        }));
    } finally {
        subscription?.remove();
    }
};
