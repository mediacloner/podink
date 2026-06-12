import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';

// ─── Sherpa-ONNX model registry ──────────────────────────────────────────────

export const SHERPA_MODELS = {
    sensevoice_small: {
        label: 'SenseVoice Small',
        desc: 'Powerful multilingual model · under evaluation',
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
        desc: 'English · word-by-word highlighting · best for learning',
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
        recommended: true,
    },
};

// ─── Audio file helpers ──────────────────────────────────────────────────────

/**
 * Downloads a file to the device's local filesystem
 */
export const downloadAudioFile = async (url, filename, onProgress) => {
    const destinationFile = new File(Paths.document, filename);

    // Only trust a fully-written final file. (Rename-on-complete below
    // guarantees the final path is never a truncated partial.)
    if (destinationFile.exists && destinationFile.size > 0) {
        return destinationFile.uri;
    }

    // Download to a temp path and rename on completion. An interrupted download
    // (network drop / app kill) then leaves only a .part file — never a
    // final-named truncated file that would be reused forever as "downloaded".
    const tmpFile = new File(Paths.document, `${filename}.part`);
    try { if (tmpFile.exists) tmpFile.delete(); } catch (_) {}

    try {
        const download = FileSystem.createDownloadResumable(
            url,
            tmpFile.uri,
            {},
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                if (onProgress && totalBytesExpectedToWrite > 0) {
                    onProgress((totalBytesWritten / totalBytesExpectedToWrite) * 100);
                }
            }
        );
        await download.downloadAsync();
        // Replace any stale final file, then promote the temp file.
        try { if (destinationFile.exists) destinationFile.delete(); } catch (_) {}
        await FileSystem.moveAsync({ from: tmpFile.uri, to: destinationFile.uri });
        return destinationFile.uri;
    } catch (error) {
        console.error('Error downloading audio file:', error);
        try { if (tmpFile.exists) tmpFile.delete(); } catch (_) {}
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

/** Check if all model files exist locally (and are non-empty — a truncated
 *  file from an interrupted download would otherwise pass and fail at init). */
export const isSherpaModelDownloaded = async (modelKey) => {
    const model = SHERPA_MODELS[modelKey];
    if (!model) return false;
    const dir = _modelDir(modelKey);
    for (const file of model.files) {
        const info = await FileSystem.getInfoAsync(`${dir}/${file}`);
        if (!info.exists || !info.size) return false;
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
        if (info.exists && info.size > 0) {
            completedFiles++;
            if (onProgress) onProgress(Math.round((completedFiles / model.files.length) * 100));
            continue;
        }

        // Download to a temp path and rename on completion so an interrupted /
        // killed download can never leave a truncated file that the exists-check
        // treats as complete (sherpa-onnx fails to load a partial .onnx).
        const tmp = `${dest}.part`;
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
        const url = `${model.baseUrl}${file}`;
        const download = FileSystem.createDownloadResumable(
            url,
            tmp,
            {},
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                if (onProgress && totalBytesExpectedToWrite > 0) {
                    const fileProgress = totalBytesWritten / totalBytesExpectedToWrite;
                    const overall = (completedFiles + fileProgress) / model.files.length * 100;
                    onProgress(Math.round(overall));
                }
            }
        );
        try {
            await download.downloadAsync();
            await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
            await FileSystem.moveAsync({ from: tmp, to: dest });
        } catch (e) {
            await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
            throw e;
        }
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
        // don't keep dead files around. Same for the retired Moonshine models
        // (sentence-level sync only, removed from the lineup).
        await FileSystem.deleteAsync(`${docDir}sherpa-whisper-tiny-en-int8`, { idempotent: true });
        await FileSystem.deleteAsync(`${docDir}sherpa-moonshine-tiny-int8`, { idempotent: true });
        await FileSystem.deleteAsync(`${docDir}sherpa-moonshine-base-int8`, { idempotent: true });
    } catch (_) {}
};
