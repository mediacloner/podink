import TrackPlayer from 'react-native-track-player';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    clearPlayProgress, deleteEpisodeLocalData, getStaleFinishedDownloads, markEpisodeFinished, markEpisodeSeen,
    updateEpisodeLocalPath,
} from '../database/queries';
import { deleteAudioFile, downloadAudioFile } from './downloadService';
import { dequeueTranscription, enqueueTranscription } from './whisperService';
import { notifyUserStop } from './trackPlayer';
import { persistProgress } from './playbackService';
import { notifyLibraryChange } from './libraryEvents';
import { showAlert } from '../components/AppAlert';
import { log } from './logService';

/**
 * episodeService — the episode-level actions every tab shares, so the Feed,
 * My Podcasts, Library, Listening and the Player all behave the same way.
 *
 * Two independent axes describe an episode:
 *
 *   Listening state (exactly one applies):
 *     New          is_played 0, play_position 0      never started
 *     In progress  is_played 0, play_position > 0    started, not finished
 *     Finished     is_played 1, play_position 0      heard to the end (or "Done")
 *   The Listening tab shows the pipeline Downloaded (New ∧ downloaded) →
 *   In progress → Finished; New episodes without a download stay in the Feed.
 *
 *   On-device data (independent of the state above):
 *     downloaded   is_downloaded 1 + local_audio_path — audio on disk
 *     transcript   has_transcript 1 — generated from the downloaded audio
 *
 * Listening transitions:
 *     New / Finished → In progress   playback saves a position > 0
 *                                    (savePlayPosition clears is_played)
 *     In progress → Finished         the final stretch / State.Ended
 *                                    (persistProgress), or swipe "Done"
 *     Finished → New                 swipe "Unplayed" (clearPlayProgress)
 *   A manual Done / Unplayed on the episode that is *playing* first stops the
 *   player (stopIfActive) — otherwise the next progress save, ~5 s later,
 *   would write a position and silently flip the row back to In progress.
 *
 * On-device transitions:
 *     download                      downloadEpisode — and, since 2.3.0, the
 *                                   transcription is queued automatically;
 *                                   there is no separate "Transcribe" step
 *                                   (the pill remains only as a retry when a
 *                                   job failed or was cancelled)
 *     delete download               removeEpisodeDownload — audio + transcript
 *                                   go, the row and its listening state stay
 *     automatic cleanup             sweepStaleFinishedDownloads — a Finished
 *                                   download that has not been replayed for a
 *                                   week is removed the same way, on launch
 *                                   and on resume (off switch in Settings →
 *                                   Storage)
 *   Neither changes the listening state: a Finished episode whose download
 *   was deleted (the end-of-episode prompt, or the weekly sweep) stays
 *   Finished; re-downloading it — from the Player's "Download & transcribe",
 *   a Listening swipe, or the Feed — brings the transcript back without
 *   touching played / position, and gives the download a fresh week.
 */

// ─── Download ⇒ transcript ────────────────────────────────────────────────────

/** Endings that are not failures: the user cancelled, the episode was already
 *  waiting, or Settings reset the queue. No alert for these. */
const QUIET_TRANSCRIPTION_ERRORS = new Set(['Cancelled', 'Already queued', 'Queue reset']);

/** { title, message } for a transcription failure worth telling the user
 *  about, or null for the quiet endings above. */
export const describeTranscriptionError = (e) => {
    const msg = e?.message || String(e);
    if (QUIET_TRANSCRIPTION_ERRORS.has(msg)) return null;
    if (/audio file|unrecognized header/i.test(msg)) {
        return {
            title: 'Invalid Audio File',
            message: 'This audio file appears to be corrupted or missing. Try deleting and re-downloading the episode.',
        };
    }
    return {
        title: 'Transcription Failed',
        message: 'Could not transcribe this episode. Make sure the AI model is downloaded in Settings.',
    };
};

export const reportTranscriptionError = (e) => {
    const d = describeTranscriptionError(e);
    if (d) showAlert(d.title, d.message);
};

export const reportDownloadError = (e) => {
    if (e?.code === 'OFFLINE') {
        showAlert('Offline', 'You need an internet connection to download episodes.');
    } else {
        showAlert('Download failed', 'Could not download this episode. Please try again.');
    }
};

/**
 * Queue an on-device transcription of a downloaded episode. Resolves when
 * the job finishes, rejects on failure (see describeTranscriptionError).
 * Progress and completion are also broadcast through libraryEvents /
 * whisperService.onTranscriptProgress, so callers may fire-and-forget.
 */
export const transcribeEpisode = (episode, { onStart } = {}) => {
    if (!episode?.local_audio_path) return Promise.reject(new Error('Audio file not found'));
    return enqueueTranscription(episode.id, episode.local_audio_path, null, onStart, episode.duration || 0);
};

/**
 * Download an episode's audio, mark it downloaded, tell every tab — and queue
 * its transcription straight away (unless one already exists). Resolves with
 * the local file URI; throws when offline (`code: 'OFFLINE'`) or when the
 * download fails, so callers can alert (reportDownloadError) and clear their
 * progress indicator. A transcription failure is reported here, not thrown:
 * the download itself succeeded.
 */
export const downloadEpisode = async (episode, { onProgress } = {}) => {
    if (!episode?.audio_url) throw new Error('Episode has no audio URL');
    log('UI', 'Download episode', { id: episode.id, title: episode.title });
    try {
        const net = await NetInfo.fetch();
        if (net?.isConnected === false) {
            const err = new Error('Offline');
            err.code = 'OFFLINE';
            throw err;
        }
    } catch (e) {
        if (e?.code === 'OFFLINE') throw e; // a NetInfo failure itself must not block the download
    }
    const safeId = String(episode.id).replace(/[^a-zA-Z0-9]/g, '_');
    const localPath = await downloadAudioFile(episode.audio_url, `episode_${safeId}.mp3`, onProgress);
    await updateEpisodeLocalPath(episode.id, localPath);
    // Downloading is "seeing" it: the My Podcasts badge (is_new count) drops
    // by one before the event below makes the badge re-check.
    await markEpisodeSeen(episode.id);
    log('UI', 'Download completed', { id: episode.id });
    notifyLibraryChange({ type: 'download-complete', episodeId: episode.id });
    if (!episode.has_transcript) {
        transcribeEpisode({ ...episode, local_audio_path: localPath }).catch(reportTranscriptionError);
    }
    return localPath;
};

/**
 * Remove an episode's on-device data — audio file, transcript, downloaded
 * flag — and tell every tab. The episode row itself stays: it is still in the
 * feed and streamable from audio_url, and its listening state is untouched.
 *
 * Shared by the Library / Listening swipe-delete and the finished-episode
 * prompt. If the episode is the loaded track (the prompt case: it just ended
 * and is still the active track in State.Ended) playback is torn down first,
 * so the file is never deleted under the player and the MiniPlayer goes away
 * with it.
 *
 * Throws on failure so callers can show an error and restore their row.
 */
export const removeEpisodeDownload = async (episode) => {
    const id = episode.id;
    log('UI', 'Remove download', { id, title: episode.title });
    dequeueTranscription(id);
    try {
        const track = await TrackPlayer.getActiveTrack();
        if (track?.id === id) {
            const { position, duration } = await TrackPlayer.getProgress();
            await persistProgress(id, position, duration);
            await TrackPlayer.reset();
            notifyUserStop(); // unmounts the MiniPlayer (App.js)
        }
    } catch (_) {}
    if (episode.local_audio_path) await deleteAudioFile(episode.local_audio_path);
    await deleteEpisodeLocalData(id);
    notifyLibraryChange({ type: 'episode-delete', episodeId: id });
};

// ─── Automatic cleanup of finished downloads ─────────────────────────────────

/** Settings → Storage → "Delete finished episodes after a week": '1'/'0',
 *  absent = on (same shape as ASK_DELETE_ON_FINISH_KEY). Read at sweep time,
 *  so flipping it takes effect on the next launch / resume. */
export const AUTO_DELETE_FINISHED_KEY = '@auto_delete_finished';
/** How long a finished download is kept without a replay. */
export const FINISHED_DOWNLOAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The rule is day-granular; a sweep per foreground is plenty. */
const SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;
let _lastSweepAt = 0;

/**
 * Remove the download (audio + transcript) of every Finished episode that
 * has gone a week without a replay — heard to the end or marked Done more
 * than FINISHED_DOWNLOAD_KEEP_MS ago, and downloaded at least that long ago
 * too (a re-download for a read-along gets its own week). The episode row
 * stays Finished and streamable, exactly as after the end-of-episode
 * prompt's "Delete"; the prompt's "Keep" only defers to this sweep.
 *
 * Called on launch (after initDB) and on every return to the foreground —
 * the app can sit cached in the background for days. Throttled to one run an
 * hour unless `force`. The loaded track is skipped (it would tear the player
 * down under the MiniPlayer); it is picked up on the next cold start, when
 * nothing is loaded. Never throws; resolves with the number of downloads
 * removed.
 */
export const sweepStaleFinishedDownloads = async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - _lastSweepAt < SWEEP_MIN_INTERVAL_MS) return 0;

    // Checked before the throttle is armed, so switching the setting on in
    // Settings takes effect on the very next resume, not an hour later.
    let enabled = true;
    try { enabled = (await AsyncStorage.getItem(AUTO_DELETE_FINISHED_KEY)) !== '0'; } catch (_) {}
    if (!enabled) return 0;
    _lastSweepAt = now;

    let stale = [];
    try {
        stale = await getStaleFinishedDownloads(now - FINISHED_DOWNLOAD_KEEP_MS);
    } catch (e) {
        log('SYSTEM', 'Finished-download sweep query failed', { error: e?.message || String(e) });
        return 0;
    }
    if (!stale.length) return 0;

    let activeId = null;
    try { activeId = (await TrackPlayer.getActiveTrack())?.id ?? null; } catch (_) {}

    log('SYSTEM', 'Finished-download sweep', { candidates: stale.length, activeId });
    let removed = 0;
    for (const ep of stale) {
        if (ep.id === activeId) continue;
        try {
            await removeEpisodeDownload(ep);
            removed += 1;
        } catch (e) {
            log('SYSTEM', 'Finished-download sweep: remove failed', { id: ep.id, error: e?.message || String(e) });
        }
    }
    log('SYSTEM', 'Finished-download sweep done', { removed });
    return removed;
};

// ─── Manual listening-state changes ──────────────────────────────────────────

/** Unload the player when `episodeId` is the loaded track. A manual state
 *  change on the playing episode must win over the periodic progress save,
 *  which would otherwise re-persist a position (and is_played = 0) within
 *  seconds. The reset fires a state event whose save sees an empty queue,
 *  so it writes nothing. Returns true when playback was stopped. */
const stopIfActive = async (episodeId) => {
    try {
        const track = await TrackPlayer.getActiveTrack();
        if (track?.id !== episodeId) return false;
        await TrackPlayer.reset();
        notifyUserStop(); // unmounts the MiniPlayer (App.js)
        return true;
    } catch (_) {
        return false;
    }
};

/** Listening → swipe "Done": same end state as a natural finish (played,
 *  position back at the top). Stops the episode if it is the one playing. */
export const markListened = async (episode) => {
    const stopped = await stopIfActive(episode.id);
    log('UI', 'Mark finished', { id: episode.id, title: episode.title, stopped });
    await markEpisodeFinished(episode.id);
    // Same event a natural finish emits, so Feed / My Podcasts rows pick up
    // their Played badge.
    notifyLibraryChange({ type: 'playback-complete', episodeId: episode.id });
};

/** Listening → swipe "Unplayed": back to a never-started row (New). Stops
 *  the episode if it is the one playing. */
export const markUnlistened = async (episode) => {
    const stopped = await stopIfActive(episode.id);
    log('UI', 'Mark unplayed', { id: episode.id, title: episode.title, stopped });
    await clearPlayProgress(episode.id);
    notifyLibraryChange({ type: 'playback-reset', episodeId: episode.id });
};
