import { File, Paths } from 'expo-file-system';

/**
 * Downloads a file to the device's local filesystem
 * @param {string} url - The URL of the file to download
 * @param {string} filename - Desired local file name (e.g., episode-123.mp3)
 * @param {function} onProgress - Progress callback function
 * @returns {Promise<string>} - The local path where the file was saved
 */
export const downloadAudioFile = async (url, filename, onProgress) => {
    const destinationFile = new File(Paths.document, filename);

    if (destinationFile.exists) {
        return destinationFile.uri;
    }

    try {
        const downloadedFile = await File.downloadFileAsync(url, destinationFile);
        return downloadedFile.uri;
    } catch (error) {
        console.error('Error downloading audio file:', error);
        throw error;
    }
};

/**
 * Ensures the whisper model is available locally, downloading it if necessary
 */
export const ensureWhisperModel = async (modelType = 'tiny') => {
    const modelFileName = `ggml-${modelType}.bin`;
    const modelFile = new File(Paths.document, modelFileName);

    if (modelFile.exists) return modelFile.uri;

    // Model URL pointing to Hugging Face repository
    const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName}`;

    console.log(`Downloading Whisper Model: ${modelType}...`);
    return await downloadAudioFile(modelUrl, modelFileName, (progress) => {
        console.log(`Model Download Progress: ${progress.toFixed(2)}%`);
    });
};

export const deleteAudioFile = async (localUri) => {
    if (!localUri) return;
    try {
        const filename = localUri.split('/').pop();
        const file = new File(Paths.document, filename);
        if (file.exists) {
            file.delete();
        }
    } catch (e) {
        console.error('Failed to delete file', e);
    }
};
