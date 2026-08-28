import TrackPlayer from 'react-native-track-player';
import { deleteEpisodeLocalData } from '../database/queries';
import { deleteAudioFile } from './downloadService';
import { dequeueTranscription } from './whisperService';
import { notifyUserStop } from './trackPlayer';
import { persistProgress } from './playbackService';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

/**
 * Remove an episode's on-device data — audio file, transcript, downloaded
 * flag — and tell every tab. The episode row itself stays: it is still in the
 * feed and streamable from audio_url.
 *
 * Shared by the Library swipe-delete and the finished-episode prompt. If the
 * episode is the loaded track (the prompt case: it just ended and is still
 * the active track in State.Ended) playback is torn down first, so the file
 * is never deleted under the player and the MiniPlayer goes away with it.
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
