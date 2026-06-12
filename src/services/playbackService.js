import TrackPlayer, { Event, State } from 'react-native-track-player';
import { savePlayPosition } from '../database/queries';

// Centralized play-position persistence (contract 9): the 1s
// PlaybackProgressUpdated events (interval set in trackPlayer.js) are
// throttled down to one DB write every ~5s; remote pause/stop flush
// immediately so the position survives the session ending.
const SAVE_THROTTLE_MS = 5000;
let lastSaveTs = 0;

const persistPosition = async (trackId, position) => {
    if (!trackId || !position || position <= 0) return;
    try {
        await savePlayPosition(trackId, Math.floor(position));
    } catch (_) {}
};

const saveCurrentPositionNow = async () => {
    try {
        const [{ position }, track] = await Promise.all([
            TrackPlayer.getProgress(),
            TrackPlayer.getActiveTrack(),
        ]);
        lastSaveTs = Date.now();
        await persistPosition(track?.id, position);
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
            saveCurrentPositionNow();
        }
    });
};
