import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, Text, ActivityIndicator } from 'react-native';
import TrackPlayer, { useProgress } from 'react-native-track-player';
import PlayerControls from '../components/PlayerControls';
import TranscriptHighlighter from '../components/TranscriptHighlighter';
import { loadEpisodeTrack } from '../services/trackPlayer';
import { getTranscriptsForEpisode, savePlayPosition } from '../database/queries';

const PlayerScreen = ({ route }) => {
    const { episode } = route.params;
    const [segments, setSegments] = useState([]);
    const [loadingStatus, setLoadingStatus] = useState(''); // '' = ready
    const positionSaveInterval = useRef(null);
    useProgress(); // keep hook alive for TrackPlayer context

    useEffect(() => {
        setupPlayback();
        positionSaveInterval.current = setInterval(async () => {
            const pos = await TrackPlayer.getPosition();
            if (pos > 0) {
                await savePlayPosition(episode.id, Math.floor(pos));
            }
        }, 5000);

        return () => {
            if (positionSaveInterval.current) {
                clearInterval(positionSaveInterval.current);
            }
        };
    }, [episode]);

    const setupPlayback = async () => {
        try {
            // Step 1: Queue the track but do NOT play yet
            setLoadingStatus('Preparing audio…');
            await loadEpisodeTrack(episode, false); // autoPlay = false

            if (episode.play_position > 0) {
                await TrackPlayer.seekTo(episode.play_position);
            }

            // Step 2: Load transcript if available
            if (episode.has_transcript) {
                setLoadingStatus('Loading transcript…');
                const transcriptData = await getTranscriptsForEpisode(episode.id);
                setSegments(transcriptData);
            }

            // Step 3: Everything ready — start playing now
            setLoadingStatus('');
            await TrackPlayer.play();
        } catch (e) {
            console.error('Playback setup failed', e);
            setLoadingStatus('');
        }
    };

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.podcastName}>{episode.podcast_title}</Text>
                <Text style={styles.title} numberOfLines={2}>{episode.title}</Text>
            </View>

            {/* Transcript area — always visible, loading indicator overlaid on top */}
            <View style={styles.transcriptArea}>
                <TranscriptHighlighter segments={segments} />

                {/* Small non-blocking loading badge while audio initialises */}
                {loadingStatus !== '' && (
                    <View style={styles.loadingBadge}>
                        <ActivityIndicator size="small" color="#4a90e2" />
                        <Text style={styles.loadingText}>{loadingStatus}</Text>
                    </View>
                )}
            </View>

            {/* Player controls */}
            <View style={styles.controlsArea}>
                <PlayerControls />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0a0a0a',
    },
    header: {
        padding: 24,
        paddingTop: 20,
        borderBottomWidth: 1,
        borderBottomColor: '#1a1a1a',
    },
    podcastName: {
        color: '#4a90e2',
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 6,
    },
    title: {
        color: '#fff',
        fontSize: 20,
        fontWeight: 'bold',
        lineHeight: 26,
    },
    transcriptArea: {
        flex: 1,
    },
    // Subtle pill badge instead of blocking the whole transcript area
    loadingBadge: {
        position: 'absolute',
        bottom: 16,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: 'rgba(10,10,10,0.85)',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#222',
    },
    loadingText: {
        color: '#888',
        fontSize: 13,
    },
    controlsArea: {
        paddingVertical: 20,
        paddingBottom: 30,
        backgroundColor: '#111',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: '#222',
    },
});

export default PlayerScreen;
