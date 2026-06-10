import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';

// ─── Sherpa-ONNX model registry ──────────────────────────────────────────────

export const SHERPA_MODELS = {
    moonshine_tiny: {
        label: 'Moonshine Tiny',
        desc: 'English only, fastest, lightest',
        folder: 'sherpa-moonshine-tiny-int8',
        modelType: 'moonshine',
        modelFiles: {
            preprocessor: 'preprocess.onnx',
            encoder: 'encode.int8.onnx',
            uncachedDecoder: 'uncached_decode.int8.onnx',
            cachedDecoder: 'cached_decode.int8.onnx',
        },
        files: [
            'preprocess.onnx',
            'encode.int8.onnx',
            'uncached_decode.int8.onnx',
            'cached_decode.int8.onnx',
            'tokens.txt',
        ],
        baseUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/',
        totalSizeMB: 30,
    },
    moonshine_base: {
        label: 'Moonshine Base',
        desc: 'English only, best accuracy',
        folder: 'sherpa-moonshine-base-int8',
        modelType: 'moonshine',
        modelFiles: {
            preprocessor: 'preprocess.onnx',
            encoder: 'encode.int8.onnx',
            uncachedDecoder: 'uncached_decode.int8.onnx',
            cachedDecoder: 'cached_decode.int8.onnx',
        },
        files: [
            'preprocess.onnx',
            'encode.int8.onnx',
            'uncached_decode.int8.onnx',
            'cached_decode.int8.onnx',
            'tokens.txt',
        ],
        baseUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/main/',
        totalSizeMB: 60,
        recommended: true,
    },
    sensevoice_small: {
        label: 'SenseVoice Small',
        desc: '50+ languages, fastest option',
        folder: 'sherpa-sensevoice-small-int8',
        modelType: 'sense_voice',
        modelFiles: {
            model: 'model.int8.onnx',
        },
        files: [
            'model.int8.onnx',
            'tokens.txt',
        ],
        baseUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/',
        totalSizeMB: 229,
    },
    whisper_tiny_en: {
        // The standard csukuangfj/sherpa-onnx-whisper-* exports lack cross-attention
        // outputs, which sherpa-onnx needs for token-level (per-word) timestamps via
        // dynamic-time-warping alignment (see sherpa-onnx PR #2945). This repo was
        // exported with `export-onnx-with-attention.py` and DOES expose attention
        // weights, enabling real word-level sync.
        // Note: this is the multilingual Whisper Tiny, not tiny.en — slightly worse
        // English WER than .en variants, but the only attention-enabled tiny model
        // currently published. We force language="en" + task="transcribe" anyway.
        label: 'Whisper Tiny',
        desc: 'English, real per-word timestamps',
        folder: 'sherpa-whisper-tiny-attention-int8',
        modelType: 'whisper',
        modelFiles: {
            encoder: 'tiny-encoder.int8.onnx',
            decoder: 'tiny-decoder.int8.onnx',
            tokens:  'tiny-tokens.txt',
        },
        files: [
            'tiny-encoder.int8.onnx',
            'tiny-decoder.int8.onnx',
            'tiny-tokens.txt',
        ],
        baseUrl: 'https://huggingface.co/clairemcw/sherpa-onnx-whisper-tiny-attention/resolve/main/',
        totalSizeMB: 99,
    },
};

// ─── Audio file helpers ──────────────────────────────────────────────────────

/**
 * Downloads a file to the device's local filesystem
 */
export const downloadAudioFile = async (url, filename, onProgress) => {
    const destinationFile = new File(Paths.document, filename);

    if (destinationFile.exists) {
        return destinationFile.uri;
    }

    try {
        const download = FileSystem.createDownloadResumable(
            url,
            destinationFile.uri,
            {},
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                if (onProgress && totalBytesExpectedToWrite > 0) {
                    onProgress((totalBytesWritten / totalBytesExpectedToWrite) * 100);
                }
            }
        );
        const result = await download.downloadAsync();
        return result.uri;
    } catch (error) {
        console.error('Error downloading audio file:', error);
        throw error;
    }
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

// ─── Sherpa-ONNX model management ────────────────────────────────────────────

const _modelDir = (modelKey) => `${FileSystem.documentDirectory}${SHERPA_MODELS[modelKey].folder}`;

/** Check if all model files exist locally. */
export const isSherpaModelDownloaded = async (modelKey) => {
    const model = SHERPA_MODELS[modelKey];
    if (!model) return false;
    const dir = _modelDir(modelKey);
    for (const file of model.files) {
        const info = await FileSystem.getInfoAsync(`${dir}/${file}`);
        if (!info.exists) return false;
    }
    return true;
};

/** Returns the native folder path (no file:// prefix) for model init. */
export const getSherpaModelPath = (modelKey) => {
    return _modelDir(modelKey).replace('file://', '');
};

/**
 * Download all model files for a given model key.
 * @param {string} modelKey - Key from SHERPA_MODELS
 * @param {function} onProgress - Progress callback (0-100)
 * @returns {Promise<string>} Native folder path
 */
export const ensureSherpaModel = async (modelKey, onProgress) => {
    const model = SHERPA_MODELS[modelKey];
    if (!model) throw new Error(`Unknown model: ${modelKey}`);

    const dir = _modelDir(modelKey);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});

    let completedFiles = 0;
    for (const file of model.files) {
        const dest = `${dir}/${file}`;
        const info = await FileSystem.getInfoAsync(dest);
        if (info.exists) {
            completedFiles++;
            if (onProgress) onProgress(Math.round((completedFiles / model.files.length) * 100));
            continue;
        }

        const url = `${model.baseUrl}${file}`;
        const download = FileSystem.createDownloadResumable(
            url,
            dest,
            {},
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                if (onProgress && totalBytesExpectedToWrite > 0) {
                    const fileProgress = totalBytesWritten / totalBytesExpectedToWrite;
                    const overall = (completedFiles + fileProgress) / model.files.length * 100;
                    onProgress(Math.round(overall));
                }
            }
        );
        await download.downloadAsync();
        completedFiles++;
    }

    if (onProgress) onProgress(100);
    return getSherpaModelPath(modelKey);
};

/** Delete all files for a model. */
export const deleteSherpaModel = async (modelKey) => {
    const dir = _modelDir(modelKey);
    try {
        await FileSystem.deleteAsync(dir, { idempotent: true });
    } catch (e) {
        console.error('Failed to delete model', e);
    }
};

/** Remove old whisper ggml-*.bin model files and superseded sherpa folders. */
export const cleanupOldWhisperModels = async () => {
    const docDir = FileSystem.documentDirectory;
    try {
        const files = await FileSystem.readDirectoryAsync(docDir);
        for (const file of files) {
            if (file.startsWith('ggml-') && file.endsWith('.bin')) {
                await FileSystem.deleteAsync(`${docDir}${file}`, { idempotent: true });
            }
        }
        // The original whisper_tiny_en pointed at the no-attention csukuangfj export
        // (~99 MB, no token timestamps). Its folder is now orphaned — drop it so we
        // don't keep dead files around.
        await FileSystem.deleteAsync(`${docDir}sherpa-whisper-tiny-en-int8`, { idempotent: true });
    } catch (_) {}
};
