import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View, FlatList, StyleSheet, TextInput,
    TouchableOpacity, Text, ActivityIndicator,
    Image, ScrollView,
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
import { isUrlLike, searchPodcasts } from '../api/podcastSearch';
import { notifyLibraryChange, onLibraryChange } from '../services/libraryEvents';
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
    // Name-search typeahead: null means "no search yet", [] means "no matches"
    const [searchResults, setSearchResults] = useState(null);
    const [isSearching, setIsSearching] = useState(false);
    const [subscribingId, setSubscribingId] = useState(null);
    const inputRef = useRef(null);
    const hasRefreshedOnMount = useRef(false);
    const searchTimerRef = useRef(null);
    const searchAbortRef = useRef(null);
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
            // The input stays mounted (just clipped) — blur it so the
            // keyboard doesn't stay up over the episodes list.
            inputRef.current?.blur();
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

    // An episode can finish in the background (MiniPlayer) while this tab is
    // already focused — refresh so its row picks up the Played badge.
    useEffect(() => onLibraryChange((payload) => {
        if (payload?.type === 'playback-complete') loadData();
    }), []);

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

    // Resolves any supported input to an RSS URL and subscribes to it.
    // Returns true on success so callers (URL add, search-result tap) can react.
    const subscribeToFeed = async (input) => {
        if (!isConnected) {
            showAlert('Offline', 'You need an internet connection to add a feed.');
            return false;
        }
        setIsFetching(true);
        try {
            const rss = await resolveToRssUrl(input);
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
            return true;
        } catch (e) {
            showAlert('Could not add podcast', e.message || 'Check the link and try again.');
            console.error(e);
            return false;
        } finally {
            setIsFetching(false);
        }
    };

    // Cancels any pending debounce timer and in-flight search request.
    const cancelSearch = () => {
        if (searchTimerRef.current) {
            clearTimeout(searchTimerRef.current);
            searchTimerRef.current = null;
        }
        if (searchAbortRef.current) {
            searchAbortRef.current.abort();
            searchAbortRef.current = null;
        }
        setIsSearching(false);
    };

    const runSearch = async (term) => {
        if (searchAbortRef.current) searchAbortRef.current.abort();
        const controller = new AbortController();
        searchAbortRef.current = controller;
        setIsSearching(true);
        try {
            const results = await searchPodcasts(term, { signal: controller.signal });
            // Ignore stale responses — the input changed and a newer
            // request (or a cancel) has replaced this controller.
            if (searchAbortRef.current !== controller) return;
            setSearchResults(results);
        } catch (e) {
            if (e.name === 'AbortError' || searchAbortRef.current !== controller) return;
            // No alert spam while typing — an empty list reads as "no matches".
            setSearchResults([]);
        } finally {
            if (searchAbortRef.current === controller) {
                searchAbortRef.current = null;
                setIsSearching(false);
            }
        }
    };

    // Debounced typeahead: search Apple Podcasts while the user types a name.
    useEffect(() => {
        const trimmed = rssUrl.trim();
        if (panelOpen && trimmed.length >= 2 && !isUrlLike(rssUrl) && isConnected) {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
            searchTimerRef.current = setTimeout(() => {
                searchTimerRef.current = null;
                runSearch(trimmed);
            }, 400);
        } else {
            // Input cleared, url-like, panel closed, or offline — drop
            // everything. Searching offline would render a misleading
            // "No podcasts found"; the panel shows an offline row instead.
            cancelSearch();
            setSearchResults(null);
        }
    }, [rssUrl, panelOpen, isConnected]);

    useEffect(() => () => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        if (searchAbortRef.current) searchAbortRef.current.abort();
    }, []);

    const handleAddFeed = () => {
        log('UI', 'Add feed tapped', { url: rssUrl });
        if (!isConnected) {
            showAlert('Offline', 'You need an internet connection to search or add feeds.');
            return;
        }
        const trimmed = rssUrl.trim();
        if (!trimmed) return;
        if (isUrlLike(rssUrl)) {
            subscribeToFeed(rssUrl);
        } else {
            // Match the results panel's >= 2 gate — a shorter search would
            // run invisibly and leak stale results on the next keystroke.
            if (trimmed.length < 2) return;
            // Search term — flush the debounce and search right away.
            if (searchTimerRef.current) {
                clearTimeout(searchTimerRef.current);
                searchTimerRef.current = null;
            }
            runSearch(trimmed);
        }
    };

    const handleSubscribeSearchResult = async (result) => {
        log('UI', 'Search result tapped', { id: result.id, title: result.title });
        setSubscribingId(result.id);
        try {
            const ok = await subscribeToFeed(result.feedUrl);
            if (ok) setSearchResults(null);
        } finally {
            setSubscribingId(null);
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
            showArtwork
            expandOnPress
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
                            placeholder="Search podcasts, or paste RSS link…"
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
                        accessibilityLabel={rssUrl.trim() && !isUrlLike(rssUrl) ? 'Search podcasts' : 'Add podcast feed'}
                    >
                        {isFetching
                            ? <ActivityIndicator color={colors.textPrimary} size="small" />
                            : <Text style={styles.addBtnText}>{rssUrl.trim() && !isUrlLike(rssUrl) ? 'Search' : 'Add'}</Text>
                        }
                    </TouchableOpacity>
                </View>
            </Animated.View>

            {/* Name-search typeahead results (Apple Podcasts directory) */}
            {panelOpen && rssUrl.trim().length >= 2 && !isUrlLike(rssUrl)
                && (!isConnected || isSearching || searchResults !== null) && (
                <View style={styles.searchResults}>
                    <ScrollView keyboardShouldPersistTaps="handled">
                        {!isConnected && (
                            <View style={styles.searchStatusRow}>
                                <Icon name="wifi-off" size={14} color={colors.textMuted} />
                                <Text style={styles.searchStatusText}>You're offline — connect to search</Text>
                            </View>
                        )}
                        {isSearching && (searchResults === null || searchResults.length === 0) && (
                            <View style={styles.searchStatusRow}>
                                <ActivityIndicator size="small" color={colors.textMuted} />
                                <Text style={styles.searchStatusText}>Searching Apple Podcasts…</Text>
                            </View>
                        )}
                        {!isSearching && searchResults !== null && searchResults.length === 0 && (
                            <View style={styles.searchStatusRow}>
                                <Text style={styles.searchStatusText}>No podcasts found</Text>
                            </View>
                        )}
                        {searchResults !== null && searchResults.map((item, index) => (
                            <TouchableOpacity
                                key={String(item.id)}
                                style={[
                                    styles.searchRow,
                                    index > 0 && styles.searchRowBorder,
                                    subscribingId !== null && subscribingId !== item.id && styles.searchRowDisabled,
                                ]}
                                onPress={() => handleSubscribeSearchResult(item)}
                                disabled={subscribingId !== null}
                                accessibilityRole="button"
                                accessibilityLabel={`Subscribe to ${item.title}`}
                            >
                                {item.artwork ? (
                                    <Image source={{ uri: item.artwork }} style={styles.searchArtwork} />
                                ) : (
                                    <View style={[styles.searchArtwork, styles.searchArtworkPlaceholder]}>
                                        <Icon name="headphones" size={18} color={colors.textFaint} />
                                    </View>
                                )}
                                <View style={styles.searchInfo}>
                                    <Text style={styles.searchTitle} numberOfLines={1}>{item.title}</Text>
                                    <Text style={styles.searchMeta} numberOfLines={1}>
                                        {[item.author, item.genre].filter(Boolean).join(' · ')}
                                    </Text>
                                </View>
                                {subscribingId === item.id
                                    ? <ActivityIndicator size="small" color={colors.accent} />
                                    : <Icon name="plus-circle" size={20} color={colors.accent} />
                                }
                            </TouchableOpacity>
                        ))}
                    </ScrollView>
                </View>
            )}

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

    searchResults: {
        maxHeight: 340,
        backgroundColor: colors.bg,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairline,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 12,
    },
    searchRowBorder: {
        borderTopWidth: 0.5,
        borderTopColor: colors.hairline,
    },
    searchRowDisabled: { opacity: 0.4 },
    searchArtwork: {
        width: 44,
        height: 44,
        borderRadius: 8,
        backgroundColor: colors.surfaceElevated,
    },
    searchArtworkPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    searchInfo: { flex: 1, gap: 2 },
    searchTitle: { ...type.bodyStrong, color: colors.textPrimary },
    searchMeta: { ...type.body, color: colors.textMuted },
    searchStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        gap: 8,
    },
    searchStatusText: { ...type.body, color: colors.textMuted },
});

export default SubscribedTimeline;
