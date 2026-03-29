import { whisper } from 'whisper.rn';
import { ensureWhisperModel } from './downloadService';
import { convertToWav } from './ffmpegService';
import RNFS from 'react-native-fs';

let whisperContext = null;

export const initWhisper = async (modelType = 'tiny') => {
    // Check if context is already initialized
    if (whisperContext) return whisperContext;

    // Download or find the model locally
    const modelFilePath = await ensureWhisperModel(modelType);

    // Initialize whisper context with default OS params
    whisperContext = await whisper.initContext({
        filePath: modelFilePath,
    });
    
    return whisperContext;
};

export const transcribeAudio = async (audioFilePath) => {
    const context = await initWhisper();

    // The file needs to be 16kHz WAV. Let's create a temporary file path
    const tempWavPath = `${RNFS.CachesDirectoryPath}/temp_transcribe.wav`;
    
    console.log("Starting FFmpeg Conversion...");
    const conversionResult = await convertToWav(audioFilePath, tempWavPath);

    console.log("Starting Transcription...");
    const transcriptionResult = await whisperContext.transcribe(conversionResult, {
        language: 'en',
        maxLen: 1, // 1 token per segment for accurate timing sync? Let's use default chunk sizes first
        tokenTimestamps: true,
    });

    console.log("Transcription Complete!");
    
    // Attempt to map result segments securely
    const formattedSegments = (transcriptionResult.result || []).map((seg) => ({
        start: seg.t0 * 10, // Assuming Whisper gives 10ms timestamps
        end:   seg.t1 * 10, 
        text:  seg.text
    }));

    // Cleanup the temporary WAV file to save storage
    await RNFS.unlink(tempWavPath);

    return formattedSegments;
};
