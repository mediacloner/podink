import React, { useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import TrackPlayer, { usePlaybackState, useProgress, State } from 'react-native-track-player';
import Slider from '@react-native-community/slider';
import { Feather as Icon } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors } from '../theme';

const RATES = [0.7, 0.85, 1, 1.15, 1.3, 1.5];
const RATE_KEY = '@playback_rate';

const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
};

// Trim trailing zeros AND a dangling '.0' so 1x reads '1x' (not '1.0x'),
// while 0.7/1.15 stay intact.
const formatRate = (rate) => `${String(Number(rate.toFixed(2)))}x`;

const PlayerControls = ({ accent = colors.accent, onReplaySentence, onRateChange }) => {
    const { state: playbackState } = usePlaybackState();
    const { position, duration } = useProgress();

    const onRateChangeRef = useRef(onRateChange);
    onRateChangeRef.current = onRateChange;

    // ── Playback rate ────────────────────────────────────────────────────────
    const [rate, setRate] = useState(1);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const saved = await AsyncStorage.getItem(RATE_KEY);
                const restored = parseFloat(saved ?? '1') || 1;
                if (cancelled) return;
                setRate(restored);
                // setRate can throw before a track is loaded; the restore
                // callback must still fire so PlayerScreen mirrors the rate
                try { await TrackPlayer.setRate(restored); } catch (_) {}
                onRateChangeRef.current?.(restored);
            } catch (_) {}
        })();
        return () => { cancelled = true; };
    }, []);

    const applyRate = async (next) => {
        setRate(next);
        try {
            await AsyncStorage.setItem(RATE_KEY, String(next));
            await TrackPlayer.setRate(next);
        } catch (_) {}
        onRateChangeRef.current?.(next);
    };

    // indexOf returns -1 for a rate outside the cycle, which restarts at RATES[0]
    const cycleRate = () => applyRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]);

    // ── Slider seek guard ────────────────────────────────────────────────────
    // seekValue != null means the thumb is user-owned: while dragging AND
    // after release until the native player reports the new position
    // (getProgress keeps returning the old value for 1-2 polls after seekTo,
    // so releasing immediately makes the thumb snap back).
    const [seekValue, setSeekValue] = useState(null);
    const seekDragRef = useRef(false);
    const seekTargetRef = useRef(null);
    const seekReleaseTimer = useRef(null);

    const releaseSeekGuard = () => {
        seekTargetRef.current = null;
        if (seekReleaseTimer.current) {
            clearTimeout(seekReleaseTimer.current);
            seekReleaseTimer.current = null;
        }
        setSeekValue(null);
    };

    const handleSlidingStart = (v) => {
        seekDragRef.current = true;
        if (seekReleaseTimer.current) {
            clearTimeout(seekReleaseTimer.current);
            seekReleaseTimer.current = null;
        }
        seekTargetRef.current = null;
        // A slider seek takes ownership of the position — drop any pending skip.
        pendingJumpRef.current = null;
        setSeekValue(v);
    };

    const handleValueChange = (v) => {
        if (seekDragRef.current) setSeekValue(v);
    };

    const handleSlidingComplete = async (v) => {
        seekDragRef.current = false;
        setSeekValue(v);
        seekTargetRef.current = v;
        pendingJumpRef.current = null;
        try { await TrackPlayer.seekTo(v); } catch (_) {}
        seekReleaseTimer.current = setTimeout(releaseSeekGuard, 1500);
    };

    useEffect(() => {
        if (seekTargetRef.current != null && Math.abs(position - seekTargetRef.current) < 0.5) {
            releaseSeekGuard();
        }
    }, [position]);

    useEffect(() => () => {
        if (seekReleaseTimer.current) clearTimeout(seekReleaseTimer.current);
    }, []);

    // ── Skip buttons ─────────────────────────────────────────────────────────
    // Rapid taps must accumulate: the native position lags behind seekTo, so
    // base follow-up taps on the previous target instead of the stale read.
    const pendingJumpRef = useRef(null);

    const jump = async (delta) => {
        try {
            const { position: pos, duration: dur } = await TrackPlayer.getProgress();
            const now = Date.now();
            const pending = pendingJumpRef.current;
            // Trust the accumulated target only if it's recent AND the player is
            // still near it. If pos diverged, another seek (slider/transcript/
            // remote) took ownership — fall back to the fresh native read.
            const fresh = pending && now - pending.ts < 1500;
            const consistent = pending && Math.abs(pos - pending.target) < 2; // seconds
            const base = fresh && consistent ? pending.target : pos;
            let target = Math.max(0, base + delta);
            if (dur > 0) target = Math.min(target, dur);
            pendingJumpRef.current = { target, ts: now };
            await TrackPlayer.seekTo(target);
        } catch (_) {}
    };

    // ── Play / pause ─────────────────────────────────────────────────────────
    const togglePlayback = async () => {
        try {
            // fresh read: the usePlaybackState hook is {state: undefined} on
            // first frames, which used to make this tap dead
            const { state } = await TrackPlayer.getPlaybackState();
            if (state === State.Playing || state === State.Buffering || state === State.Loading) {
                await TrackPlayer.pause();
            } else {
                await TrackPlayer.play();
            }
        } catch (_) {}
    };

    const isPlaying = playbackState === State.Playing;
    const isBusy = playbackState === State.Buffering || playbackState === State.Loading;
    const isSeeking = seekValue != null;
    const displayPosition = isSeeking ? seekValue : position;
    const remaining = Math.max(0, duration - displayPosition);

    return (
        <View style={styles.container}>
            {/* Slider */}
            <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={duration || 1}
                value={displayPosition}
                minimumTrackTintColor={accent}
                maximumTrackTintColor={colors.hairline}
                thumbTintColor={colors.textPrimary}
                onSlidingStart={handleSlidingStart}
                onValueChange={handleValueChange}
                onSlidingComplete={handleSlidingComplete}
            />

            {/* Time row — left side shows the scrub target while seeking */}
            <View style={styles.timeRow}>
                <Text style={[styles.time, isSeeking && { color: accent }]}>
                    {formatTime(displayPosition)}
                </Text>
                <Text style={styles.time}>−{formatTime(remaining)}</Text>
            </View>

            {/* Controls */}
            <View style={styles.controls}>
                {/* Playback rate: tap cycles, long-press resets to 1x */}
                <TouchableOpacity
                    style={styles.sideBtn}
                    onPress={cycleRate}
                    onLongPress={() => applyRate(1)}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                >
                    <Text style={[styles.rateLabel, rate !== 1 && { color: accent }]}>
                        {formatRate(rate)}
                    </Text>
                </TouchableOpacity>

                {/* Skip back */}
                <TouchableOpacity style={styles.skipBtn} onPress={() => jump(-10)}>
                    <Icon name="rotate-ccw" size={28} color={colors.textPrimary} />
                    <Text style={styles.skipLabel}>10</Text>
                </TouchableOpacity>

                {/* Play / Pause */}
                <TouchableOpacity
                    style={[styles.playBtn, { backgroundColor: accent, shadowColor: accent }]}
                    onPress={togglePlayback}
                >
                    {isBusy ? (
                        <ActivityIndicator size="large" color={colors.bg} />
                    ) : (
                        <Icon
                            name={isPlaying ? 'pause' : 'play'}
                            size={34}
                            color={colors.bg}
                            style={isPlaying ? undefined : { marginLeft: 3 }}
                        />
                    )}
                </TouchableOpacity>

                {/* Skip forward */}
                <TouchableOpacity style={styles.skipBtn} onPress={() => jump(10)}>
                    <Icon name="rotate-cw" size={28} color={colors.textPrimary} />
                    <Text style={styles.skipLabel}>10</Text>
                </TouchableOpacity>

                {/* Replay sentence (placeholder keeps the play button centered) */}
                {onReplaySentence ? (
                    <TouchableOpacity
                        style={styles.sideBtn}
                        onPress={onReplaySentence}
                        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                    >
                        <Icon name="rotate-ccw" size={22} color={colors.textSecondary} />
                    </TouchableOpacity>
                ) : (
                    <View style={styles.sideBtn} />
                )}
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
        color: colors.textMuted,
        fontVariant: ['tabular-nums'],
    },

    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        marginBottom: 12,
    },

    sideBtn: {
        width: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rateLabel: {
        fontSize: 13,
        fontWeight: '700',
        color: colors.textSecondary,
        fontVariant: ['tabular-nums'],
    },

    skipBtn: {
        alignItems: 'center',
        gap: 3,
    },
    skipLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: colors.textSecondary,
    },

    playBtn: {
        width: 88,
        height: 88,
        borderRadius: 44,
        alignItems: 'center',
        justifyContent: 'center',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
});

export default PlayerControls;
