import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import TrackPlayer, { usePlaybackState, useProgress, State } from 'react-native-track-player';
import Slider from '@react-native-community/slider';
import { Feather as Icon } from '@expo/vector-icons';

const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
};

const RATES = [1, 1.25, 1.5, 1.75, 2];

const PlayerControls = () => {
    const { state: playbackState } = usePlaybackState();
    const { position, duration } = useProgress();
    const [rateIdx, setRateIdx] = React.useState(0);
    const rate = RATES[rateIdx];

    const cycleRate = async () => {
        const next = (rateIdx + 1) % RATES.length;
        await TrackPlayer.setRate(RATES[next]);
        setRateIdx(next);
    };

    const togglePlayback = async () => {
        if (!playbackState) return;
        const track = await TrackPlayer.getActiveTrackIndex();
        if (track != null) {
            playbackState === State.Playing
                ? await TrackPlayer.pause()
                : await TrackPlayer.play();
        }
    };

    const isPlaying = playbackState === State.Playing;
    const remaining = Math.max(0, duration - position);

    return (
        <View style={styles.container}>
            {/* Slider */}
            <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={duration || 1}
                value={position}
                minimumTrackTintColor="#4FACFE"
                maximumTrackTintColor="rgba(255,255,255,0.08)"
                thumbTintColor="#FFFFFF"
                onSlidingComplete={async (v) => { await TrackPlayer.seekTo(v); }}
            />

            {/* Time row */}
            <View style={styles.timeRow}>
                <Text style={styles.time}>{formatTime(position)}</Text>
                <Text style={styles.time}>−{formatTime(remaining)}</Text>
            </View>

            {/* Controls */}
            <View style={styles.controls}>
                {/* Rate */}
                <TouchableOpacity style={styles.rateBtn} onPress={cycleRate}>
                    <Text style={styles.rateText}>{rate === 1 ? '1×' : `${rate}×`}</Text>
                </TouchableOpacity>

                {/* Skip back */}
                <TouchableOpacity
                    style={styles.skipBtn}
                    onPress={() => TrackPlayer.seekTo(Math.max(0, position - 15))}
                >
                    <Icon name="rotate-ccw" size={28} color="#FFFFFF" />
                    <Text style={styles.skipLabel}>15</Text>
                </TouchableOpacity>

                {/* Play / Pause */}
                <TouchableOpacity style={styles.playBtn} onPress={togglePlayback}>
                    <Icon
                        name={isPlaying ? 'pause' : 'play'}
                        size={28}
                        color="#0C0C0E"
                        style={isPlaying ? undefined : { marginLeft: 3 }}
                    />
                </TouchableOpacity>

                {/* Skip forward */}
                <TouchableOpacity
                    style={styles.skipBtn}
                    onPress={() => TrackPlayer.seekTo(position + 15)}
                >
                    <Icon name="rotate-cw" size={28} color="#FFFFFF" />
                    <Text style={styles.skipLabel}>15</Text>
                </TouchableOpacity>

                {/* Spacer to balance rate button */}
                <View style={styles.rateSpacer} />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        width: '100%',
        paddingHorizontal: 20,
        paddingTop: 4,
    },

    slider: {
        width: '100%',
        height: 36,
        marginBottom: 2,
    },

    timeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        marginBottom: 20,
    },
    time: {
        fontSize: 12,
        fontWeight: '500',
        color: '#636366',
        fontVariant: ['tabular-nums'],
    },

    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        marginBottom: 12,
    },

    rateBtn: {
        width: 52,
        height: 34,
        borderRadius: 17,
        backgroundColor: 'rgba(255,255,255,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    rateText: {
        fontSize: 13,
        fontWeight: '700',
        color: '#FFFFFF',
    },
    rateSpacer: { width: 52 },

    skipBtn: {
        alignItems: 'center',
        gap: 3,
    },
    skipLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: '#AEAEB2',
    },

    playBtn: {
        width: 72,
        height: 72,
        borderRadius: 36,
        backgroundColor: '#FFFFFF',
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#4FACFE',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
});

export default PlayerControls;
