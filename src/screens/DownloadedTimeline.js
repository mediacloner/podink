import React, { useEffect, useState } from 'react';
import { View, FlatList, StyleSheet, Alert, Text } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useIsFocused } from '@react-navigation/native';
import EpisodeItem from '../components/EpisodeItem';
import { getDownloadedEpisodes, saveTranscripts, deleteEpisodeLocalData } from '../database/queries';
import { transcribeAudio, initializeWhisper } from '../services/whisperService';
import { deleteAudioFile } from '../services/downloadService';

const DownloadedTimeline = ({ navigation }) => {
    const [episodes, setEpisodes] = useState([]);
    const [isTranscribing, setIsTranscribing] = useState(null); // holds episode id being transcribed
    const [transcribeProgress, setTranscribeProgress] = useState(0);
    const isFocused = useIsFocused();

    useEffect(() => {
        if (isFocused) {
            loadData();
            // Pre-warm the whisper context so model is loaded before user taps Transcribe
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
        } catch(e) {
            console.log('Transcription failed', e);
            Alert.alert('Transcription Failed', 'Could not transcribe this episode. Check that the AI model is downloaded in Settings.');
        } finally {
            setIsTranscribing(null);
        }
    };

    const handleDelete = async (episode) => {
        Alert.alert("Delete Download", "Are you sure you want to remove this downloaded episode?", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: async () => {
                if (episode.local_audio_path) {
                    await deleteAudioFile(episode.local_audio_path);
                }
                await deleteEpisodeLocalData(episode.id);
                loadData();
            }}
        ]);
    };

    return (
        <View style={styles.container}>
            <FlatList
                data={episodes}
                keyExtractor={item => item.id.toString()}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>No downloaded episodes yet.</Text>
                        <Text style={styles.emptySubText}>Download episodes from the Timeline tab to listen offline.</Text>
                    </View>
                }
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
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#121212' },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, marginTop: 80 },
    emptyText: { color: '#fff', fontSize: 18, fontWeight: 'bold', textAlign: 'center', marginBottom: 10 },
    emptySubText: { color: '#888', fontSize: 14, textAlign: 'center', lineHeight: 20 }
});

export default DownloadedTimeline;
