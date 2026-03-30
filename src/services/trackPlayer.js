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
        console.log('Player setup error:', e);
    }
};

export const loadEpisodeTrack = async (episode, autoPlay = true) => {
    // Determine whether to use local or remote path
    // local_audio_path is already a file:// URI from expo-file-system
    const url = episode.is_downloaded && episode.local_audio_path ? episode.local_audio_path : episode.audio_url;

    const track = {
        id: episode.id,
        url: url,
        title: episode.title,
        artist: episode.podcast_title,
    };

    await TrackPlayer.reset();
    await TrackPlayer.add(track);
    if (autoPlay) await TrackPlayer.play();
};
