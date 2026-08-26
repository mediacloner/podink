import TrackPlayer, { Event, State } from 'react-native-track-player';
import { savePlayPosition, markEpisodePlayed, setEpisodeDurationIfMissing } from '../database/queries';
import { notifyLibraryChange } from './libraryEvents';

// Centralized play-position persistence (contract 9): the 1s
// PlaybackProgressUpdated events (interval set in trackPlayer.js) are
// throttled down to one DB write every ~5s; remote pause/stop flush
// immediately so the position survives the session ending.
const SAVE_THROTTLE_MS = 5000;
let lastSaveTs = 0;
// Track ids whose duration has been backfilled this session: the UPDATE is
// a no-op once a length is stored, so skip the round-trip on later ticks.
const durationBackfilled = new Set();

/** "Listened" once inside the final stretch of the episode: 5% of the
 *  duration, clamped to [10s, 2min] for normal episodes and to 25% of the
 *  duration for short clips (a 20s trailer needs ~15s of real progress,
 *  not one progress tick). Also used by PlayerScreen as a legacy fallback
 *  to restart finished episodes from the top. */
export const isPlaybackComplete = (position, duration) => {
    if (!duration || duration <= 0 || !position || position <= 0) return false;
    const window = Math.min(Math.max(10, duration * 0.05), 120, duration * 0.25);
    return duration - position <= window;
};

/** Single write path for playback progress, shared by every flush site
 *  (service events here, PlayerScreen unmount, MiniPlayer dismiss, the
 *  cold-start stale-queue flush). A completed episode persists
 *  play_position = 0 — so any replay starts from the top without needing
 *  a trustworthy Episodes.duration — and is marked played exactly once. */
export const persistProgress = async (trackId, position, duration, { ended = false } = {}) => {
    if (!trackId) return;
    try {
        // The player knows the real length as soon as the track loads; store
        // it for feeds that shipped no <itunes:duration> so their rows can
        // show a total time and "x left".
        if (duration > 0 && !durationBackfilled.has(trackId)) {
            durationBackfilled.add(trackId);
            await setEpisodeDurationIfMissing(trackId, Math.round(duration));
        }
        if (ended || isPlaybackComplete(position, duration)) {
            await savePlayPosition(trackId, 0);
            const justCompleted = await markEpisodePlayed(trackId);
            if (justCompleted) {
                notifyLibraryChange({ type: 'playback-complete', episodeId: trackId });
            }
        } else if (position > 0) {
            await savePlayPosition(trackId, Math.floor(position));
        }
    } catch (_) {}
};

const saveCurrentPositionNow = async ({ ended = false } = {}) => {
    try {
        const [{ position, duration }, track] = await Promise.all([
            TrackPlayer.getProgress(),
            TrackPlayer.getActiveTrack(),
        ]);
        lastSaveTs = Date.now();
        // Player-reported duration (not Episodes.duration), so completion
        // works even for feeds without an <itunes:duration> tag.
        await persistProgress(track?.id, position, duration, { ended });
    } catch (_) {}
};

export default async function() {
    TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());

    TrackPlayer.addEventListener(Event.RemotePause, async () => {
        await TrackPlayer.pause();
        await saveCurrentPositionNow();
    });

    TrackPlayer.addEventListener(Event.RemoteJumpForward, async ({ interval }) => {
        const { position, duration } = await TrackPlayer.getProgress();
        const target = position + (interval || 10);
        await TrackPlayer.seekTo(duration > 0 ? Math.min(target, duration) : target);
    });

    TrackPlayer.addEventListener(Event.RemoteJumpBackward, async ({ interval }) => {
        const { position } = await TrackPlayer.getProgress();
        await TrackPlayer.seekTo(Math.max(0, position - (interval || 10)));
    });

    TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => TrackPlayer.seekTo(position));

    TrackPlayer.addEventListener(Event.RemoteStop, async () => {
        // save before stop — stopping can reset the reported position
        await saveCurrentPositionNow();
        await TrackPlayer.stop();
    });

    TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async (e) => {
        // Cheap pre-check honoring the "is playing / non-zero" intent. The
        // actual write takes a fresh, internally-consistent snapshot at save
        // time: e.track is an INDEX resolved against the live (mutable) queue,
        // so getTrack(e.track) could attribute episode A's position to a newly
        // swapped-in episode B. saveCurrentPositionNow reads position + active
        // track together, so id and position always match the current track.
        if (!e.position || e.position <= 0) return;
        const now = Date.now();
        if (now - lastSaveTs < SAVE_THROTTLE_MS) return;
        await saveCurrentPositionNow();
    });

    // In-app pause (PlayerControls / MiniPlayer call TrackPlayer.pause()
    // directly) fires no Remote event and stops PlaybackProgressUpdated, so the
    // last throttled save can be up to SAVE_THROTTLE_MS behind. Flush on every
    // transition to a non-playing state (covers in-app + remote pause, and
    // end-of-episode) so resume is accurate even if the process is later killed.
    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
        if (state === State.Paused || state === State.Stopped || state === State.Ended) {
            // Ended = the queue actually finished — mark the episode listened
            // even if the reported position/duration snapshot is unreliable.
            saveCurrentPositionNow({ ended: state === State.Ended });
        }
    });
};
