import TrackPlayer, { Capability, AppKilledPlaybackBehavior } from 'react-native-track-player';

export const setupPlayer = async () => {
    try {
        await TrackPlayer.setupPlayer({
            // Route audio to Bluetooth A2DP / headphones (not just phone speaker)
            android: {
                audioContentType: 'music',
            },
        });
        await TrackPlayer.updateOptions({
            capabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToNext,
                Capability.SkipToPrevious,
                Capability.Stop,
            ],
            compactCapabilities: [
                Capability.Play,
                Capability.Pause,
            ],
            // Stop audio when user force-closes the app from the recent apps tray
            android: {
                appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
            },
        });
        console.log('Player initialized');
    } catch (e) {
        // On Android the player survives JS reloads, so setupPlayer throws
        // "already initialized" — that's fine, we still need to reset below.
        console.log('Player setup error:', e);
    }

    // Always clear any queue persisted from the previous session so the
    // MiniPlayer doesn't appear on a fresh app launch.
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
    if (autoPlay) await TrackPlayer.play();
};
