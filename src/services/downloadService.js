import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import { NativeModules } from 'react-native';
import { USER_AGENT } from '../api/userAgent';

// ─── Sherpa-ONNX model registry ──────────────────────────────────────────────

// Two-tier lineup, both NVIDIA Parakeet (CC BY 4.0), both distributed only as
// GitHub release tarballs from the sherpa-onnx model zoo (hence `archive`; the
// csukuangfj HF int8 repos are empty placeholders).
//   parakeet_110m_en         default / fast — hybrid TDT-CTC 110M, CTC head
//   parakeet_tdt_0_6b_v2_en  high accuracy  — TDT 0.6B v2 transducer
// Whisper Tiny and SenseVoice were retired in 2.1.0 (see cleanupOldWhisperModels).
export const SHERPA_MODELS = {
    parakeet_110m_en: {
        // NVIDIA FastConformer hybrid TDT-CTC 110M (CTC head), official int8
        // export. ~7.5% mean WER on the HF Open ASR leaderboard, native
        // punctuation and capitalization. CTC frame alignments provide the
        // per-token timestamps for word-level sync. CTC decoding is
        // non-autoregressive, so Whisper-style repetition loops on
        // music/silence/ad reads structurally cannot happen.
        label: 'Parakeet 110M',
        desc: 'English · fast · NVIDIA Parakeet (CC BY 4.0)',
        folder: 'sherpa-nemo-parakeet-tdt-ctc-110m-en-int8',
        modelType: 'nemo_ctc',
        modelFiles: {
            model: 'model.int8.onnx',
        },
        files: [
            'model.int8.onnx',
            'tokens.txt',
        ],
        archive: {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2',
            // Tar entries are prefixed with this folder; the needed files are
            // moved up into `folder` after extraction and the rest is dropped.
            rootDir: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8',
        },
        downloadSizeMB: 99,
        totalSizeMB: 126,
        recommended: true,
    },
    parakeet_tdt_0_6b_v2_en: {
        // NVIDIA Parakeet TDT 0.6B v2 (FastConformer encoder + TDT transducer),
        // official int8 export. 6.05% mean WER vs ~7.5% for the 110M: the
        // transducer's prediction net conditions on the text emitted so far
        // (better spelling / casing / punctuation) and TDT duration prediction
        // skips silence, so it is loop-free too. Per-token timestamps come from
        // the TDT greedy decoder (80 ms frames, same as the CTC model).
        // Cost: ~5x the 110M's encoder compute on CPU, ~630 MB on disk,
        // ~1.1 GB peak during install (tarball + extracted tree coexist).
        // Requires modelType 'nemo_transducer' — see the ASRHandler.kt patch.
        label: 'Parakeet 0.6B v2',
        desc: 'English · high accuracy · slower · NVIDIA Parakeet (CC BY 4.0)',
        folder: 'sherpa-nemo-parakeet-tdt-0.6b-v2-int8',
        modelType: 'nemo_transducer',
        modelFiles: {
            encoder: 'encoder.int8.onnx',
            decoder: 'decoder.int8.onnx',
            joiner:  'joiner.int8.onnx',
        },
        files: [
            'encoder.int8.onnx',
            'decoder.int8.onnx',
            'joiner.int8.onnx',
            'tokens.txt',
        ],
        archive: {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
            rootDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
        },
        downloadSizeMB: 460,
        totalSizeMB: 630,
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
            // Same Buzzsprout/Cloudflare constraint as fetchPodcastFeed: the
            // default okhttp UA gets a 403 on the enclosure URL.
            { headers: { 'User-Agent': USER_AGENT } },
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
        // Anything the app wrote under its documents directory — a download
        // at the root, an imported chapter under imports/<id>/ — is deleted
        // at its exact path. Other URIs keep the historical basename lookup.
        const root = Paths.document.uri;
        const file = String(localUri).startsWith(root)
            ? new File(localUri)
            : new File(Paths.document, localUri.split('/').pop());
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

/** Download a tarball-distributed model and extract it in place. Uses the
 *  sherpa-onnx native tar.bz2 extractor (Android). Interruption-safe:
 *  the tarball is downloaded to a .part path and renamed on completion, so a
 *  kill mid-extract leaves a complete tarball and the next attempt re-extracts
 *  without re-downloading. Download is reported as 0-90%, extraction 90-99. */
const _downloadAndExtractArchive = async (model, dir, onProgress) => {
    const extractTarBz2 = NativeModules.SherpaOnnx?.extractTarBz2;
    if (typeof extractTarBz2 !== 'function') {
        throw new Error('Model archive extraction unavailable (SherpaOnnx native module missing)');
    }

    const archivePath = `${dir}/model.tar.bz2`;
    const archiveInfo = await FileSystem.getInfoAsync(archivePath);
    if (!archiveInfo.exists || !archiveInfo.size) {
        // Peak footprint during install is tarball + extracted tree (they
        // coexist until cleanup) — fail early instead of dying mid-extract.
        const needMB = (model.downloadSizeMB || 0) + (model.totalSizeMB || 0);
        const freeBytes = await FileSystem.getFreeDiskStorageAsync().catch(() => null);
        if (needMB > 0 && freeBytes != null && freeBytes < needMB * 1024 * 1024) {
            const freeMB = Math.round(freeBytes / (1024 * 1024));
            const err = new Error(`Not enough free space: this model needs ~${needMB} MB to install, ${freeMB} MB available.`);
            err.code = 'NO_SPACE';
            throw err;
        }
        const tmp = `${archivePath}.part`;
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
        const download = FileSystem.createDownloadResumable(
            model.archive.url,
            tmp,
            {},
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                if (onProgress && totalBytesExpectedToWrite > 0) {
                    onProgress(Math.round((totalBytesWritten / totalBytesExpectedToWrite) * 90));
                }
            }
        );
        try {
            await download.downloadAsync();
            await FileSystem.deleteAsync(archivePath, { idempotent: true }).catch(() => {});
            await FileSystem.moveAsync({ from: tmp, to: archivePath });
        } catch (e) {
            await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
            throw e;
        }
    }
    if (onProgress) onProgress(92);

    const result = await extractTarBz2(
        archivePath.replace('file://', ''),
        dir.replace('file://', ''),
    );
    if (!result?.success) {
        throw new Error(result?.message || 'Model archive extraction failed');
    }
    if (onProgress) onProgress(97);

    // Flatten: tar entries live under archive.rootDir — promote the files the
    // recognizer needs into the model dir, then drop the rest (test wavs,
    // readme) together with the tarball.
    const rootDir = `${dir}/${model.archive.rootDir}`;
    for (const file of model.files) {
        const dest = `${dir}/${file}`;
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
        await FileSystem.moveAsync({ from: `${rootDir}/${file}`, to: dest });
    }
    await FileSystem.deleteAsync(rootDir, { idempotent: true }).catch(() => {});
    await FileSystem.deleteAsync(archivePath, { idempotent: true }).catch(() => {});

    for (const file of model.files) {
        const info = await FileSystem.getInfoAsync(`${dir}/${file}`);
        if (!info.exists || !info.size) {
            throw new Error(`Model file missing after extraction: ${file}`);
        }
    }
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

    if (model.archive) {
        if (await isSherpaModelDownloaded(modelKey)) {
            // A kill between the file moves and cleanup can leave the tarball
            // behind a completed install — reclaim the 100-460 MB tarball.
            await FileSystem.deleteAsync(`${dir}/model.tar.bz2`, { idempotent: true }).catch(() => {});
        } else {
            await _downloadAndExtractArchive(model, dir, onProgress);
        }
        if (onProgress) onProgress(100);
        return getSherpaModelPath(modelKey);
    }

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
        // 2.1.0 retired Whisper Tiny (attention export) and SenseVoice Small in
        // favour of the two-tier Parakeet lineup — reclaim their 100-230 MB.
        await FileSystem.deleteAsync(`${docDir}sherpa-whisper-tiny-attention-int8`, { idempotent: true });
        await FileSystem.deleteAsync(`${docDir}sherpa-sensevoice-small-int8`, { idempotent: true });
    } catch (_) {}
};
