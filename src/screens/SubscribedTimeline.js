import React, { useEffect, useRef, useState } from 'react';
import {
    View, FlatList, StyleSheet, TextInput,
    TouchableOpacity, Text, ActivityIndicator, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
    useSharedValue, useAnimatedStyle, withTiming, Easing,
} from 'react-native-reanimated';
import NetInfo from '@react-native-community/netinfo';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import { getSubscribedEpisodes, saveEpisode, updateEpisodeLocalPath, savePodcast } from '../database/queries';
import { downloadAudioFile } from '../services/downloadService';
import { fetchPodcastFeed } from '../api/rssParser';
import { resolveToRssUrl, detectService } from '../api/podcastResolver';

const PANEL_HEIGHT = 64; // inputRow height when open

const SubscribedTimeline = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes]             = useState([]);
    const [rssUrl, setRssUrl]                 = useState('');
    const [isFetching, setIsFetching]         = useState(false);
    const [isConnected, setIsConnected]       = useState(true);
    const [downloadingId, setDownloadingId]   = useState(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [panelOpen, setPanelOpen]           = useState(false);
    const inputRef = useRef(null);
    const isFocused = useIsFocused();

    const heightSV  = useSharedValue(0);
    const opacitySV = useSharedValue(0);

    const panelStyle = useAnimatedStyle(() => ({
        height:   heightSV.value,
        opacity:  opacitySV.value,
        overflow: 'hidden',
    }));

    const togglePanel = () => {
        if (panelOpen) {
            heightSV.value  = withTiming(0,           { duration: 220, easing: Easing.out(Easing.quad) });
            opacitySV.value = withTiming(0,           { duration: 180 });
            setPanelOpen(false);
            setRssUrl('');
        } else {
            heightSV.value  = withTiming(PANEL_HEIGHT, { duration: 220, easing: Easing.out(Easing.quad) });
            opacitySV.value = withTiming(1,            { duration: 220 });
            setPanelOpen(true);
            setTimeout(() => inputRef.current?.focus(), 240);
        }
    };

    useEffect(() => {
        const unsubscribe = NetInfo.addEventListener(state => {
            setIsConnected(state.isConnected);
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (isFocused) loadData();
    }, [isFocused]);

    useEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <TouchableOpacity
                    onPress={togglePanel}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={{ marginRight: 16 }}
                >
                    <Icon name={panelOpen ? 'x' : 'plus'} size={22} color="#4FACFE" />
                </TouchableOpacity>
            ),
        });
    }, [panelOpen]);

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
            const rss      = await resolveToRssUrl(rssUrl);
            const feedData = await fetchPodcastFeed(rss);
            await savePodcast({
                title:       feedData.title,
                description: feedData.description,
                feed_url:    rss,
                image_url:   feedData.image,
            });
            for (const ep of feedData.episodes) {
                await saveEpisode({
                    ...ep,
                    podcast_title:    feedData.title,
                    podcast_feed_url: rss,
                    description:      ep.description || '',
                    audio_url:        ep.enclosure,
                });
            }
            setRssUrl('');
            loadData();
            togglePanel();
        } catch (e) {
            Alert.alert('Could not add podcast', e.message || 'Check the link and try again.');
            console.error(e);
        } finally {
            setIsFetching(false);
        }
    };

    return (
        <View style={styles.container}>
            {/* Collapsible RSS input panel */}
            <Animated.View style={[styles.inputPanel, panelStyle]}>
                <View style={styles.inputRow}>
                    <View style={styles.inputWrap}>
                        <Icon name="rss" size={14} color="#636366" />
                        <TextInput
                            ref={inputRef}
                            style={styles.input}
                            placeholder="RSS, Apple Podcasts link…"
                            placeholderTextColor="#636366"
                            value={rssUrl}
                            onChangeText={setRssUrl}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="go"
                            onSubmitEditing={handleAddFeed}
                        />
                        {rssUrl.length > 0 && (() => {
                            const svc = detectService(rssUrl);
                            return (
                                <>
                                    {svc !== 'RSS' && (
                                        <View style={styles.serviceBadge}>
                                            <Text style={styles.serviceBadgeText}>{svc}</Text>
                                        </View>
                                    )}
                                    <TouchableOpacity onPress={() => setRssUrl('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                        <Icon name="x" size={14} color="#636366" />
                                    </TouchableOpacity>
                                </>
                            );
                        })()}
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
            </Animated.View>

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
                contentContainerStyle={episodes.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 50 }}
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

    inputPanel: {
        borderBottomWidth: 0.5,
        borderBottomColor: 'rgba(255,255,255,0.07)',
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 10,
        height: PANEL_HEIGHT,
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

    serviceBadge: {
        backgroundColor: 'rgba(79,172,254,0.12)',
        borderRadius: 8,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderWidth: 0.5,
        borderColor: 'rgba(79,172,254,0.25)',
    },
    serviceBadgeText: { fontSize: 11, fontWeight: '700', color: '#4FACFE' },

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
