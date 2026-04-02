import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert, Animated, PanResponder,
    View, Text, FlatList, TouchableOpacity, StyleSheet, Image,
} from 'react-native';
import ReAnimated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import NetInfo from '@react-native-community/netinfo';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import {
    getPodcasts, deletePodcast,
    getNewEpisodesCountForPodcast, getLatestEpisodesForPodcast,
    markPodcastEpisodesAsSeen, capNewEpisodes, updateEpisodeLocalPath,
} from '../database/queries';
import { downloadAudioFile } from '../services/downloadService';
import {
    initializeWhisper, enqueueTranscription, onQueueChange, getQueueIds,
} from '../services/whisperService';

const DELETE_WIDTH = 80;
const SWIPE_THRESHOLD = 50;
const MAX_NEW = 5;

const SwipeableRow = ({ children, onDelete }) => {
    const translateX = useRef(new Animated.Value(0)).current;
    const [open, setOpen] = useState(false);

    const close = () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        setOpen(false);
    };

    const confirmDelete = () => {
        Animated.timing(translateX, { toValue: -400, duration: 200, useNativeDriver: true }).start(() => {
            onDelete();
        });
    };

    const panResponder = useRef(PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
            Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy * 1.5),
        onPanResponderMove: (_, g) => {
            const base = open ? -DELETE_WIDTH : 0;
            translateX.setValue(Math.max(Math.min(base + g.dx, 0), -DELETE_WIDTH));
        },
        onPanResponderRelease: (_, g) => {
            const delta = (open ? -DELETE_WIDTH : 0) + g.dx;
            if (delta < -SWIPE_THRESHOLD) {
                Animated.spring(translateX, { toValue: -DELETE_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
                setOpen(true);
            } else {
                close();
            }
        },
    })).current;

    return (
        <View style={s.swipeContainer}>
            <TouchableOpacity style={s.deleteAction} onPress={confirmDelete} activeOpacity={0.8}>
                <Icon name="trash-2" size={20} color="#fff" />
            </TouchableOpacity>
            <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
                {children}
            </Animated.View>
        </View>
    );
};

const PodcastsScreen = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [podcasts, setPodcasts]           = useState([]);
    const [newCountMap, setNewCountMap]     = useState({});
    const [expandedFeedUrl, _setExpanded]   = useState(null);
    const [episodesMap, setEpisodesMap]     = useState({});
    const [downloads, setDownloads]         = useState({});   // { [episodeId]: progress 0-100 }
    const [activeId, setActiveId]           = useState(null); // transcribing episode id
    const [queuedIds, setQueuedIds]         = useState([]);
    const [progressMap, setProgressMap]     = useState({});   // { [episodeId]: 0-99 }
    const [isConnected, setIsConnected]     = useState(true);
    const expandedRef                       = useRef(null);
    const isFocused                         = useIsFocused();

    const setExpanded = (val) => {
        expandedRef.current = val;
        _setExpanded(val);
    };

    useEffect(() => {
        const unsub = NetInfo.addEventListener(state => setIsConnected(state.isConnected));
        return () => unsub();
    }, []);

    const syncQueue = useCallback(() => setQueuedIds(getQueueIds()), []);
    useEffect(() => {
        const unsub = onQueueChange(syncQueue);
        return unsub;
    }, [syncQueue]);

    useEffect(() => {
        if (isFocused) {
            loadPodcasts();
            initializeWhisper().catch(() => {});
        } else {
            const feedUrl = expandedRef.current;
            if (feedUrl) {
                markPodcastEpisodesAsSeen(feedUrl).catch(() => {});
                setNewCountMap(prev => ({ ...prev, [feedUrl]: 0 }));
                setExpanded(null);
            }
        }
    }, [isFocused]);

    const loadPodcasts = async () => {
        const data = await getPodcasts();
        setPodcasts(data);
        const counts = {};
        await Promise.all(data.map(async p => {
            await capNewEpisodes(p.feed_url, MAX_NEW);
            counts[p.feed_url] = await getNewEpisodesCountForPodcast(p.feed_url);
        }));
        setNewCountMap(counts);
    };

    const handleToggleExpand = async (podcast) => {
        if (expandedRef.current === podcast.feed_url) {
            // Collapse + mark as seen
            setExpanded(null);
            setNewCountMap(prev => ({ ...prev, [podcast.feed_url]: 0 }));
            markPodcastEpisodesAsSeen(podcast.feed_url).catch(() => {});
        } else {
            // Load episodes then expand
            let eps = episodesMap[podcast.feed_url];
            if (!eps) {
                eps = await getLatestEpisodesForPodcast(podcast.feed_url, MAX_NEW);
            }
            setEpisodesMap(prev => ({ ...prev, [podcast.feed_url]: eps }));
            setExpanded(podcast.feed_url);
        }
    };

    const handleUnsubscribe = async (podcast) => {
        if (expandedRef.current === podcast.feed_url) setExpanded(null);
        await deletePodcast(podcast.feed_url);
        loadPodcasts();
    };

    const refreshEpisodesFor = async (feedUrl) => {
        const eps = await getLatestEpisodesForPodcast(feedUrl, MAX_NEW);
        setEpisodesMap(prev => ({ ...prev, [feedUrl]: eps }));
    };

    const handleDownload = useCallback(async (episode) => {
        if (!isConnected) {
            Alert.alert('Offline', 'You need an internet connection to download episodes.');
            return;
        }
        if (!episode.audio_url) return;
        const safeId = episode.id.toString().replace(/[^a-zA-Z0-9]/g, '_');
        setDownloads(prev => ({ ...prev, [episode.id]: 0 }));
        try {
            const localPath = await downloadAudioFile(
                episode.audio_url,
                `episode_${safeId}.mp3`,
                (p) => setDownloads(prev => ({ ...prev, [episode.id]: p })),
            );
            await updateEpisodeLocalPath(episode.id, localPath);
            await refreshEpisodesFor(episode.podcast_feed_url);
        } catch (e) {
            Alert.alert('Error', 'Failed to download episode.');
        } finally {
            setDownloads(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
        }
    }, [isConnected]);

    const handleTranscribe = useCallback(async (episode) => {
        if (!episode.local_audio_path) return;
        const id = episode.id;
        setProgressMap(prev => ({ ...prev, [id]: 0 }));
        try {
            await enqueueTranscription(
                id,
                episode.local_audio_path,
                (p) => setProgressMap(prev => ({ ...prev, [id]: p })),
                ()  => setActiveId(id),
            );
            await refreshEpisodesFor(episode.podcast_feed_url);
        } catch (e) {
            if (e.message !== 'Cancelled' && e.message !== 'Already queued') {
                Alert.alert('Transcription Failed', 'Could not transcribe this episode. Make sure the AI model is downloaded in Settings.');
            }
        } finally {
            setActiveId(prev => prev === id ? null : prev);
            setProgressMap(prev => { const n = { ...prev }; delete n[id]; return n; });
        }
    }, []);

    const renderPodcast = ({ item }) => {
        const newCount = newCountMap[item.feed_url] ?? 0;
        const isExpanded = expandedFeedUrl === item.feed_url;
        const episodes = episodesMap[item.feed_url] ?? [];

        return (
            <View>
                <SwipeableRow onDelete={() => handleUnsubscribe(item)}>
                    <TouchableOpacity
                        onPress={() => handleToggleExpand(item)}
                        activeOpacity={1}
                        style={styles.row}
                    >
                        {item.image_url ? (
                            <Image source={{ uri: item.image_url }} style={styles.artwork} />
                        ) : (
                            <View style={[styles.artwork, styles.artworkPlaceholder]}>
                                <Icon name="headphones" size={22} color="#3A3A3C" />
                            </View>
                        )}

                        <View style={styles.info}>
                            <Text style={styles.podcastTitle} numberOfLines={1}>{item.title}</Text>
                            {newCount > 0 ? (
                                <View style={styles.dotsRow}>
                                    {Array.from({ length: newCount }).map((_, i) => (
                                        <View key={i} style={styles.dot} />
                                    ))}
                                </View>
                            ) : (
                                <Text style={styles.podcastDesc} numberOfLines={1}>
                                    {item.description?.replace(/<[^>]+>/g, '') || ''}
                                </Text>
                            )}
                        </View>

                        {newCount > 0 && (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>{newCount}</Text>
                            </View>
                        )}

                        <Icon
                            name={isExpanded ? 'chevron-up' : 'chevron-down'}
                            size={16}
                            color="#636366"
                            style={{ marginLeft: 6 }}
                        />
                    </TouchableOpacity>
                </SwipeableRow>

                {isExpanded && (
                <ReAnimated.View
                    entering={FadeInDown.duration(220).springify()}
                    exiting={FadeOut.duration(160)}
                    style={styles.episodeGroup}
                >
                {episodes.map(ep => (
                    <EpisodeItem
                        key={ep.id}
                        episode={ep}
                        onPress={ep => navigation.navigate('Player', { episode: ep })}
                        cardStyle={styles.episodeCard}
                        onDownload={handleDownload}
                        onTranscribe={handleTranscribe}
                        isDownloading={ep.id in downloads}
                        downloadProgress={downloads[ep.id] ?? 0}
                        isTranscribing={activeId === ep.id}
                        transcribeProgress={progressMap[ep.id] ?? 0}
                        isQueued={queuedIds.includes(ep.id) && activeId !== ep.id}
                    />
                ))}
                </ReAnimated.View>
                )}
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <FlatList
                data={podcasts}
                keyExtractor={item => item.id.toString()}
                renderItem={renderPodcast}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                contentContainerStyle={podcasts.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 130 }}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        <View style={styles.emptyIcon}>
                            <Icon name="headphones" size={28} color="#3A3A3C" />
                        </View>
                        <Text style={styles.emptyTitle}>No podcasts yet</Text>
                        <Text style={styles.emptySubtitle}>
                            Add an RSS feed from the Discover tab to subscribe
                        </Text>
                    </View>
                }
            />
        </View>
    );
};

const s = StyleSheet.create({
    swipeContainer: { position: 'relative', overflow: 'hidden' },
    deleteAction: {
        position: 'absolute',
        right: 0, top: 0, bottom: 0,
        width: DELETE_WIDTH,
        backgroundColor: '#FF453A',
        alignItems: 'center',
        justifyContent: 'center',
    },
});

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0C0C0E' },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 14,
        backgroundColor: '#0C0C0E',
    },
    artwork: {
        width: 64,
        height: 64,
        borderRadius: 12,
        marginRight: 14,
        backgroundColor: '#1A1A1C',
    },
    artworkPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    info: { flex: 1, gap: 4 },
    podcastTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#FFFFFF',
    },
    podcastDesc: {
        fontSize: 13,
        color: '#636366',
        lineHeight: 18,
    },

    dotsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 2,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 3.5,
        backgroundColor: '#FF453A',
    },

    badge: {
        minWidth: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: '#FF453A',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
        marginLeft: 8,
    },
    badgeText: {
        fontSize: 12,
        fontWeight: '700',
        color: '#fff',
    },

    episodeGroup: {
        marginLeft: 16,
        backgroundColor: '#1C1C1E',
        borderLeftWidth: 2,
        borderLeftColor: '#4FACFE',
    },
    episodeCard: {
        backgroundColor: '#1C1C1E',
    },

    separator: {
        height: 0.5,
        backgroundColor: 'rgba(255,255,255,0.06)',
        marginLeft: 98,
    },

    empty: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 40,
        paddingTop: 80,
    },
    emptyIcon: {
        width: 72,
        height: 72,
        backgroundColor: '#141416',
        borderRadius: 36,
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

export default PodcastsScreen;
