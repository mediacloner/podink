import React, { useEffect, useState } from 'react';
import { View, FlatList, StyleSheet, Alert, Text } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import { getDownloadedEpisodes, saveTranscripts, deleteEpisodeLocalData } from '../database/queries';
import { transcribeAudio, initializeWhisper } from '../services/whisperService';
import { deleteAudioFile } from '../services/downloadService';

const DownloadedTimeline = ({ navigation }) => {
    const [episodes, setEpisodes]               = useState([]);
    const [isTranscribing, setIsTranscribing]   = useState(null);
    const [transcribeProgress, setTranscribeProgress] = useState(0);
    const isFocused = useIsFocused();

    useEffect(() => {
        if (isFocused) {
            loadData();
            initializeWhisper().catch(() => {});
        }
    }, [isFocused]);

    const loadData = async () => {
        const data = await getDownloadedEpisodes();
        setEpisodes(data);
    };

    const handleTranscribe = async (episode) => {
        if (!episode.local_audio_path) return;
        setIsTranscribing(episode.id);
        setTranscribeProgress(0);
        try {
            const segments = await transcribeAudio(episode.local_audio_path, (p) => setTranscribeProgress(p));
            await saveTranscripts(episode.id, segments);
            loadData();
        } catch (e) {
            Alert.alert(
                'Transcription Failed',
                'Could not transcribe this episode. Check that the AI model is downloaded in Settings.'
            );
        } finally {
            setIsTranscribing(null);
        }
    };

    const handleDelete = async (episode) => {
        Alert.alert('Delete Episode', 'Remove this episode from your library?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete', style: 'destructive', onPress: async () => {
                    if (episode.local_audio_path) await deleteAudioFile(episode.local_audio_path);
                    await deleteEpisodeLocalData(episode.id);
                    loadData();
                }
            }
        ]);
    };

    return (
        <View style={styles.container}>
            <FlatList
                data={episodes}
                keyExtractor={item => item.id.toString()}
                renderItem={({ item }) => (
                    <EpisodeItem
                        episode={item}
                        onPress={(ep) => navigation.navigate('Player', { episode: ep })}
                        onTranscribe={handleTranscribe}
                        onDelete={handleDelete}
                        isTranscribing={isTranscribing === item.id}
                        transcribeProgress={isTranscribing === item.id ? transcribeProgress : 0}
                    />
                )}
                contentContainerStyle={episodes.length === 0 ? { flex: 1 } : undefined}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        <View style={styles.emptyIcon}>
                            <Icon name="archive" size={26} color="#3A3A3C" />
                        </View>
                        <Text style={styles.emptyTitle}>Library is empty</Text>
                        <Text style={styles.emptySubtitle}>
                            Downloaded episodes appear here for offline listening
                        </Text>
                    </View>
                }
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0C0C0E' },

    empty: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 40,
        paddingTop: 80,
    },
    emptyIcon: {
        width: 64,
        height: 64,
        backgroundColor: '#141416',
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
    },
    emptyTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: '#FFFFFF',
        marginBottom: 8,
    },
    emptySubtitle: {
        fontSize: 14,
        color: '#636366',
        textAlign: 'center',
        lineHeight: 21,
    },
});

export default DownloadedTimeline;
