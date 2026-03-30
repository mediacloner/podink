import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import TrackPlayer, { usePlaybackState, useProgress, State } from 'react-native-track-player';
import Slider from '@react-native-community/slider';
import { Feather as Icon } from '@expo/vector-icons';

const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
};

const PlayerControls = () => {
    const { state: playbackState } = usePlaybackState();
    const { position, duration } = useProgress();
    const [rate, setRate] = React.useState(1);

    const cycleRate = async () => {
        const nextRate = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
        await TrackPlayer.setRate(nextRate);
        setRate(nextRate);
    };

    const togglePlayback = async () => {
        if (!playbackState) return; // still initialising
        const currentTrack = await TrackPlayer.getActiveTrackIndex();
        if (currentTrack != null) {
            if (playbackState === State.Playing) {
                await TrackPlayer.pause();
            } else {
                await TrackPlayer.play();
            }
        }
    };

    const skipForward = async () => {
        await TrackPlayer.seekTo(position + 15);
    };

    const skipBackward = async () => {
        await TrackPlayer.seekTo(Math.max(0, position - 15));
    };

    return (
        <View style={styles.container}>
            <View style={styles.progressContainer}>
                <Text style={styles.timeText}>{formatTime(position)}</Text>
                <Slider
                    style={styles.slider}
                    minimumValue={0}
                    maximumValue={duration}
                    value={position}
                    minimumTrackTintColor="#4a90e2"
                    maximumTrackTintColor="#333"
                    thumbTintColor="#fff"
                    onSlidingComplete={async (value) => {
                        await TrackPlayer.seekTo(value);
                    }}
                />
                <Text style={styles.timeText}>{formatTime(duration)}</Text>
            </View>
            <View style={styles.controlsRow}>
                <TouchableOpacity onPress={skipBackward} style={styles.iconButton}>
                    <Icon name="rotate-ccw" size={24} color="#fff" />
                    <Text style={styles.skipText}>15</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={togglePlayback} style={styles.playButton}>
                    <Icon name={playbackState === State.Playing ? 'pause' : 'play'} size={32} color="#000" />
                </TouchableOpacity>

                <TouchableOpacity onPress={skipForward} style={styles.iconButton}>
                    <Icon name="rotate-cw" size={24} color="#fff" />
                    <Text style={styles.skipText}>15</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={cycleRate} style={styles.rateButton}>
                    <Text style={styles.rateText}>{rate}x</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { width: '100%', paddingHorizontal: 20 },
    progressContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', marginBottom: 15 },
    slider: { flex: 1, height: 40, marginHorizontal: 10 },
    timeText: { color: '#888', fontSize: 12, width: 40, textAlign: 'center' },
    controlsRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
    playButton: { backgroundColor: '#fff', padding: 15, borderRadius: 50, width: 64, height: 64, alignItems: 'center', justifyContent: 'center', marginHorizontal: 30 },
    iconButton: { alignItems: 'center', justifyContent: 'center' },
    skipText: { color: '#fff', fontSize: 10, marginTop: 4 },
    rateButton: { position: 'absolute', right: -20, backgroundColor: '#333', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 12 },
    rateText: { color: '#fff', fontSize: 12, fontWeight: 'bold' }
});

export default PlayerControls;
