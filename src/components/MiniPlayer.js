import React, { useEffect, useRef, useState } from 'react';
import {
    View, Text, Image, TouchableOpacity,
    StyleSheet, Animated, Pressable, PanResponder, ActivityIndicator,
} from 'react-native';
import TrackPlayer, {
    useActiveTrack, usePlaybackState, useProgress, State,
} from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import { getEpisodeById, savePlayPosition } from '../database/queries';
import { notifyUserStop } from '../services/trackPlayer';
import { colors, radii, withAlpha } from '../theme';

// ─── MiniPlayer ───────────────────────────────────────────────────────────────
// Props:
//   bottomOffset    — height of the tab bar (pixels from screen bottom)
//   stackNavigation — navigation object from the MainTabs stack screen,
//                     used to detect when Player is pushed on top so we can hide

const MiniPlayer = ({ bottomOffset = 0, stackNavigation }) => {
    const track                  = useActiveTrack();
    const { state }              = usePlaybackState();
    const { position, duration } = useProgress(500);
    const slideAnim              = useRef(new Animated.Value(120)).current;
    const swipeX                 = useRef(new Animated.Value(0)).current;

    const isPlaying = state === State.Playing;
    const isBusy    = state === State.Buffering || state === State.Loading;
    const hasTrack  = !!track;
    const [tabsActive, setTabsActive] = useState(true);
    // No userHasPlayed gate needed here — the parent (TabNavigator) only
    // mounts this component after onUserPlay fires, so we can trust that
    // intentional playback has already started by the time we render.

    // artwork: prefer the field baked into the track metadata; fall back to a
    // DB lookup in case the track was loaded before artwork was wired up.
    const [artworkUri, setArtworkUri] = useState(null);
    useEffect(() => {
        if (track?.artwork) {
            setArtworkUri(track.artwork);
        } else if (track?.id) {
            getEpisodeById(track.id).then(ep => {
                setArtworkUri(ep?.image_url || null);
            });
        } else {
            setArtworkUri(null);
        }
    }, [track?.id, track?.artwork]);

    // Hide when Player screen is pushed on top (blur on MainTabs stack screen),
    // show again when we come back (focus on MainTabs).
    useEffect(() => {
        if (!stackNavigation) return;
        const unsubBlur  = stackNavigation.addListener('blur',  () => setTabsActive(false));
        const unsubFocus = stackNavigation.addListener('focus', () => setTabsActive(true));
        return () => { unsubBlur(); unsubFocus(); };
    }, [stackNavigation]);

    // Slide up when visible, slide down when hidden.
    // hasLayout ensures the animation never starts before the component knows
    // its real rendered position (bottom offset). Without this, the spring
    // could begin while the layout is still being computed, causing a jump.
    const [hasLayout, setHasLayout] = useState(false);
    const activeState = state === State.Playing || state === State.Paused
                     || state === State.Buffering || state === State.Loading;
    const visible = hasTrack && tabsActive && activeState;
    useEffect(() => {
        if (!hasLayout) return;
        Animated.spring(slideAnim, {
            toValue:         visible ? 0 : 120,
            useNativeDriver: true,
            bounciness:      4,
            speed:           14,
        }).start();
    }, [visible, hasLayout]);

    const openPlayer = async () => {
        if (!track?.id || !stackNavigation) return;
        const episode = await getEpisodeById(track.id);
        if (episode) stackNavigation.navigate('Player', { episode });
    };

    const togglePlay = async () => {
        // fresh read — the usePlaybackState hook is {state: undefined} on the
        // first frames (dead first tap) and stays false while Buffering/Loading
        // (can't pause a stalled stream). Mirror PlayerControls.togglePlayback.
        try {
            const { state } = await TrackPlayer.getPlaybackState();
            if (state === State.Playing || state === State.Buffering || state === State.Loading) {
                await TrackPlayer.pause();
            } else {
                await TrackPlayer.play();
            }
        } catch (_) {}
    };

    const panResponder = useRef(PanResponder.create({
        // Don't claim on tap — let Pressable and buttons handle it
        onStartShouldSetPanResponder: () => false,
        // Claim only on clear horizontal swipe
        onMoveShouldSetPanResponder: (_, g) =>
            Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_, g) => swipeX.setValue(g.dx),
        onPanResponderRelease: (_, g) => {
            if (Math.abs(g.dx) > 80 || Math.abs(g.vx) > 0.5) {
                Animated.timing(swipeX, {
                    toValue: (g.dx > 0 ? 1 : -1) * 500,
                    duration: 180,
                    useNativeDriver: true,
                }).start(async () => {
                    // Persist the final position before reset wipes it.
                    // The PanResponder closure is from the first render, so
                    // read everything fresh from the player, not from hooks.
                    try {
                        const [{ position: pos }, activeTrack] = await Promise.all([
                            TrackPlayer.getProgress(),
                            TrackPlayer.getActiveTrack(),
                        ]);
                        if (activeTrack?.id && pos > 0) {
                            await savePlayPosition(activeTrack.id, Math.floor(pos));
                        }
                    } catch (_) {}
                    await TrackPlayer.reset();
                    notifyUserStop(); // unmounts MiniPlayer via App.js
                });
            } else {
                Animated.spring(swipeX, {
                    toValue: 0,
                    useNativeDriver: true,
                    bounciness: 6,
                }).start();
            }
        },
    })).current;

    const progress = duration > 0 ? position / duration : 0;

    return (
        <Animated.View
            onLayout={() => setHasLayout(true)}
            pointerEvents={visible ? 'auto' : 'none'}
            {...panResponder.panHandlers}
            style={[
                styles.wrapper,
                {
                    bottom:    bottomOffset + 8,
                    transform: [{ translateY: slideAnim }, { translateX: swipeX }],
                },
            ]}
        >
            <Pressable style={styles.card} onPress={openPlayer}>

                {/* Artwork */}
                {artworkUri ? (
                    <Image source={{ uri: artworkUri }} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkFallback]}>
                        <Icon name="headphones" size={14} color={withAlpha(colors.textPrimary, 0.4)} />
                    </View>
                )}

                {/* Metadata */}
                <View style={styles.meta}>
                    <Text style={styles.podcast} numberOfLines={1}>{track?.artist ?? ''}</Text>
                    <Text style={styles.title}   numberOfLines={1}>{track?.title  ?? ''}</Text>
                </View>

                {/* Right side: -10 · play/pause · expand */}
                <View style={styles.rightControls}>
                    <TouchableOpacity
                        onPress={async () => {
                            // fresh read — the useProgress(500) value lags
                            try {
                                const { position: pos } = await TrackPlayer.getProgress();
                                await TrackPlayer.seekTo(Math.max(0, pos - 10));
                            } catch (_) {}
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    >
                        <Icon name="rotate-ccw" size={22} color={withAlpha(colors.textPrimary, 0.75)} />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.playBtn}
                        onPress={togglePlay}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    >
                        {isBusy ? (
                            <ActivityIndicator size="small" color={colors.textPrimary} />
                        ) : (
                            <Icon
                                name={isPlaying ? 'pause' : 'play'}
                                size={20}
                                color={colors.textPrimary}
                                style={isPlaying ? undefined : { marginLeft: 2 }}
                            />
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        onPress={openPlayer}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 14 }}
                    >
                        <Icon name="chevron-up" size={26} color={withAlpha(colors.textPrimary, 0.5)} />
                    </TouchableOpacity>
                </View>

                {/* Playback progress stripe */}
                <View style={styles.progressBg} pointerEvents="none">
                    <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                </View>

            </Pressable>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    wrapper: {
        position:  'absolute',
        left:      8,
        right:     8,
        zIndex:    999,    // above tab bar on iOS
        elevation: 24,     // above tab bar on Android
    },
    card: {
        flexDirection:   'row',
        alignItems:      'center',
        backgroundColor: colors.surfaceElevated,
        borderRadius:    radii.l,
        paddingVertical: 14,
        paddingHorizontal: 14,
        gap:             12,
        borderWidth:     0.5,
        borderColor:     colors.hairline,
        shadowOffset:    { width: 0, height: 6 },
        shadowOpacity:   0.45,
        shadowRadius:    14,
        elevation:       12,
        overflow:        'hidden',
    },
    artwork: {
        width:           52,
        height:          52,
        borderRadius:    radii.s,
        backgroundColor: withAlpha(colors.textPrimary, 0.07),
    },
    artworkFallback: {
        alignItems:      'center',
        justifyContent:  'center',
    },
    rightControls: {
        flexDirection: 'row',
        alignItems:    'center',
        gap:           18,
    },
    playBtn: {
        width:           38,
        height:          38,
        borderRadius:    19,
        backgroundColor: withAlpha(colors.textPrimary, 0.12),
        alignItems:      'center',
        justifyContent:  'center',
    },
    meta: {
        flex: 1,
        gap:  3,
    },
    podcast: {
        fontSize:       11,
        fontWeight:     '700',
        color:          withAlpha(colors.textPrimary, 0.4),
        textTransform:  'uppercase',
        letterSpacing:  0.5,
    },
    title: {
        fontSize:      15,
        fontWeight:    '600',
        color:         colors.textPrimary,
        letterSpacing: -0.1,
    },
    progressBg: {
        position:        'absolute',
        bottom:          0,
        left:            0,
        right:           0,
        height:          2,
        backgroundColor: withAlpha(colors.textPrimary, 0.06),
    },
    progressFill: {
        height:          2,
        backgroundColor: colors.accent,
    },
});

export default MiniPlayer;
