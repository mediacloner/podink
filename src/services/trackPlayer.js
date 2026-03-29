import TrackPlayer, { Event, State } from 'react-native-track-player';

export const setupPlayer = async () => {
    try {
        await TrackPlayer.setupPlayer();
        await TrackPlayer.updateOptions({
            capabilities: [
                TrackPlayer.CAPABILITY_PLAY,
                TrackPlayer.CAPABILITY_PAUSE,
                TrackPlayer.CAPABILITY_SKIP_TO_NEXT,
                TrackPlayer.CAPABILITY_SKIP_TO_PREVIOUS,
                TrackPlayer.CAPABILITY_STOP,
            ],
            compactCapabilities: [
                TrackPlayer.CAPABILITY_PLAY,
                TrackPlayer.CAPABILITY_PAUSE,
            ]
        });
        console.log('Player initialized');
    } catch (e) {
        console.log('Player setup error:', e);
    }
};

export const loadEpisodeTrack = async (episode) => {
    // Determine whether to use local or remote path
    const url = episode.is_downloaded && episode.local_audio_path ? `file://${episode.local_audio_path}` : episode.audio_url;

    const track = {
        id: episode.id,
        url: url,
        title: episode.title,
        artist: episode.podcast_title,
    };

    await TrackPlayer.reset();
    await TrackPlayer.add(track);
    await TrackPlayer.play();
};
