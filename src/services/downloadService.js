import RNFS from 'react-native-fs';

/**
 * Downloads a file to the device's local filesystem
 * @param {string} url - The URL of the file to download
 * @param {string} filename - Desired local file name (e.g., episode-123.mp3)
 * @param {function} onProgress - Progress callback function
 * @returns {Promise<string>} - The local path where the file was saved
 */
export const downloadAudioFile = async (url, filename, onProgress) => {
    const destinationPath = `${RNFS.DocumentDirectoryPath}/${filename}`;
    
    // Check if the file already exists
    const exists = await RNFS.exists(destinationPath);
    if (exists) {
        return destinationPath;
    }

    try {
        const downloadOptions = {
            fromUrl: url,
            toFile: destinationPath,
            progress: (res) => {
                if (onProgress && res.contentLength > 0) {
                    const percentage = (res.bytesWritten / res.contentLength) * 100;
                    onProgress(percentage);
                }
            },
            progressDivider: 2, // Emit progress update events less frequently
        };

        const result = await RNFS.downloadFile(downloadOptions).promise;
        
        if (result.statusCode === 200) {
            return destinationPath;
        } else {
            throw new Error(`Download failed with status: ${result.statusCode}`);
        }
    } catch (error) {
        console.error('Error downloading audio file:', error);
        throw error;
    }
};

/**
 * Ensures the whisper model is available locally, downloading it if necessary
 */
export const ensureWhisperModel = async (modelType = 'tiny') => {
    // Determine the bin file name based on model
    const modelFileName = `ggml-${modelType}.bin`;
    const modelPath = `${RNFS.DocumentDirectoryPath}/${modelFileName}`;
    
    const exists = await RNFS.exists(modelPath);
    if (exists) return modelPath;

    // Model URL pointing to Hugging Face repository
    const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName}`;
    
    console.log(`Downloading Whisper Model: ${modelType}...`);
    return await downloadAudioFile(modelUrl, modelFileName, (progress) => {
        console.log(`Model Download Progress: ${progress.toFixed(2)}%`);
    });
};

export const deleteAudioFile = async (localPath) => {
    if (!localPath) return;
    try {
        const exists = await RNFS.exists(localPath);
        if (exists) {
            await RNFS.unlink(localPath);
        }
    } catch (e) {
        console.error('Failed to delete file', e);
    }
};
