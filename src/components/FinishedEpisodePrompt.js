import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { showAlert } from './AppAlert';
import { onEpisodeEnded, FINISHED_PROMPT_KEY, ASK_DELETE_ON_FINISH_KEY } from '../services/playbackService';
import { removeEpisodeDownload } from '../services/episodeService';
import { getEpisodeById } from '../database/queries';
import { log } from '../services/logService';

/**
 * FinishedEpisodePrompt — renders nothing. When a *downloaded* episode plays
 * to its end, asks whether to delete the download (audio + transcript) now
 * that it has been heard. Streamed episodes have nothing to free, so they
 * never prompt, and Settings → Storage → "Ask to delete finished episodes"
 * turns the prompt off entirely (checked on every ask, not cached).
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
            if (!enabled || !ep || !ep.is_downloaded || !ep.local_audio_path) {
                // Turned off in Settings — or streamed, unsubscribed, already
                // deleted: nothing to ask. Drop the parked id either way.
                askingRef.current = null;
                clearPending();
                return;
            }

            const settle = () => { askingRef.current = null; clearPending(); };
            log('UI', 'Finished-episode prompt', { id: ep.id, title: ep.title });
            showAlert(
                'Episode finished',
                `You finished "${ep.title}". Delete the download and its transcript to free up space? The episode stays in your feed, marked as played.`,
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
