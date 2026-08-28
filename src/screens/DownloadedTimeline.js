import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator, View, Text, FlatList, TouchableOpacity, StyleSheet, Image,
} from 'react-native';
import { showAlert } from '../components/AppAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import EmptyState from '../components/EmptyState';
import { getDownloadedEpisodes, deleteEpisodeTranscript } from '../database/queries';
import {
    enqueueTranscription,
    dequeueTranscription,
    onQueueChange,
    getQueueIds,
    getActiveId,
    getAbortingId,
} from '../services/whisperService';
import { removeEpisodeDownload } from '../services/episodeService';
import { onLibraryChange, notifyLibraryChange } from '../services/libraryEvents';
import { log } from '../services/logService';
import { withAlpha, type, useStyles, useTheme } from '../theme';

// One folder per podcast, like the My Podcasts tab. Tapping the folder
// expands its downloaded episodes in place; every row keeps the full set
// of Library actions (open, transcribe/cancel, swipe to delete or remove
// transcript). Folders and episode rows are flattened into a single
// FlatList so an expanded folder's episodes stay virtualized — a podcast
// can hold an unbounded number of downloads.
const FolderHeader = React.memo(({ group, isExpanded, showSeparator, onToggleExpand }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const count = group.episodes.length;
    return (
        <View>
            {showSeparator && <View style={styles.separator} />}
            <TouchableOpacity
                onPress={() => onToggleExpand(group)}
                activeOpacity={1}
                style={styles.folderRow}
                accessibilityRole="button"
                accessibilityLabel={`${group.title}, ${count} downloaded episode${count === 1 ? '' : 's'}, ${isExpanded ? 'collapse' : 'expand'}`}
            >
                {group.image_url ? (
                    <Image source={{ uri: group.image_url }} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkPlaceholder]}>
                        <Icon name="headphones" size={22} color={colors.textFaint} />
                    </View>
                )}

                <View style={styles.info}>
                    <Text style={styles.folderTitle} numberOfLines={1}>{group.title}</Text>
                    <Text style={styles.folderSubtitle} numberOfLines={1}>
                        {group.episodes[0]?.title || ''}
                    </Text>
                </View>

                <View style={styles.badge} accessibilityLabel={`${count} downloaded episode${count === 1 ? '' : 's'}`}>
                    <Text style={styles.badgeText}>{count}</Text>
                </View>

                <Icon
                    name={isExpanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={colors.textMuted}
                    style={{ marginLeft: 6 }}
                />
            </TouchableOpacity>
        </View>
    );
});

// No entering animation here: rows are individual virtualized FlatList items,
// so a mount-triggered animation would replay every time a row scrolls back
// into the render window, not just on expand.
const EpisodeRow = React.memo(({
    episode, isActive, isQueued,
    onOpenEpisode, onTranscribe, onCancel, onDelete, onRemoveTranscript,
}) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    return (
    <View style={styles.episodeGroup}>
        <SwipeableRow
            leftAction={episode.has_transcript ? {
                icon: 'x-circle',
                label: 'Transcript',
                color: colors.indigo,
                dismiss: 'ack',
                onPress: () => onRemoveTranscript(episode),
                accessibilityLabel: `Remove transcript for ${episode.title}`,
            } : undefined}
            rightAction={{
                icon: 'trash-2',
                color: colors.danger,
                dismiss: 'slide-out',
                onPress: () => onDelete(episode),
                accessibilityLabel: `Delete ${episode.title}`,
            }}
        >
            <EpisodeItem
                episode={episode}
                cardStyle={styles.episodeCard}
                onPress={onOpenEpisode}
                onTranscribe={!isQueued && !isActive ? onTranscribe : undefined}
                onCancel={onCancel}
                isTranscribing={isActive}
                isQueued={isQueued && !isActive}
            />
        </SwipeableRow>
    </View>
    );
});

const DownloadedTimeline = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeId, setActiveId] = useState(null);
    const [queuedIds, setQueuedIds] = useState([]);
    const [expandedKey, setExpandedKey] = useState(null);
    const isFocused = useIsFocused();

    const loadData = useCallback(async () => {
        try {
            const data = await getDownloadedEpisodes();
            setEpisodes(data);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Group downloads by podcast. Episodes arrive sorted by release_date DESC,
    // so folders are ordered by their most recent episode and each folder's
    // episodes stay newest-first.
    const groups = useMemo(() => {
        const map = new Map();
        for (const ep of episodes) {
            const key = ep.podcast_feed_url || ep.podcast_title || 'unknown';
            let group = map.get(key);
            if (!group) {
                group = { key, title: ep.podcast_title || 'Unknown podcast', image_url: ep.image_url, episodes: [] };
                map.set(key, group);
            }
            if (!group.image_url && ep.image_url) group.image_url = ep.image_url;
            group.episodes.push(ep);
        }
        return Array.from(map.values());
    }, [episodes]);

    // Drop a stale expandedKey once its folder is gone (last episode deleted),
    // otherwise the folder would reappear pre-expanded on a later download.
    useEffect(() => {
        if (expandedKey && !groups.some(g => g.key === expandedKey)) {
            setExpandedKey(null);
        }
    }, [groups, expandedKey]);

    // Flatten folders + the expanded folder's episodes into one list so the
    // FlatList virtualizes episode rows too.
    const listData = useMemo(() => {
        const rows = [];
        for (const group of groups) {
            rows.push({ kind: 'folder', key: `folder:${group.key}`, group });
            if (group.key === expandedKey) {
                for (const ep of group.episodes) {
                    rows.push({ kind: 'episode', key: `episode:${ep.id}`, episode: ep });
                }
            }
        }
        return rows;
    }, [groups, expandedKey]);

    // Sync queue state from the service. Any change to the transcription queue
    // — enqueue, dequeue, complete — also reloads the episode list so the
    // Library reflects work started or finished from any tab (and items
    // restored from a previous session whose UI callbacks didn't survive).
    const syncQueue = useCallback(() => {
        const ids = getQueueIds();
        const curActive = getActiveId();
        const abortId = getAbortingId();
        setQueuedIds(ids);
        // Reconcile activeId to service truth (same rule as the focus handler):
        // trust a real running job; clear only when the service is idle AND the
        // queue is empty. During the optimistic window (item enqueued, queued,
        // but _runNext's setTimeout hasn't marked it active yet) the queue is
        // non-empty, so we leave the optimistic activeId alone — no flash.
        if (curActive !== null && abortId !== curActive) {
            setActiveId(curActive);
        } else if (ids.length === 0) {
            setActiveId(null);
        }
        log('QUEUE', 'syncQueue', { svcActiveId: curActive, abortingId: abortId, queuedIds: ids });
        loadData();
    }, [loadData]);

    useEffect(() => {
        const unsubQueue = onQueueChange(syncQueue);
        // Library events are payload-aware: per-window transcript progress is
        // handled inside each row and play-position ticks (~5s while playing)
        // only matter to the Listening tab, so skip the full reload for both.
        const unsubLib = onLibraryChange((payload) => {
            const t = payload?.type;
            if (t === 'transcript-progress' || t === 'playback-progress') return;
            loadData();
        });
        return () => { unsubQueue(); unsubLib(); };
    }, [syncQueue, loadData]);

    useEffect(() => {
        if (isFocused) {
            loadData();
            const svcActive = getActiveId();
            const abortId = getAbortingId();
            const recovered = svcActive !== null && abortId !== svcActive ? svcActive : null;
            log('UI', 'Screen focused', { svcActive, abortId, recoveredActiveId: recovered });
            setActiveId(recovered);
            setQueuedIds(getQueueIds());
        }
    }, [isFocused, loadData]);

    const handleTranscribe = useCallback(async (episode) => {
        if (!episode.local_audio_path) return;

        const id = episode.id;
        const svcActive = getActiveId();
        const aborting = getAbortingId();
        const curQueue = getQueueIds();
        log('UI', 'Transcribe tapped', {
            id, title: episode.title,
            svcActiveId: svcActive, abortingId: aborting, queueIds: curQueue,
        });
        // Optimistic: show as Transcribing immediately ONLY when there is
        // truly nothing else pending (empty queue, no running job or only
        // an aborting job).  Two quick taps would both see getActiveId()===null
        // (before _runNext's setTimeout fires), so we also check the queue.
        const queueEmpty = curQueue.length === 0;
        if (queueEmpty && (!svcActive || aborting === svcActive)) {
            setActiveId(id);
            log('UI', 'Optimistic → Transcribing', { id });
        } else {
            log('UI', 'Will show as Queued', { id, reason: !queueEmpty ? 'queue not empty' : 'another job active' });
        }

        // Tracks whether THIS job actually started running (vs. being cancelled
        // while still queued). Only the job that truly ran may hand off to the
        // next queued item in finally; otherwise we'd promote an item that is
        // still queued behind a different, still-active job.
        let becameActive = false;
        try {
            await enqueueTranscription(
                id,
                episode.local_audio_path,
                () => {},
                () => {
                    log('UI', 'onStart callback fired', { id });
                    becameActive = true;
                    setActiveId(id);
                },
                episode.duration || 0,
            );
            log('UI', 'Transcription promise resolved', { id });
            loadData();
        } catch (e) {
            const errStr = e?.message || String(e);
            log('UI', 'Transcription catch', { id, error: errStr, stack: e?.stack?.slice(0, 300) });
            if (errStr !== 'Cancelled' && errStr !== 'Already queued' && errStr !== 'Queue reset') {
                log('UI', '*** ERROR ALERT SHOWN ***', { id, error: errStr });
                const isAudioError = errStr.includes('Audio file') || errStr.includes('audio file') || errStr.includes('unrecognized header');
                showAlert(
                    isAudioError ? 'Invalid Audio File' : 'Transcription Failed',
                    isAudioError
                        ? 'This audio file appears to be corrupted or missing. Try deleting and re-downloading the episode.'
                        : 'Could not transcribe this episode. Make sure the AI model is downloaded in Settings.',
                );
            }
        } finally {
            if (becameActive) {
                // This job actually ran and is now finishing: optimistically
                // promote the next queued item so it doesn't flash "Queued"
                // during service cleanup. syncQueue (onQueueChange) corrects
                // this to the service's real active job a moment later.
                const nextIds = getQueueIds();
                const next = nextIds.length > 0 ? nextIds[0] : null;
                setActiveId(next);
                log('UI', 'handleTranscribe finally (was active)', { id, promoted: next });
            } else {
                // Never started (cancelled while queued, or another job is
                // active): don't promote anything — that would clobber the
                // genuinely-active job. Just drop our own optimistic id and
                // defer to the service's current active job.
                setActiveId(prev => (prev === id ? getActiveId() : prev));
                log('UI', 'handleTranscribe finally (never active)', { id });
            }
        }
    }, [loadData]);

    const handleCancel = useCallback((episode) => {
        const id = episode.id;
        const svcActive = getActiveId();
        const wasActive = svcActive === id;
        log('UI', 'Cancel tapped', {
            id, title: episode.title,
            wasActive, svcActiveId: svcActive, queueBefore: getQueueIds(),
        });
        dequeueTranscription(id);
        if (wasActive) {
            const nextIds = getQueueIds();
            const promoted = nextIds.length > 0 ? nextIds[0] : null;
            log('UI', 'Cancel active → promote next', { promoted, queueAfter: nextIds });
            setActiveId(promoted);
        } else {
            log('UI', 'Cancel queued item', { id });
            setActiveId(prev => prev === id ? null : prev);
        }
    }, []);

    const handleRemoveTranscript = useCallback(async (episode) => {
        log('UI', 'Remove transcript', { id: episode.id, title: episode.title });
        await deleteEpisodeTranscript(episode.id);
        notifyLibraryChange({ type: 'transcript-delete', episodeId: episode.id });
        loadData();
    }, [loadData]);

    const handleDelete = useCallback(async (episode) => {
        try {
            // Shared with the finished-episode prompt: dequeues, stops the
            // player if this is the loaded track, deletes file + transcript.
            await removeEpisodeDownload(episode);
        } catch (e) {
            log('UI', 'Delete failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Delete failed', 'Could not remove this episode. Please try again.');
            loadData();
            return false; // signal SwipeableRow to spring the row back
        }
        loadData();
    }, [loadData]);

    const handleOpenEpisode = useCallback((episode) => {
        log('UI', 'Episode tapped → Player', { id: episode.id, title: episode.title });
        navigation.navigate('Player', { episode });
    }, [navigation]);

    const handleToggleExpand = useCallback((group) => {
        log('UI', 'Library folder toggled', { key: group.key, title: group.title });
        setExpandedKey(prev => (prev === group.key ? null : group.key));
    }, []);

    const renderItem = useCallback(({ item, index }) => {
        if (item.kind === 'folder') {
            return (
                <FolderHeader
                    group={item.group}
                    isExpanded={expandedKey === item.group.key}
                    showSeparator={index > 0}
                    onToggleExpand={handleToggleExpand}
                />
            );
        }
        return (
            <EpisodeRow
                episode={item.episode}
                isActive={activeId === item.episode.id}
                isQueued={queuedIds.includes(item.episode.id)}
                onOpenEpisode={handleOpenEpisode}
                onTranscribe={handleTranscribe}
                onCancel={handleCancel}
                onDelete={handleDelete}
                onRemoveTranscript={handleRemoveTranscript}
            />
        );
    }, [
        expandedKey, activeId, queuedIds,
        handleToggleExpand, handleOpenEpisode, handleTranscribe, handleCancel, handleDelete, handleRemoveTranscript,
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
                data={listData}
                keyExtractor={item => item.key}
                renderItem={renderItem}
                contentContainerStyle={listData.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 130 }}
                initialNumToRender={10}
                maxToRenderPerBatch={10}
                windowSize={7}
                onScrollBeginDrag={closeOpenRow}
                ListEmptyComponent={
                    <EmptyState
                        icon="archive"
                        title="Library is empty"
                        subtitle="Downloaded episodes appear here for offline listening"
                    />
                }
            />
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    loadingWrap: { alignItems: 'center', justifyContent: 'center' },

    folderRow: {
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
    folderTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.textPrimary,
    },
    folderSubtitle: {
        ...type.body,
        color: colors.textMuted,
        lineHeight: 18,
    },

    badge: {
        minWidth: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: colors.accent,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
        marginLeft: 8,
    },
    badgeText: {
        fontSize: 12,
        fontWeight: '700',
        color: colors.bg,
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

export default DownloadedTimeline;
