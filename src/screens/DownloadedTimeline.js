import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View, FlatList, StyleSheet } from 'react-native';
import { showAlert } from '../components/AppAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import EpisodeItem from '../components/EpisodeItem';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import EmptyState from '../components/EmptyState';
import { getDownloadedEpisodes, deleteEpisodeLocalData, deleteEpisodeTranscript } from '../database/queries';
import {
    enqueueTranscription,
    dequeueTranscription,
    onQueueChange,
    getQueueIds,
    getActiveId,
    getAbortingId,
} from '../services/whisperService';
import { deleteAudioFile } from '../services/downloadService';
import { onLibraryChange, notifyLibraryChange } from '../services/libraryEvents';
import { log } from '../services/logService';
import { colors } from '../theme';

const DownloadedTimeline = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeId, setActiveId] = useState(null);
    const [queuedIds, setQueuedIds] = useState([]);
    const isFocused = useIsFocused();

    const loadData = useCallback(async () => {
        try {
            const data = await getDownloadedEpisodes();
            setEpisodes(data);
        } finally {
            setIsLoading(false);
        }
    }, []);

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
        // handled inside each row, so skip the full reload for those ticks.
        const unsubLib = onLibraryChange((payload) => {
            if (payload?.type === 'transcript-progress') return;
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
        log('UI', 'Delete episode', { id: episode.id, title: episode.title });
        try {
            dequeueTranscription(episode.id);
            if (episode.local_audio_path) await deleteAudioFile(episode.local_audio_path);
            await deleteEpisodeLocalData(episode.id);
            notifyLibraryChange({ type: 'episode-delete', episodeId: episode.id });
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

    const renderItem = useCallback(({ item }) => {
        const isActive = activeId === item.id;
        const isQueued = queuedIds.includes(item.id);

        return (
            <SwipeableRow
                leftAction={item.has_transcript ? {
                    icon: 'x-circle',
                    label: 'Transcript',
                    color: colors.indigo,
                    dismiss: 'ack',
                    onPress: () => handleRemoveTranscript(item),
                    accessibilityLabel: `Remove transcript for ${item.title}`,
                } : undefined}
                rightAction={{
                    icon: 'trash-2',
                    color: colors.danger,
                    dismiss: 'slide-out',
                    onPress: () => handleDelete(item),
                    accessibilityLabel: `Delete ${item.title}`,
                }}
            >
                <EpisodeItem
                    episode={item}
                    onPress={handleOpenEpisode}
                    onTranscribe={!isQueued && !isActive ? handleTranscribe : undefined}
                    onCancel={handleCancel}
                    isTranscribing={isActive}
                    isQueued={isQueued && !isActive}
                />
            </SwipeableRow>
        );
    }, [activeId, queuedIds, handleRemoveTranscript, handleDelete, handleOpenEpisode, handleTranscribe, handleCancel]);

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
                data={episodes}
                keyExtractor={item => item.id.toString()}
                renderItem={renderItem}
                contentContainerStyle={episodes.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 130 }}
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

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    loadingWrap: { alignItems: 'center', justifyContent: 'center' },
});

export default DownloadedTimeline;
