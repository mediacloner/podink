import React, { useEffect, useRef, useState } from 'react';
import {
    View, Text, Image, TouchableOpacity,
    StyleSheet, Animated, Pressable,
} from 'react-native';
import TrackPlayer, {
    useActiveTrack, usePlaybackState, useProgress, State,
} from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import { getEpisodeById } from '../database/queries';

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

    const isPlaying     = state === State.Playing;
    const hasTrack      = !!track;
    const [tabsActive, setTabsActive] = useState(true);

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
    const visible = hasTrack && tabsActive;
    useEffect(() => {
        Animated.spring(slideAnim, {
            toValue:         visible ? 0 : 120,
            useNativeDriver: true,
            bounciness:      4,
            speed:           14,
        }).start();
    }, [visible]);

    const openPlayer = async () => {
        if (!track?.id || !stackNavigation) return;
        const episode = await getEpisodeById(track.id);
        if (episode) stackNavigation.navigate('Player', { episode });
    };

    const togglePlay = async () => {
        isPlaying ? await TrackPlayer.pause() : await TrackPlayer.play();
    };

    const progress = duration > 0 ? position / duration : 0;

    return (
        <Animated.View
            pointerEvents={visible ? 'box-none' : 'none'}
            style={[
                styles.wrapper,
                {
                    bottom:    bottomOffset + 8,
                    transform: [{ translateY: slideAnim }],
                },
            ]}
        >
            <Pressable style={styles.card} onPress={openPlayer}>

                {/* Artwork */}
                {artworkUri ? (
                    <Image source={{ uri: artworkUri }} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkFallback]}>
                        <Icon name="headphones" size={14} color="rgba(255,255,255,0.4)" />
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
                        onPress={() => TrackPlayer.seekTo(Math.max(0, position - 10))}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    >
                        <Icon name="rotate-ccw" size={18} color="rgba(255,255,255,0.75)" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.playBtn}
                        onPress={togglePlay}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    >
                        <Icon
                            name={isPlaying ? 'pause' : 'play'}
                            size={16}
                            color="#FFFFFF"
                            style={isPlaying ? undefined : { marginLeft: 2 }}
                        />
                    </TouchableOpacity>

                    <TouchableOpacity
                        onPress={openPlayer}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 14 }}
                    >
                        <Icon name="chevron-up" size={22} color="rgba(255,255,255,0.5)" />
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
        backgroundColor: '#1C1B22',
        borderRadius:    16,
        paddingVertical: 10,
        paddingHorizontal: 12,
        gap:             10,
        borderWidth:     0.5,
        borderColor:     'rgba(255,255,255,0.1)',
        shadowColor:     '#000',
        shadowOffset:    { width: 0, height: 6 },
        shadowOpacity:   0.45,
        shadowRadius:    14,
        elevation:       12,
        overflow:        'hidden',
    },
    artwork: {
        width:           42,
        height:          42,
        borderRadius:    8,
        backgroundColor: 'rgba(255,255,255,0.07)',
    },
    artworkFallback: {
        alignItems:      'center',
        justifyContent:  'center',
    },
    rightControls: {
        flexDirection: 'row',
        alignItems:    'center',
        gap:           16,
    },
    playBtn: {
        width:           30,
        height:          30,
        borderRadius:    15,
        backgroundColor: 'rgba(255,255,255,0.12)',
        alignItems:      'center',
        justifyContent:  'center',
    },
    meta: {
        flex: 1,
        gap:  2,
    },
    podcast: {
        fontSize:       10,
        fontWeight:     '700',
        color:          'rgba(255,255,255,0.4)',
        textTransform:  'uppercase',
        letterSpacing:  0.5,
    },
    title: {
        fontSize:      13,
        fontWeight:    '600',
        color:         '#FFFFFF',
        letterSpacing: -0.1,
    },
    progressBg: {
        position:        'absolute',
        bottom:          0,
        left:            0,
        right:           0,
        height:          2,
        backgroundColor: 'rgba(255,255,255,0.06)',
    },
    progressFill: {
        height:          2,
        backgroundColor: '#4FACFE',
    },
});

export default MiniPlayer;
