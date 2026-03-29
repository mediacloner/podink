import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import TrackPlayer, { useProgress, State } from 'react-native-track-player';
import PlayerControls from '../components/PlayerControls';
import TranscriptHighlighter from '../components/TranscriptHighlighter';
import { loadEpisodeTrack } from '../services/trackPlayer';
import { getTranscriptsForEpisode, savePlayPosition } from '../database/queries';

const PlayerScreen = ({ route, navigation }) => {
    const { episode } = route.params;
    const [segments, setSegments] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const positionSaveInterval = useRef(null);
    const { position } = useProgress();

    useEffect(() => {
        setupPlayback();
        // Save playback position every 5 seconds
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
        setIsLoading(true);
        try {
            await loadEpisodeTrack(episode);

            // Restore last position if saved
            if (episode.play_position > 0) {
                await TrackPlayer.seekTo(episode.play_position);
            }

            if (episode.has_transcript) {
                const transcriptData = await getTranscriptsForEpisode(episode.id);
                setSegments(transcriptData);
            }
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.podcastName}>{episode.podcast_title}</Text>
                <Text style={styles.title} numberOfLines={2}>{episode.title}</Text>
            </View>

            <View style={styles.transcriptArea}>
                {isLoading ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color="#4a90e2" />
                        <Text style={styles.loadingText}>Loading audio…</Text>
                    </View>
                ) : (
                    <TranscriptHighlighter segments={segments} />
                )}
            </View>

            <View style={styles.controlsArea}>
                <PlayerControls />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    header: { padding: 24, paddingTop: 20, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    podcastName: { color: '#4a90e2', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
    title: { color: '#fff', fontSize: 20, fontWeight: 'bold', lineHeight: 26 },
    transcriptArea: { flex: 1 },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: { color: '#888', marginTop: 12, fontSize: 14 },
    controlsArea: { paddingVertical: 20, paddingBottom: 30, backgroundColor: '#111', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#222' }
});

export default PlayerScreen;
