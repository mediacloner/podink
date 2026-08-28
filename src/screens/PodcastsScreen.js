import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator, View, Text, FlatList, TouchableOpacity, StyleSheet, Image,
} from 'react-native';
import ReAnimated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import NetInfo from '@react-native-community/netinfo';
import { showAlert } from '../components/AppAlert';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import EmptyState from '../components/EmptyState';
import {
    getPodcasts, deletePodcast,
    getNewEpisodesCountForPodcast, getLatestEpisodesForPodcast,
    markPodcastEpisodesAsSeen, capNewEpisodes,
    pruneOldEpisodesForPodcast, getDownloadedEpisodesForPodcast,
} from '../database/queries';
import { deleteAudioFile } from '../services/downloadService';
import { dequeueTranscription } from '../services/whisperService';
import {
    downloadEpisode, reportDownloadError, reportTranscriptionError, transcribeEpisode,
} from '../services/episodeService';
import { useTranscriptionQueue } from '../hooks/useTranscriptionQueue';
import { notifyLibraryChange, onLibraryChange } from '../services/libraryEvents';
import { withAlpha, type, useStyles, useTheme } from '../theme';

const MAX_NEW = 5;
const EMPTY_EPISODES = [];

const PodcastRow = React.memo(({
    podcast,
    newCount,
    isExpanded,
    episodes,
    downloads,
    activeId,
    queuedIds,
    onToggleExpand,
    onUnsubscribe,
    onOpenEpisode,
    onDownload,
    onTranscribe,
    onCancel,
}) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    return (
    <View>
        <SwipeableRow
            rightAction={{
                icon: 'trash-2',
                color: colors.danger,
                dismiss: 'close',
                onPress: () => onUnsubscribe(podcast),
                accessibilityLabel: `Unsubscribe from ${podcast.title}`,
            }}
        >
            <TouchableOpacity
                onPress={() => onToggleExpand(podcast)}
                activeOpacity={1}
                style={styles.row}
                accessibilityRole="button"
                accessibilityLabel={`${podcast.title}${newCount > 0 ? `, ${newCount} new episodes` : ''}, ${isExpanded ? 'collapse' : 'expand'}`}
            >
                {podcast.image_url ? (
                    <Image source={{ uri: podcast.image_url }} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkPlaceholder]}>
                        <Icon name="headphones" size={22} color={colors.textFaint} />
                    </View>
                )}

                <View style={styles.info}>
                    <Text style={styles.podcastTitle} numberOfLines={1}>{podcast.title}</Text>
                    <Text style={styles.podcastDesc} numberOfLines={1}>
                        {podcast.description?.replace(/<[^>]+>/g, '') || ''}
                    </Text>
                </View>

                {newCount > 0 && (
                    <View style={styles.badge} accessibilityLabel={`${newCount} new episodes`}>
                        <Text style={styles.badgeText}>{newCount}</Text>
                    </View>
                )}

                <Icon
                    name={isExpanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={colors.textMuted}
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
                        onPress={onOpenEpisode}
                        cardStyle={styles.episodeCard}
                        onDownload={onDownload}
                        onTranscribe={onTranscribe}
                        onCancel={onCancel}
                        isDownloading={ep.id in downloads}
                        downloadProgress={downloads[ep.id] ?? 0}
                        isTranscribing={activeId === ep.id}
                        isQueued={queuedIds.includes(ep.id) && activeId !== ep.id}
                    />
                ))}
            </ReAnimated.View>
        )}
    </View>
    );
});

const PodcastsScreen = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const [podcasts, setPodcasts] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [newCountMap, setNewCountMap] = useState({});
    const [expandedFeedUrl, _setExpanded] = useState(null);
    const [episodesMap, setEpisodesMap] = useState({});
    const [downloads, setDownloads] = useState({}); // { [episodeId]: progress 0-100 }
    const { activeId, queuedIds } = useTranscriptionQueue();
    const [isConnected, setIsConnected] = useState(true);
    const expandedRef = useRef(null);
    const episodesMapRef = useRef({});
    const isFocused = useIsFocused();

    useEffect(() => { episodesMapRef.current = episodesMap; }, [episodesMap]);

    const setExpanded = useCallback((val) => {
        expandedRef.current = val;
        _setExpanded(val);
    }, []);

    useEffect(() => {
        const unsub = NetInfo.addEventListener(state => setIsConnected(state.isConnected));
        return () => unsub();
    }, []);

    // Mirror for the library-event listener below, which is subscribed once.
    const podcastsRef = useRef([]);
    const listRef = useRef(null);

    const loadPodcasts = useCallback(async () => {
        try {
            const data = await getPodcasts();
            podcastsRef.current = data;
            setPodcasts(data);
            const counts = {};
            await Promise.all(data.map(async p => {
                await capNewEpisodes(p.feed_url, MAX_NEW);
                await pruneOldEpisodesForPodcast(p.feed_url, 50);
                counts[p.feed_url] = await getNewEpisodesCountForPodcast(p.feed_url);
            }));
            setNewCountMap(counts);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const refreshEpisodesFor = useCallback(async (feedUrl) => {
        const eps = await getLatestEpisodesForPodcast(feedUrl, MAX_NEW);
        setEpisodesMap(prev => ({ ...prev, [feedUrl]: eps }));
    }, []);

    // Refresh episode lists already loaded (e.g. has_transcript flags) without
    // a full screen reload.
    const refreshLoadedEpisodes = useCallback(() => {
        Object.keys(episodesMapRef.current).forEach(feedUrl => {
            refreshEpisodesFor(feedUrl).catch(() => {});
        });
    }, [refreshEpisodesFor]);

    // The red per-podcast numbers only (no cap / prune pass): a download
    // marks its episode seen (episodeService), so the count changes without
    // this tab being refocused — e.g. when downloading from an expanded
    // folder right here.
    const refreshNewCounts = useCallback(async () => {
        const counts = {};
        await Promise.all(podcastsRef.current.map(async p => {
            counts[p.feed_url] = await getNewEpisodesCountForPodcast(p.feed_url);
        }));
        setNewCountMap(counts);
    }, []);

    // Event-driven updates instead of reload-on-every-focus-only: transcripts
    // and downloads completed anywhere update the expanded rows in place.
    useEffect(() => onLibraryChange((payload) => {
        const t = payload?.type;
        if (t === 'transcript-progress') return;
        if (t === 'download-complete') refreshNewCounts().catch(() => {});
        if (t === 'transcript-complete' || t === 'transcript-error'
            || t === 'transcript-delete'
            || t === 'download-complete' || t === 'episode-delete'
            || t === 'playback-complete' || t === 'playback-reset') {
            refreshLoadedEpisodes();
        }
    }), [refreshLoadedEpisodes, refreshNewCounts]);

    useEffect(() => {
        if (isFocused) {
            loadPodcasts();
        } else {
            const feedUrl = expandedRef.current;
            if (feedUrl) {
                markPodcastEpisodesAsSeen(feedUrl)
                    .then(() => notifyLibraryChange())
                    .catch(() => {});
                setNewCountMap(prev => ({ ...prev, [feedUrl]: 0 }));
                setExpanded(null);
            }
        }
    }, [isFocused, loadPodcasts, setExpanded]);

    const handleToggleExpand = useCallback(async (podcast) => {
        if (expandedRef.current === podcast.feed_url) {
            // Collapse + mark as seen
            setExpanded(null);
            setNewCountMap(prev => ({ ...prev, [podcast.feed_url]: 0 }));
            markPodcastEpisodesAsSeen(podcast.feed_url)
                .then(() => notifyLibraryChange())
                .catch(() => {});
        } else {
            // Load fresh episodes then expand
            const eps = await getLatestEpisodesForPodcast(podcast.feed_url, MAX_NEW);
            setEpisodesMap(prev => ({ ...prev, [podcast.feed_url]: eps }));
            setExpanded(podcast.feed_url);
            // Bring the unfolded podcast to the top so its episodes are on
            // screen — low in the list they used to open below the fold. The
            // delay lets the group render and the content size grow first,
            // otherwise the scroll clamps to the old, shorter content.
            const index = podcastsRef.current.findIndex(p => p.feed_url === podcast.feed_url);
            if (index >= 0) {
                setTimeout(() => {
                    listRef.current?.scrollToIndex({ index, viewPosition: 0, viewOffset: 4, animated: true });
                }, 120);
            }
        }
    }, [setExpanded]);

    const handleUnsubscribe = useCallback((podcast) => {
        showAlert(
            'Unsubscribe',
            `Remove "${podcast.title}" and its episode list from your podcasts?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Unsubscribe',
                    style: 'destructive',
                    onPress: async () => {
                        if (expandedRef.current === podcast.feed_url) setExpanded(null);
                        // Cancel any queued/active transcriptions and delete the
                        // on-disk audio BEFORE the rows (and their paths) are gone,
                        // otherwise the mp3 files leak in the documents directory.
                        const downloaded = await getDownloadedEpisodesForPodcast(podcast.feed_url);
                        for (const dl of downloaded) {
                            dequeueTranscription(dl.id);
                            if (dl.local_audio_path) await deleteAudioFile(dl.local_audio_path);
                        }
                        await deletePodcast(podcast.feed_url);
                        notifyLibraryChange({ type: 'unsubscribe' });
                        loadPodcasts();
                    },
                },
            ],
        );
    }, [loadPodcasts, setExpanded]);

    // Download an episode's audio. The transcription is queued automatically
    // (episodeService), so the row goes Download → Downloaded → Queued / % →
    // Transcript on its own; per-row percent arrives via
    // whisperService.onTranscriptProgress inside the row. Returns the local
    // URI on success, or null if the download fails or is rejected.
    const handleDownload = useCallback(async (episode) => {
        if (!isConnected) {
            showAlert('Offline', 'You need an internet connection to download episodes.');
            return null;
        }
        if (!episode.audio_url) return null;
        setDownloads(prev => ({ ...prev, [episode.id]: 0 }));
        try {
            const localPath = await downloadEpisode(episode, {
                onProgress: (p) => setDownloads(prev => {
                    // Quantize to whole percent: returning the same object
                    // reference for sub-percent ticks skips re-rendering every
                    // PodcastRow (which receives the whole downloads object).
                    const pct = Math.round(p);
                    return prev[episode.id] === pct ? prev : { ...prev, [episode.id]: pct };
                }),
            });
            await refreshEpisodesFor(episode.podcast_feed_url);
            return localPath;
        } catch (e) {
            reportDownloadError(e);
            return null;
        } finally {
            setDownloads(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
        }
    }, [isConnected, refreshEpisodesFor]);

    // The Transcribe pill only appears on a downloaded row whose automatic
    // transcription failed or was cancelled — this is the retry. (A row
    // without a file downloads instead; the download queues the transcript.)
    const handleTranscribe = useCallback(async (episode) => {
        if (!episode.local_audio_path) {
            await handleDownload(episode);
            return;
        }
        try {
            await transcribeEpisode(episode);
            await refreshEpisodesFor(episode.podcast_feed_url);
        } catch (e) {
            reportTranscriptionError(e);
        }
    }, [handleDownload, refreshEpisodesFor]);

    const handleCancel = useCallback((episode) => {
        dequeueTranscription(episode.id);
    }, []);

    const handleOpenEpisode = useCallback((episode) => {
        navigation.navigate('Player', { episode });
    }, [navigation]);

    const renderItem = useCallback(({ item }) => (
        <PodcastRow
            podcast={item}
            newCount={newCountMap[item.feed_url] ?? 0}
            isExpanded={expandedFeedUrl === item.feed_url}
            episodes={episodesMap[item.feed_url] ?? EMPTY_EPISODES}
            downloads={downloads}
            activeId={activeId}
            queuedIds={queuedIds}
            onToggleExpand={handleToggleExpand}
            onUnsubscribe={handleUnsubscribe}
            onOpenEpisode={handleOpenEpisode}
            onDownload={handleDownload}
            onTranscribe={handleTranscribe}
            onCancel={handleCancel}
        />
    ), [
        newCountMap, expandedFeedUrl, episodesMap, downloads, activeId, queuedIds,
        handleToggleExpand, handleUnsubscribe, handleOpenEpisode, handleDownload, handleTranscribe, handleCancel,
    ]);

    if (isLoading) {
        return (
            <View style={[styles.container, styles.loadingWrap]}>
                <ActivityIndicator size="large" color={colors.accent} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <FlatList
                ref={listRef}
                data={podcasts}
                keyExtractor={item => item.id.toString()}
                onScrollToIndexFailed={() => {}}
                renderItem={renderItem}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                contentContainerStyle={podcasts.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 130 }}
                initialNumToRender={10}
                maxToRenderPerBatch={10}
                windowSize={7}
                onScrollBeginDrag={closeOpenRow}
                ListEmptyComponent={
                    <EmptyState
                        icon="headphones"
                        title="No podcasts yet"
                        subtitle="Add an RSS feed from the Feed tab to subscribe"
                    />
                }
            />
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    loadingWrap: { alignItems: 'center', justifyContent: 'center' },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 14,
        backgroundColor: colors.bg,
    },
    artwork: {
        width: 64,
        height: 64,
        borderRadius: 12,
        marginRight: 14,
        backgroundColor: colors.surfaceElevated,
    },
    artworkPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    info: { flex: 1, gap: 4 },
    podcastTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.textPrimary,
    },
    podcastDesc: {
        ...type.body,
        color: colors.textMuted,
        lineHeight: 18,
    },

    badge: {
        minWidth: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: colors.danger,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
        marginLeft: 8,
    },
    badgeText: {
        fontSize: 12,
        fontWeight: '700',
        color: colors.onAccent,
    },

    episodeGroup: {
        marginLeft: 16,
        backgroundColor: colors.surfaceElevated,
        borderLeftWidth: 2,
        borderLeftColor: colors.accent,
    },
    episodeCard: {
        backgroundColor: colors.surfaceElevated,
    },

    separator: {
        height: 0.5,
        backgroundColor: withAlpha(colors.textPrimary, 0.06),
        marginLeft: 98,
    },
});

export default PodcastsScreen;
