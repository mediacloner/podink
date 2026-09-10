import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { showAlert } from './AppAlert';
import { onEpisodeEnded, FINISHED_PROMPT_KEY, ASK_DELETE_ON_FINISH_KEY } from '../services/playbackService';
import { isLocalEpisode, isYouTubeEpisode, removeEpisodeDownload } from '../services/episodeService';
import { getEpisodeById } from '../database/queries';
import { log } from '../services/logService';

/**
 * FinishedEpisodePrompt — renders nothing. When a *downloaded* episode plays
 * to its end, asks whether to delete the download (audio + transcript) now
 * that it has been heard. Streamed episodes have nothing to free, so they
 * never prompt, and Settings → Storage → "Ask to delete finished episodes"
 * turns the prompt off entirely (checked on every ask, not cached).
 *
 * An imported YouTube video (4.1.0) asks too, with its own wording: its file
 * *is* the episode, so "Delete" removes the video from the library (row,
 * file, transcript — episodeService.deleteLocalEpisode via
 * removeEpisodeDownload; an emptied channel goes with it) and the message
 * says so, pointing at the link as the way back. Chapters of an imported
 * collection never ask: deleting one chapter of an audiobook because it was
 * heard is not what anyone wants, and the collection screen is where that
 * choice belongs.
 *
 * "Keep" keeps a podcast download for now, not forever: unless switched off
 * in Settings → Storage, the weekly sweep — episodeService's
 * sweepStaleFinishedDownloads — removes it once the episode has gone a week
 * without a replay. A kept YouTube video is left alone by the sweep.
 *
 * Two entry points, same handler:
 *  - live: playbackService's onEpisodeEnded (State.Ended, i.e. the real end
 *    of the audio — not the final-stretch "played" window, which would
 *    interrupt the outro and offer to delete a file still in use);
 *  - deferred: the id parked under FINISHED_PROMPT_KEY, for an episode that
 *    ended while the UI was gone (app swiped from recents, foreground
 *    service kept playing). Checked once on mount; cleared when answered, so
 *    a process death mid-alert re-asks on the next launch.
 *
 * Mount once at the root next to <AppAlert /> (after the DB is ready).
 */
const clearPending = () => AsyncStorage.removeItem(FINISHED_PROMPT_KEY).catch(() => {});

const FinishedEpisodePrompt = () => {
    // Episode currently being asked about — the live event and the parked
    // id can name the same episode within one session.
    const askingRef = useRef(null);

    useEffect(() => {
        let alive = true;

        const ask = async (episodeId) => {
            if (!alive || !episodeId || askingRef.current === episodeId) return;
            askingRef.current = episodeId;

            let enabled = true;
            try { enabled = (await AsyncStorage.getItem(ASK_DELETE_ON_FINISH_KEY)) !== '0'; } catch (_) {}
            let ep = null;
            if (enabled) {
                try { ep = await getEpisodeById(episodeId); } catch (_) {}
            }
            if (!alive) return;
            if (!enabled || !ep || !ep.is_downloaded || !ep.local_audio_path || isLocalEpisode(ep)) {
                // Turned off in Settings — or streamed, unsubscribed, already
                // deleted, or a chapter of an imported book (its file is the
                // episode; deleting it is a deliberate act in the collection
                // screen): nothing to ask. Drop the parked id either way.
                askingRef.current = null;
                clearPending();
                return;
            }

            const settle = () => { askingRef.current = null; clearPending(); };
            const youtube = isYouTubeEpisode(ep);
            log('UI', 'Finished-episode prompt', { id: ep.id, title: ep.title, youtube });
            showAlert(
                youtube ? 'Video finished' : 'Episode finished',
                youtube
                    ? `You finished "${ep.title}". Delete this video and its transcript to free up space? It leaves your library; you can import it again from its YouTube link.`
                    : `You finished "${ep.title}". Delete the download and its transcript to free up space? The episode stays in your feed, marked as played.`,
                [
                    { text: 'Keep', style: 'cancel', onPress: settle },
                    {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                            settle();
                            try {
                                await removeEpisodeDownload(ep);
                            } catch (e) {
                                log('UI', 'Finished-episode delete failed', { id: ep.id, error: e?.message || String(e) });
                                showAlert('Delete failed', 'Could not remove this episode. You can still delete it from the Library.');
                            }
                        },
                    },
                ],
                // Answered by a button only. Skipping to the end with the +10
                // button puts this card under a finger mid-tap; a backdrop tap
                // used to take it away as "Keep" before it could be read
                // (user, 2026-09-10: "jump until final, the delete message
                // doesn't appear").
                { dismissible: false },
            );
        };

        const unsub = onEpisodeEnded(ask);
        AsyncStorage.getItem(FINISHED_PROMPT_KEY)
            .then((id) => { if (id) ask(id); })
            .catch(() => {});

        return () => { alive = false; unsub(); };
    }, []);

    return null;
};

export default FinishedEpisodePrompt;
