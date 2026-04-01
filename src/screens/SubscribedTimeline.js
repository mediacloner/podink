import React, { useEffect, useState } from 'react';
import {
    View, FlatList, StyleSheet, TextInput,
    TouchableOpacity, Text, ActivityIndicator, Alert,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import { getSubscribedEpisodes, saveEpisode, updateEpisodeLocalPath, savePodcast } from '../database/queries';
import { downloadAudioFile } from '../services/downloadService';
import { fetchPodcastFeed } from '../api/rssParser';

const SubscribedTimeline = ({ navigation }) => {
    const [episodes, setEpisodes]             = useState([]);
    const [rssUrl, setRssUrl]                 = useState('');
    const [isFetching, setIsFetching]         = useState(false);
    const [isConnected, setIsConnected]       = useState(true);
    const [downloadingId, setDownloadingId]   = useState(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const isFocused = useIsFocused();

    useEffect(() => {
        const unsubscribe = NetInfo.addEventListener(state => {
            setIsConnected(state.isConnected);
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (isFocused) loadData();
    }, [isFocused]);

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
        const safeId   = episode.id.toString().replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `episode_${safeId}.mp3`;
        setDownloadingId(episode.id);
        setDownloadProgress(0);
        try {
            const localPath = await downloadAudioFile(episode.audio_url, filename, (p) => setDownloadProgress(p));
            await updateEpisodeLocalPath(episode.id, localPath);
            loadData();
        } catch (e) {
            console.error('Download failed', e);
            Alert.alert('Error', 'Failed to download episode.');
        } finally {
            setDownloadingId(null);
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
            await savePodcast({
                title:       feedData.title,
                description: feedData.description,
                feed_url:    rssUrl.trim(),
                image_url:   feedData.image,
            });
            for (const ep of feedData.episodes) {
                await saveEpisode({
                    ...ep,
                    podcast_title:    feedData.title,
                    podcast_feed_url: rssUrl.trim(),
                    description:      ep.description || '',
                    audio_url:        ep.enclosure,
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
            {/* RSS input bar */}
            <View style={styles.inputRow}>
                <View style={styles.inputWrap}>
                    <Icon name="rss" size={14} color="#636366" style={styles.inputIcon} />
                    <TextInput
                        style={styles.input}
                        placeholder="Paste RSS feed URL…"
                        placeholderTextColor="#636366"
                        value={rssUrl}
                        onChangeText={setRssUrl}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="go"
                        onSubmitEditing={handleAddFeed}
                    />
                    {rssUrl.length > 0 && (
                        <TouchableOpacity onPress={() => setRssUrl('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Icon name="x" size={14} color="#636366" />
                        </TouchableOpacity>
                    )}
                </View>
                <TouchableOpacity
                    style={[styles.addBtn, (!isConnected || isFetching || !rssUrl.trim()) && styles.addBtnDisabled]}
                    onPress={handleAddFeed}
                    disabled={isFetching || !isConnected}
                >
                    {isFetching
                        ? <ActivityIndicator color="#fff" size="small" />
                        : <Text style={styles.addBtnText}>Add</Text>
                    }
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
                        isDownloading={downloadingId === item.id}
                        downloadProgress={downloadingId === item.id ? downloadProgress : 0}
                    />
                )}
                contentContainerStyle={episodes.length === 0 ? { flex: 1 } : undefined}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        <View style={styles.emptyIcon}>
                            <Icon name="radio" size={26} color="#3A3A3C" />
                        </View>
                        <Text style={styles.emptyTitle}>No episodes yet</Text>
                        <Text style={styles.emptySubtitle}>
                            Add a podcast RSS feed above to start discovering episodes
                        </Text>
                    </View>
                }
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0C0C0E' },

    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 10,
        borderBottomWidth: 0.5,
        borderBottomColor: 'rgba(255,255,255,0.07)',
    },
    inputWrap: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#141416',
        borderRadius: 12,
        paddingHorizontal: 14,
        height: 44,
        borderWidth: 0.5,
        borderColor: 'rgba(255,255,255,0.08)',
        gap: 8,
    },
    inputIcon: {},
    input: {
        flex: 1,
        color: '#FFFFFF',
        fontSize: 14,
        height: '100%',
    },
    addBtn: {
        backgroundColor: '#4FACFE',
        paddingHorizontal: 20,
        height: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 64,
    },
    addBtnDisabled: { opacity: 0.4 },
    addBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

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

export default SubscribedTimeline;
