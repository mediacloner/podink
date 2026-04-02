import React, { useEffect, useState, useRef } from 'react';
import {
    View, StyleSheet, Text, Image,
    ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { useProgress } from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import PlayerControls from '../components/PlayerControls';
import TranscriptHighlighter from '../components/TranscriptHighlighter';
import { loadEpisodeTrack } from '../services/trackPlayer';
import { getTranscriptsForEpisode, savePlayPosition } from '../database/queries';
import { extractColor } from '../services/colorExtractor';

// ─── Theme ────────────────────────────────────────────────────────────────────

const DARK = '#0B0A11'; // deep dark base — richer than pure black

// ─── Screen ───────────────────────────────────────────────────────────────────

const PlayerScreen = ({ route, navigation }) => {
    const { episode } = route.params;
    const [segments, setSegments]           = useState([]);
    const [loadingStatus, setLoadingStatus] = useState('');
    const [colorInfo, setColorInfo]         = useState(null);
    const insets = useSafeAreaInsets();
    const positionSaveInterval = useRef(null);
    useProgress();

    useEffect(() => {
        if (episode.image_url) {
            extractColor(episode.image_url).then(info => {
                if (info) setColorInfo(info);
            });
        }
        setupPlayback();
        positionSaveInterval.current = setInterval(async () => {
            const pos = await TrackPlayer.getPosition();
            if (pos > 0) await savePlayPosition(episode.id, Math.floor(pos));
        }, 5000);
        return () => clearInterval(positionSaveInterval.current);
    }, [episode]);

    const setupPlayback = async () => {
        try {
            setLoadingStatus('Preparing audio…');

            // Skip track reload if this episode is already the active track.
            // This happens when opening the full player from the mini player while
            // audio is already playing — we just want to show the UI, not restart.
            const currentTrack   = await TrackPlayer.getActiveTrack();
            const alreadyLoaded  = currentTrack?.id === episode.id;

            if (!alreadyLoaded) {
                await loadEpisodeTrack(episode, false);
                if (episode.play_position > 0) await TrackPlayer.seekTo(episode.play_position);
            }

            if (episode.has_transcript) {
                setLoadingStatus('Loading transcript…');
                const transcriptData = await getTranscriptsForEpisode(episode.id);
                setSegments(transcriptData);
            }
            setLoadingStatus('');

            if (!alreadyLoaded) await TrackPlayer.play();
        } catch (e) {
            console.error('Playback setup failed', e);
            setLoadingStatus('');
        }
    };

    const headerBg = colorInfo?.bgColor ?? '#1A1628';

    return (
        <View style={styles.root}>

            {/* ── Header — solid single colour, compact row ─────────────── */}
            <View
                style={[
                    styles.header,
                    { backgroundColor: headerBg, paddingTop: insets.top + 8 },
                ]}
            >
                {episode.image_url ? (
                    <Image source={{ uri: episode.image_url }} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkPlaceholder]}>
                        <Icon name="headphones" size={20} color="rgba(255,255,255,0.25)" />
                    </View>
                )}

                <View style={styles.meta}>
                    <Text style={styles.podcastName} numberOfLines={1}>
                        {episode.podcast_title}
                    </Text>
                    <Text style={styles.episodeTitle} numberOfLines={2}>
                        {episode.title}
                    </Text>
                </View>

            </View>

            {/* ── Transcript ────────────────────────────────────────────── */}
            <View style={styles.transcriptArea}>
                <TranscriptHighlighter
                    segments={segments}
                    fadeTo={DARK}
                    textTheme="dark"
                />

                {loadingStatus !== '' && (
                    <View style={styles.loadingBadge}>
                        <ActivityIndicator size="small" color="#4FACFE" />
                        <Text style={styles.loadingText}>{loadingStatus}</Text>
                    </View>
                )}
            </View>

            {/* ── Controls ──────────────────────────────────────────────── */}
            <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom + 8, 24) }]}>
                <TouchableOpacity
                    onPress={() => navigation.goBack()}
                    style={styles.dismissBtn}
                    hitSlop={{ top: 10, bottom: 10, left: 40, right: 40 }}
                >
                    <Icon name="chevron-down" size={28} color="rgba(255,255,255,0.5)" />
                </TouchableOpacity>
                <PlayerControls />
            </View>

        </View>
    );
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: DARK,
    },

    // ── Header ────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 26,
        paddingRight: 18,
        paddingBottom: 14,
        gap: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 6,
    },
    artwork: {
        width: 52,
        height: 52,
        borderRadius: 10,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    artworkPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    meta: {
        flex: 1,
        gap: 3,
    },
    podcastName: {
        fontSize: 11,
        fontWeight: '700',
        color: 'rgba(255,255,255,0.6)',
        textTransform: 'uppercase',
        letterSpacing: 0.7,
        textShadowColor: 'rgba(0,0,0,0.35)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    episodeTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: '#FFFFFF',
        lineHeight: 19,
        letterSpacing: -0.1,
        textShadowColor: 'rgba(0,0,0,0.35)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },

    // ── Transcript ────────────────────────────────────────────
    transcriptArea: {
        flex: 1,
        backgroundColor: DARK,
    },
    loadingBadge: {
        position: 'absolute',
        bottom: 16,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: 'rgba(11,10,17,0.92)',
        paddingHorizontal: 16,
        paddingVertical: 9,
        borderRadius: 22,
        borderWidth: 0.5,
        borderColor: 'rgba(255,255,255,0.09)',
    },
    loadingText: {
        fontSize: 13,
        color: '#AEAEB2',
    },

    // ── Controls ──────────────────────────────────────────────
    controls: {
        paddingTop: 8,
        backgroundColor: DARK,
        borderTopWidth: 0.5,
        borderTopColor: 'rgba(255,255,255,0.06)',
    },
    dismissBtn: {
        alignSelf: 'center',
        paddingVertical: 4,
        marginBottom: 0,
    },
});

export default PlayerScreen;
