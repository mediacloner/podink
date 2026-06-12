import TrackPlayer, {
    Capability,
    AppKilledPlaybackBehavior,
    AndroidAudioContentType,
    IOSCategory,
    IOSCategoryMode,
    IOSCategoryOptions,
    State,
} from 'react-native-track-player';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { savePlayPosition } from '../database/queries';

export const setupPlayer = async () => {
    try {
        await TrackPlayer.setupPlayer({
            // Request Android audio focus so playback pauses on phone calls,
            // navigation prompts, or another app starting audio. Must be set
            // here (setupPlayer), not updateOptions — the focus toggle is fixed
            // at player construction time.
            autoHandleInterruptions: true,
            // Real RNTP option (the old nested `android.audioContentType` was
            // silently dropped). Speech content type for a podcast/learning app.
            androidAudioContentType: AndroidAudioContentType.Speech,
            // iOS: Playback category is required for lock screen controls and background audio
            iosCategory: IOSCategory.Playback,
            iosCategoryMode: IOSCategoryMode.Default,
            iosCategoryOptions: [IOSCategoryOptions.AllowBluetooth, IOSCategoryOptions.AllowAirPlay],
        });
        await TrackPlayer.updateOptions({
            capabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.JumpForward,
                Capability.JumpBackward,
                Capability.SeekTo,
                Capability.Stop,
            ],
            // Explicit lock screen / notification buttons
            notificationCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.JumpForward,
                Capability.JumpBackward,
                Capability.SeekTo,
            ],
            compactCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.JumpBackward,
                Capability.JumpForward,
            ],
            forwardJumpInterval: 10,
            backwardJumpInterval: 10,
            progressUpdateEventInterval: 1,
            // Keep playing when user force-closes the app from the recent apps tray
            android: {
                appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
                // Pause (not just duck volume) on transient interruptions for
                // speech content. Only takes effect with autoHandleInterruptions.
                alwaysPauseOnInterruption: true,
            },
        });
        console.log('Player initialized');
    } catch (e) {
        // On Android the player survives JS reloads, so setupPlayer throws
        // "already initialized" — that's fine, we still need to reset below.
        console.log('Player setup error:', e);
    }

    // A live session can survive when the user swipes the app from recents
    // while listening (ContinuePlayback keeps the foreground service playing).
    // Reopening recreates the React root and re-runs setupPlayer — don't wipe
    // that still-playing session. Only reset() on a genuinely fresh launch so
    // the MiniPlayer doesn't appear from a stale persisted queue.
    try {
        const [{ state }, track] = await Promise.all([
            TrackPlayer.getPlaybackState(),
            TrackPlayer.getActiveTrack(),
        ]);
        const live = track && [
            State.Playing, State.Buffering, State.Loading, State.Ready, State.Paused,
        ].includes(state);
        if (live) {
            _notifyUserPlay(); // re-mount the MiniPlayer so the live session has UI
            return;
        }
    } catch (_) {}

    // No live session: persist the active track's position before clearing a
    // stale persisted queue, then reset.
    try {
        const [{ position }, track] = await Promise.all([
            TrackPlayer.getProgress(),
            TrackPlayer.getActiveTrack(),
        ]);
        if (track?.id && position > 0) await savePlayPosition(track.id, Math.floor(position));
    } catch (_) {}
    try {
        await TrackPlayer.reset();
    } catch (_) {}
};

// Listeners notified when the user explicitly loads a track.
// MiniPlayer subscribes so it can gate visibility on intentional playback
// rather than TrackPlayer's automatic session-restore events.
const _playListeners = new Set();
export const onUserPlay   = (cb) => { _playListeners.add(cb);    return () => _playListeners.delete(cb); };
const _notifyUserPlay     = ()   => _playListeners.forEach(cb => cb());

const _stopListeners = new Set();
export const onUserStop   = (cb) => { _stopListeners.add(cb);    return () => _stopListeners.delete(cb); };
export const notifyUserStop = ()  => _stopListeners.forEach(cb => cb());

export const loadEpisodeTrack = async (episode, autoPlay = true) => {
    // Determine whether to use local or remote path
    // local_audio_path is already a file:// URI from expo-file-system
    const url = episode.is_downloaded && episode.local_audio_path ? episode.local_audio_path : episode.audio_url;

    const track = {
        id:      episode.id,
        url:     url,
        title:   episode.title,
        artist:  episode.podcast_title,
        artwork: episode.image_url || undefined,
    };

    _notifyUserPlay();
    await TrackPlayer.reset();
    await TrackPlayer.add(track);

    // reset() reverts the player to 1x, so re-apply the saved playback rate
    try {
        const saved = await AsyncStorage.getItem('@playback_rate');
        const rate = parseFloat(saved ?? '1');
        if (rate > 0) await TrackPlayer.setRate(rate);
    } catch (_) {}

    if (autoPlay) await TrackPlayer.play();
};
