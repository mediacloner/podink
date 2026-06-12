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
    markPodcastEpisodesAsSeen, capNewEpisodes, updateEpisodeLocalPath,
    pruneOldEpisodesForPodcast, getDownloadedEpisodesForPodcast,
} from '../database/queries';
import { downloadAudioFile, deleteAudioFile } from '../services/downloadService';
import {
    enqueueTranscription, dequeueTranscription, onQueueChange, getQueueIds,
} from '../services/whisperService';
import { notifyLibraryChange, onLibraryChange } from '../services/libraryEvents';
import { colors, withAlpha, type } from '../theme';

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
}) => (
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
));

const PodcastsScreen = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [podcasts, setPodcasts] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [newCountMap, setNewCountMap] = useState({});
    const [expandedFeedUrl, _setExpanded] = useState(null);
    const [episodesMap, setEpisodesMap] = useState({});
    const [downloads, setDownloads] = useState({}); // { [episodeId]: progress 0-100 }
    const [activeId, setActiveId] = useState(null); // transcribing episode id
    const [queuedIds, setQueuedIds] = useState([]);
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

    useEffect(() => {
        const unsub = onQueueChange(() => setQueuedIds(getQueueIds()));
        return unsub;
    }, []);

    const loadPodcasts = useCallback(async () => {
        try {
            const data = await getPodcasts();
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

    // Event-driven updates instead of reload-on-every-focus-only: transcripts
    // and downloads completed anywhere update the expanded rows in place.
    useEffect(() => onLibraryChange((payload) => {
        const t = payload?.type;
        if (t === 'transcript-progress') return;
        if (t === 'transcript-complete' || t === 'transcript-error'
            || t === 'transcript-delete'
            || t === 'download-complete' || t === 'episode-delete') {
            refreshLoadedEpisodes();
        }
    }), [refreshLoadedEpisodes]);

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

    // Download an episode's audio. Returns the local URI on success, or null if
    // the download fails or is rejected. Notifies the Library so it picks up
    // the new downloaded episode without waiting for a tab focus.
    const downloadEpisode = useCallback(async (episode) => {
        if (!isConnected) {
            showAlert('Offline', 'You need an internet connection to download episodes.');
            return null;
        }
        if (!episode.audio_url) return null;
        const safeId = episode.id.toString().replace(/[^a-zA-Z0-9]/g, '_');
        setDownloads(prev => ({ ...prev, [episode.id]: 0 }));
        try {
            const localPath = await downloadAudioFile(
                episode.audio_url,
                `episode_${safeId}.mp3`,
                (p) => setDownloads(prev => {
                    // Quantize to whole percent: returning the same object
                    // reference for sub-percent ticks skips re-rendering every
                    // PodcastRow (which receives the whole downloads object).
                    const pct = Math.round(p);
                    return prev[episode.id] === pct ? prev : { ...prev, [episode.id]: pct };
                }),
            );
            await updateEpisodeLocalPath(episode.id, localPath);
            await refreshEpisodesFor(episode.podcast_feed_url);
            notifyLibraryChange({ type: 'download-complete', episodeId: episode.id });
            return localPath;
        } catch (e) {
            showAlert('Error', 'Failed to download episode.');
            return null;
        } finally {
            setDownloads(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
        }
    }, [isConnected, refreshEpisodesFor]);

    // Single tap from the feed: download if needed, then transcribe. Per-row
    // progress arrives via whisperService.onTranscriptProgress inside the row.
    const handleTranscribe = useCallback(async (episode) => {
        const id = episode.id;
        let localPath = episode.local_audio_path;
        if (!localPath) {
            localPath = await downloadEpisode(episode);
            if (!localPath) return;
        }
        try {
            await enqueueTranscription(
                id,
                localPath,
                () => {},
                () => setActiveId(id),
                episode.duration || 0,
            );
            await refreshEpisodesFor(episode.podcast_feed_url);
        } catch (e) {
            const errStr = e?.message || String(e);
            if (errStr !== 'Cancelled' && errStr !== 'Already queued' && errStr !== 'Queue reset') {
                const isAudioError = errStr.includes('Audio file') || errStr.includes('audio file') || errStr.includes('unrecognized header');
                showAlert(
                    isAudioError ? 'Invalid Audio File' : 'Transcription Failed',
                    isAudioError
                        ? 'This audio file appears to be corrupted or missing. Try deleting and re-downloading the episode.'
                        : 'Could not transcribe this episode. Make sure the AI model is downloaded in Settings.',
                );
            }
        } finally {
            setActiveId(prev => prev === id ? null : prev);
        }
    }, [downloadEpisode, refreshEpisodesFor]);

    const handleCancel = useCallback((episode) => {
        const id = episode.id;
        dequeueTranscription(id);
        setActiveId(prev => {
            if (prev !== id) return prev;           // a queued (non-active) item
            const next = getQueueIds();             // active item — promote next or clear
            return next.length > 0 ? next[0] : null;
        });
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
            onDownload={downloadEpisode}
            onTranscribe={handleTranscribe}
            onCancel={handleCancel}
        />
    ), [
        newCountMap, expandedFeedUrl, episodesMap, downloads, activeId, queuedIds,
        handleToggleExpand, handleUnsubscribe, handleOpenEpisode, downloadEpisode, handleTranscribe, handleCancel,
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
                data={podcasts}
                keyExtractor={item => item.id.toString()}
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

const styles = StyleSheet.create({
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
        color: colors.textPrimary,
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
