import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View, FlatList, StyleSheet, TextInput,
    TouchableOpacity, Text, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
    useSharedValue, useAnimatedStyle, withTiming, Easing,
} from 'react-native-reanimated';
import NetInfo from '@react-native-community/netinfo';
import { showAlert } from '../components/AppAlert';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import EmptyState from '../components/EmptyState';
import {
    getSubscribedEpisodes, saveEpisodesBatch, updateEpisodeLocalPath, savePodcast,
    getPodcasts, pruneOldEpisodesForPodcast, capNewEpisodes,
} from '../database/queries';
import { downloadAudioFile } from '../services/downloadService';
import { fetchPodcastFeed } from '../api/rssParser';
import { resolveToRssUrl, detectService } from '../api/podcastResolver';
import { notifyLibraryChange } from '../services/libraryEvents';
import { log } from '../services/logService';
import { colors, withAlpha, type } from '../theme';

const PANEL_HEIGHT = 64; // inputRow height when open
const MAX_EPISODES_PER_PODCAST = 50;

const SubscribedTimeline = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes] = useState([]);
    const [rssUrl, setRssUrl] = useState('');
    const [isFetching, setIsFetching] = useState(false);
    const [isConnected, setIsConnected] = useState(true);
    // { [episodeId]: progress 0-100 }  — supports concurrent downloads
    const [downloads, setDownloads] = useState({});
    const [panelOpen, setPanelOpen] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const inputRef = useRef(null);
    const hasRefreshedOnMount = useRef(false);
    const isFocused = useIsFocused();

    const heightSV = useSharedValue(0);
    const opacitySV = useSharedValue(0);

    const panelStyle = useAnimatedStyle(() => ({
        height: heightSV.value,
        opacity: opacitySV.value,
        overflow: 'hidden',
    }));

    const togglePanel = () => {
        if (panelOpen) {
            heightSV.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.quad) });
            opacitySV.value = withTiming(0, { duration: 180 });
            setPanelOpen(false);
            setRssUrl('');
        } else {
            heightSV.value = withTiming(PANEL_HEIGHT, { duration: 220, easing: Easing.out(Easing.quad) });
            opacitySV.value = withTiming(1, { duration: 220 });
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
        if (isFocused) {
            loadData();
            if (!hasRefreshedOnMount.current) {
                hasRefreshedOnMount.current = true;
                handleRefresh(false);
            }
        }
    }, [isFocused]);

    useEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <TouchableOpacity
                    onPress={togglePanel}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    style={{ marginRight: 16 }}
                    accessibilityRole="button"
                    accessibilityLabel={panelOpen ? 'Close add-feed panel' : 'Add a podcast feed'}
                >
                    <Icon name={panelOpen ? 'x' : 'plus'} size={22} color={colors.accent} />
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

    const handleDownload = useCallback(async (episode) => {
        log('UI', 'Download tapped', { id: episode.id, title: episode.title });
        if (!isConnected) {
            showAlert('Offline', 'You need an internet connection to download episodes.');
            return;
        }
        if (!episode.audio_url) return;
        const safeId = episode.id.toString().replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `episode_${safeId}.mp3`;
        setDownloads(prev => ({ ...prev, [episode.id]: 0 }));
        try {
            const localPath = await downloadAudioFile(
                episode.audio_url,
                filename,
                (p) => setDownloads(prev => {
                    // Quantize to whole percent: returning the same object
                    // reference for sub-percent ticks skips the re-render.
                    const pct = Math.round(p);
                    return prev[episode.id] === pct ? prev : { ...prev, [episode.id]: pct };
                }),
            );
            log('UI', 'Download completed', { id: episode.id });
            await updateEpisodeLocalPath(episode.id, localPath);
            loadData();
            notifyLibraryChange({ type: 'download-complete', episodeId: episode.id });
        } catch (e) {
            log('UI', 'Download failed', { id: episode.id, error: e.message });
            console.error('Download failed', e);
            showAlert('Error', 'Failed to download episode.');
        } finally {
            setDownloads(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
        }
    }, [isConnected]);

    const prevServiceRef = useRef('RSS');
    useEffect(() => {
        const svc = detectService(rssUrl);
        if (svc === 'Spotify' && prevServiceRef.current !== 'Spotify') {
            showAlert(
                'Spotify not supported',
                'Spotify does not provide public RSS feeds. Try finding the podcast on Apple Podcasts or the show\'s website.',
            );
        }
        prevServiceRef.current = svc;
    }, [rssUrl]);

    // Refresh every subscribed feed in parallel; each feed's episodes are
    // saved in a single transaction. Failed feeds never block the others —
    // they're collected and surfaced once (only for user-initiated refreshes).
    const handleRefresh = async (userInitiated = true) => {
        if (!isConnected) {
            // Match the other network actions (download, add feed) which alert
            // when offline — a silent no-op reads as "refresh is broken".
            if (userInitiated) {
                showAlert('Offline', 'You need an internet connection to refresh your feeds.');
            }
            return;
        }
        setIsRefreshing(true);
        try {
            const podcasts = await getPodcasts();
            const results = await Promise.allSettled(podcasts.map(async (podcast) => {
                const feedData = await fetchPodcastFeed(podcast.feed_url);
                const latest = feedData.episodes
                    .slice(0, MAX_EPISODES_PER_PODCAST)
                    .map(ep => ({
                        ...ep,
                        podcast_title: podcast.title,
                        podcast_feed_url: podcast.feed_url,
                        description: ep.description || '',
                        audio_url: ep.enclosure,
                    }));
                await saveEpisodesBatch(latest);
                await pruneOldEpisodesForPodcast(podcast.feed_url, MAX_EPISODES_PER_PODCAST);
                await capNewEpisodes(podcast.feed_url);
            }));

            const failedTitles = results
                .map((r, i) => (r.status === 'rejected' ? podcasts[i].title : null))
                .filter(Boolean);
            if (failedTitles.length > 0) {
                log('UI', 'Feed refresh failures', { failed: failedTitles });
                if (userInitiated) {
                    showAlert(
                        'Some feeds failed to refresh',
                        failedTitles.join('\n'),
                    );
                }
            }

            await loadData();
            // New-episode counts may have changed — let the tab badge re-check.
            notifyLibraryChange();
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleAddFeed = async () => {
        log('UI', 'Add feed tapped', { url: rssUrl });
        if (!isConnected) {
            showAlert('Offline', 'You need an internet connection to add a feed.');
            return;
        }
        if (!rssUrl.trim()) return;
        setIsFetching(true);
        try {
            const rss = await resolveToRssUrl(rssUrl);
            const feedData = await fetchPodcastFeed(rss);
            await savePodcast({
                title: feedData.title,
                description: feedData.description,
                feed_url: rss,
                image_url: feedData.image,
            });
            await saveEpisodesBatch(feedData.episodes
                .slice(0, MAX_EPISODES_PER_PODCAST)
                .map(ep => ({
                    ...ep,
                    podcast_title: feedData.title,
                    podcast_feed_url: rss,
                    description: ep.description || '',
                    audio_url: ep.enclosure,
                })));
            setRssUrl('');
            loadData();
            notifyLibraryChange({ type: 'subscribe' });
            togglePanel();
        } catch (e) {
            showAlert('Could not add podcast', e.message || 'Check the link and try again.');
            console.error(e);
        } finally {
            setIsFetching(false);
        }
    };

    const handleOpenEpisode = useCallback((episode) => {
        navigation.navigate('Player', { episode });
    }, [navigation]);

    const renderItem = useCallback(({ item }) => (
        <EpisodeItem
            episode={item}
            onPress={handleOpenEpisode}
            onDownload={handleDownload}
            isDownloading={item.id in downloads}
            downloadProgress={downloads[item.id] ?? 0}
        />
    ), [handleOpenEpisode, handleDownload, downloads]);

    return (
        <View style={styles.container}>
            {/* Collapsible RSS input panel */}
            <Animated.View style={[styles.inputPanel, panelStyle]}>
                <View style={styles.inputRow}>
                    <View style={styles.inputWrap}>
                        <Icon name="rss" size={14} color={colors.textMuted} />
                        <TextInput
                            ref={inputRef}
                            style={styles.input}
                            placeholder="RSS, Apple Podcasts link…"
                            placeholderTextColor={colors.textMuted}
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
                                    <TouchableOpacity
                                        onPress={() => setRssUrl('')}
                                        hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                                        accessibilityRole="button"
                                        accessibilityLabel="Clear feed URL"
                                    >
                                        <Icon name="x" size={14} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </>
                            );
                        })()}
                    </View>
                    <TouchableOpacity
                        style={[styles.addBtn, (!isConnected || isFetching || !rssUrl.trim()) && styles.addBtnDisabled]}
                        onPress={handleAddFeed}
                        disabled={isFetching || !isConnected}
                        accessibilityRole="button"
                        accessibilityLabel="Add podcast feed"
                    >
                        {isFetching
                            ? <ActivityIndicator color={colors.textPrimary} size="small" />
                            : <Text style={styles.addBtnText}>Add</Text>
                        }
                    </TouchableOpacity>
                </View>
            </Animated.View>

            <FlatList
                data={episodes}
                keyExtractor={item => item.id.toString()}
                onRefresh={() => handleRefresh(true)}
                refreshing={isRefreshing}
                renderItem={renderItem}
                initialNumToRender={10}
                maxToRenderPerBatch={10}
                windowSize={7}
                contentContainerStyle={episodes.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 130 }}
                ListEmptyComponent={
                    <EmptyState
                        icon="radio"
                        title="No episodes yet"
                        subtitle="Add a podcast RSS feed above to start discovering episodes"
                    />
                }
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },

    inputPanel: {
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairline,
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
        backgroundColor: colors.surface,
        borderRadius: 12,
        paddingHorizontal: 14,
        height: 44,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        gap: 8,
    },
    input: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: 14,
        height: '100%',
    },
    addBtn: {
        backgroundColor: colors.accent,
        paddingHorizontal: 20,
        height: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 64,
    },
    addBtnDisabled: { opacity: 0.4 },
    addBtnText: { color: colors.textPrimary, fontWeight: '700', fontSize: 14 },

    serviceBadge: {
        backgroundColor: withAlpha(colors.accent, 0.12),
        borderRadius: 8,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.25),
    },
    serviceBadgeText: { ...type.caption, fontWeight: '700', color: colors.accent },
});

export default SubscribedTimeline;
