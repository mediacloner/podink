import { initWhisper } from 'whisper.rn';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureWhisperModel } from './downloadService';

let whisperContext = null;

export const initializeWhisper = async () => {
    console.log("=> initializeWhisper triggered");
    // Check if context is already initialized
    if (whisperContext) {
        console.log("Context already exists, returning cached context");
        return whisperContext;
    }

    // Load preferred model from settings, default to 'base'
    let modelType = 'base';
    try {
        const saved = await AsyncStorage.getItem('@whisper_model');
        if (saved) modelType = saved;
    } catch (e) {
        console.error('Failed to load preferred model', e);
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
    console.log(`Whisper context successfully initialized`);
    
    return whisperContext;
};

export const transcribeAudio = async (audioFilePath, onProgress) => {
    console.log(`=> transcribeAudio triggered with file: ${audioFilePath}`);
    const context = await initializeWhisper();

    // Native code uses FileInputStream which requires raw file paths (no file:// scheme)
    const nativePath = audioFilePath.replace('file://', '');
    console.log("=> Step 2: Starting Transcription natively on path: " + nativePath);
    
    try {
        const { promise } = context.transcribe(nativePath, {
            language: 'en',
            maxLen: 1,
            tokenTimestamps: true,
            onProgress: (p) => {
                console.log(`Whisper Native Progress: ${p}%`);
                if (onProgress) onProgress(p);
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
