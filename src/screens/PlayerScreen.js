import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { useProgress } from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import PlayerControls from '../components/PlayerControls';
import TranscriptHighlighter from '../components/TranscriptHighlighter';
import { loadEpisodeTrack } from '../services/trackPlayer';
import { getTranscriptsForEpisode, savePlayPosition } from '../database/queries';

const PlayerScreen = ({ route, navigation }) => {
    const { episode } = route.params;
    const [segments, setSegments] = useState([]);
    const [loadingStatus, setLoadingStatus] = useState('');
    const insets = useSafeAreaInsets();
    const positionSaveInterval = useRef(null);
    useProgress();

    useEffect(() => {
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
            await loadEpisodeTrack(episode, false);
            if (episode.play_position > 0) await TrackPlayer.seekTo(episode.play_position);
            if (episode.has_transcript) {
                setLoadingStatus('Loading transcript…');
                const transcriptData = await getTranscriptsForEpisode(episode.id);
                setSegments(transcriptData);
            }
            setLoadingStatus('');
            await TrackPlayer.play();
        } catch (e) {
            console.error('Playback setup failed', e);
            setLoadingStatus('');
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity
                    style={styles.backBtn}
                    onPress={() => navigation.goBack()}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Icon name="chevron-down" size={26} color="#AEAEB2" />
                </TouchableOpacity>
                <View style={styles.headerText}>
                    <Text style={styles.podcastName} numberOfLines={1}>
                        {episode.podcast_title}
                    </Text>
                    <Text style={styles.episodeTitle} numberOfLines={2}>
                        {episode.title}
                    </Text>
                </View>
            </View>

            {/* Transcript */}
            <View style={styles.transcriptArea}>
                <TranscriptHighlighter segments={segments} />

                {loadingStatus !== '' && (
                    <View style={styles.loadingBadge}>
                        <ActivityIndicator size="small" color="#4FACFE" />
                        <Text style={styles.loadingText}>{loadingStatus}</Text>
                    </View>
                )}
            </View>

            {/* Controls */}
            <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom + 8, 24) }]}>
                <PlayerControls />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0C0C0E',
    },

    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 16,
        gap: 14,
        borderBottomWidth: 0.5,
        borderBottomColor: 'rgba(255,255,255,0.06)',
    },
    backBtn: {
        paddingTop: 3,
    },
    headerText: {
        flex: 1,
        gap: 4,
    },
    podcastName: {
        fontSize: 11,
        fontWeight: '700',
        color: '#4FACFE',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
    },
    episodeTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: '#FFFFFF',
        lineHeight: 23,
        letterSpacing: -0.3,
    },

    transcriptArea: {
        flex: 1,
    },

    loadingBadge: {
        position: 'absolute',
        bottom: 16,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: 'rgba(20,20,22,0.96)',
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

    controls: {
        paddingTop: 16,
        backgroundColor: '#141416',
        borderTopWidth: 0.5,
        borderTopColor: 'rgba(255,255,255,0.07)',
    },
});

export default PlayerScreen;
