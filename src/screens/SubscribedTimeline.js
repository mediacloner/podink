import React, { useEffect, useState } from 'react';
import { View, FlatList, StyleSheet, TextInput, TouchableOpacity, Text, ActivityIndicator, Alert } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import EpisodeItem from '../components/EpisodeItem';
import { getSubscribedEpisodes, saveEpisode, updateEpisodeLocalPath, savePodcast } from '../database/queries';
import { downloadAudioFile } from '../services/downloadService';
import { fetchPodcastFeed } from '../api/rssParser';

const SubscribedTimeline = ({ navigation }) => {
    const [episodes, setEpisodes] = useState([]);
    const [rssUrl, setRssUrl] = useState('');
    const [isFetching, setIsFetching] = useState(false);
    const [isConnected, setIsConnected] = useState(true);

    useEffect(() => {
        loadData();
        const unsubscribe = NetInfo.addEventListener(state => {
            setIsConnected(state.isConnected);
        });
        return () => unsubscribe();
    }, []);

    const loadData = async () => {
        try {
            const data = await getSubscribedEpisodes();
            setEpisodes(data);
        } catch (e) {
            console.error('Failed fetching subscriptions from DB');
        }
    };

    const handleDownload = async (episode) => {
        if (!isConnected) {
            Alert.alert('Offline', 'You need an internet connection to download episodes.');
            return;
        }
        if (!episode.audio_url) return;
        
        const filename = `episode_${episode.id}.mp3`;
        
        try {
            const localPath = await downloadAudioFile(episode.audio_url, filename);
            await updateEpisodeLocalPath(episode.id, localPath);
            loadData();
        } catch (e) {
            console.error('Download failed', e);
            Alert.alert('Error', 'Failed to download episode.');
        }
    };

    const handleAddFeed = async () => {
        if (!isConnected) {
            Alert.alert('Offline', 'You need an internet connection to add a feed.');
            return;
        }
        if (!rssUrl.trim()) return;
        setIsFetching(true);
        try {
            const feedData = await fetchPodcastFeed(rssUrl.trim());
            // Save the podcast-level metadata first
            await savePodcast({
                title: feedData.title,
                description: feedData.description,
                feed_url: rssUrl.trim(),
                image_url: feedData.image,
            });
            // Then save all episodes
            for (const ep of feedData.episodes) {
                await saveEpisode({
                    ...ep,
                    podcast_title: feedData.title,
                    podcast_feed_url: rssUrl.trim(),
                    description: ep.description || '',
                    audio_url: ep.enclosure,
                });
            }
            setRssUrl('');
            loadData();
        } catch (e) {
            Alert.alert('Error', 'Could not fetch or parse the RSS feed.');
            console.error(e);
        } finally {
            setIsFetching(false);
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.headerForm}>
                <TextInput 
                    style={styles.input} 
                    placeholder="Enter RSS Feed URL..." 
                    placeholderTextColor="#888"
                    value={rssUrl}
                    onChangeText={setRssUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
                <TouchableOpacity
                    style={[styles.addButton, (!isConnected || isFetching) && styles.addButtonDisabled]}
                    onPress={handleAddFeed}
                    disabled={isFetching || !isConnected}
                >
                    {isFetching ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.addText}>Add</Text>}
                </TouchableOpacity>
            </View>
            <FlatList
                data={episodes}
                keyExtractor={item => item.id.toString()}
                renderItem={({ item }) => (
                    <EpisodeItem 
                        episode={item}
                        onPress={(ep) => navigation.navigate('Player', { episode: ep })}
                        onDownload={handleDownload}
                    />
                )}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#121212' },
    headerForm: { flexDirection: 'row', padding: 15, borderBottomWidth: 1, borderBottomColor: '#222', alignItems: 'center' },
    input: { flex: 1, backgroundColor: '#1e1e1e', color: '#fff', borderRadius: 8, paddingHorizontal: 15, paddingVertical: 10, marginRight: 10 },
    addButton: { backgroundColor: '#4a90e2', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8 },
    addButtonDisabled: { backgroundColor: '#2a4a72', opacity: 0.6 },
    addText: { color: '#fff', fontWeight: 'bold' }
});

export default SubscribedTimeline;
