import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, View, FlatList, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { showAlert } from '../components/AppAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import { getDownloadedEpisodes, deleteEpisodeLocalData, deleteEpisodeTranscript } from '../database/queries';
import {
    initializeWhisper,
    enqueueTranscription,
    dequeueTranscription,
    onQueueChange,
    getQueueIds,
    getActiveId,
    getAbortingId,
} from '../services/whisperService';
import { deleteAudioFile } from '../services/downloadService';
import { log } from '../services/logService';

// ─── Swipeable delete row ─────────────────────────────────────────────────────

const ACTION_WIDTH  = 80;
const THRESHOLD     = 50;

// open: null | 'left' | 'right'
const SwipeableRow = ({ children, onDelete, onRemoveTranscript }) => {
    const translateX = useRef(new Animated.Value(0)).current;
    const openRef    = useRef(null); // track without re-render

    const close = () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        openRef.current = null;
    };

    const fireDelete = () => {
        Animated.timing(translateX, { toValue: -400, duration: 200, useNativeDriver: true }).start(onDelete);
    };

    const fireRemove = () => {
        Animated.timing(translateX, { toValue: 400, duration: 200, useNativeDriver: true }).start(() => {
            onRemoveTranscript();
            // snap back after removal (list will refresh)
            translateX.setValue(0);
            openRef.current = null;
        });
    };

    const panResponder = useRef(PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
            Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy * 1.5),
        onPanResponderMove: (_, g) => {
            const base = openRef.current === 'left'  ? -ACTION_WIDTH
                       : openRef.current === 'right' ?  ACTION_WIDTH : 0;
            const next = base + g.dx;
            // left swipe → delete (negative), right swipe → transcript (positive, only if available)
            const clamped = onRemoveTranscript
                ? Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, next))
                : Math.max(-ACTION_WIDTH, Math.min(0, next));
            translateX.setValue(clamped);
        },
        onPanResponderRelease: (_, g) => {
            const base  = openRef.current === 'left'  ? -ACTION_WIDTH
                        : openRef.current === 'right' ?  ACTION_WIDTH : 0;
            const delta = base + g.dx;

            if (delta < -THRESHOLD) {
                Animated.spring(translateX, { toValue: -ACTION_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
                openRef.current = 'left';
            } else if (onRemoveTranscript && delta > THRESHOLD) {
                Animated.spring(translateX, { toValue: ACTION_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
                openRef.current = 'right';
            } else {
                close();
            }
        },
    })).current;

    return (
        <View style={s.swipeContainer}>
            {/* Left side: remove transcript (revealed on right-swipe) */}
            {onRemoveTranscript && (
                <TouchableOpacity style={s.transcriptAction} onPress={fireRemove} activeOpacity={0.8}>
                    <Icon name="x-circle" size={20} color="#fff" />
                    <Text style={s.actionLabel}>Transcript</Text>
                </TouchableOpacity>
            )}
            {/* Right side: delete episode (revealed on left-swipe) */}
            <TouchableOpacity style={s.deleteAction} onPress={fireDelete} activeOpacity={0.8}>
                <Icon name="trash-2" size={20} color="#fff" />
            </TouchableOpacity>
            <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
                {children}
            </Animated.View>
        </View>
    );
};

// ─── Screen ───────────────────────────────────────────────────────────────────

const DownloadedTimeline = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes]         = useState([]);
    const [activeId, setActiveId]         = useState(null);
    const [queuedIds, setQueuedIds]       = useState([]);
    const [progressMap, setProgressMap]   = useState({}); // { [id]: 0-99 }
    const isFocused = useIsFocused();

    // Sync queue state from the service.
    // We also reload the episode list when queue shrinks (transcription completed)
    // so the transcript badge appears without requiring a manual screen refresh.
    // This is especially important for items restored from a previous session,
    // which don't have UI callbacks attached.
    const prevQueueLenRef  = useRef(0);
    const prevActiveIdRef  = useRef(null);
    const syncQueue = useCallback(() => {
        const ids       = getQueueIds();
        const curActive = getActiveId();
        const abortId   = getAbortingId();
        const prevLen    = prevQueueLenRef.current;
        const prevActive = prevActiveIdRef.current;
        prevQueueLenRef.current = ids.length;
        prevActiveIdRef.current = curActive;
        setQueuedIds(ids);
        const shouldReload = ids.length < prevLen || (prevActive !== null && curActive === null);
        log('QUEUE', 'syncQueue', {
            svcActiveId: curActive, abortingId: abortId, queuedIds: ids,
            prevQueueLen: prevLen, prevActiveId: prevActive, willReload: shouldReload,
        });
        if (shouldReload) {
            loadData();
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const unsub = onQueueChange(syncQueue);
        return unsub;
    }, [syncQueue]);

    useEffect(() => {
        if (isFocused) {
            loadData();
            initializeWhisper().catch(() => {});
            const svcActive = getActiveId();
            const abortId   = getAbortingId();
            const recovered = svcActive !== null && abortId !== svcActive ? svcActive : null;
            log('UI', 'Screen focused', { svcActive, abortId, recoveredActiveId: recovered });
            setActiveId(recovered);
            syncQueue();
        }
    }, [isFocused, syncQueue]);

    const loadData = async () => {
        const data = await getDownloadedEpisodes();
        setEpisodes(data);
    };

    const handleTranscribe = useCallback(async (episode) => {
        if (!episode.local_audio_path) return;

        const id = episode.id;
        const svcActive  = getActiveId();
        const aborting   = getAbortingId();
        const curQueue   = getQueueIds();
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
        setProgressMap(prev => ({ ...prev, [id]: 0 }));

        try {
            await enqueueTranscription(
                id,
                episode.local_audio_path,
                (p) => setProgressMap(prev => ({ ...prev, [id]: p })),
                () => {
                    log('UI', 'onStart callback fired', { id });
                    setActiveId(id);
                },
            );
            log('UI', 'Transcription promise resolved', { id });
            loadData();
        } catch (e) {
            const errStr = e?.message || String(e);
            log('UI', 'Transcription catch', { id, error: errStr, stack: e?.stack?.slice(0, 300) });
            if (errStr !== 'Cancelled' && errStr !== 'Already queued' && errStr !== 'Queue reset') {
                log('UI', '*** ERROR ALERT SHOWN ***', { id, error: errStr });
                showAlert(
                    'Transcription Failed',
                    'Could not transcribe this episode. Make sure the AI model is downloaded in Settings.',
                );
            }
        } finally {
            // When done, promote the next queued item immediately so it
            // doesn't flash "Queued" while the service is still in cleanup.
            const nextIds = getQueueIds();
            log('UI', 'handleTranscribe finally', { id, nextInQueue: nextIds });
            if (nextIds.length > 0) {
                setActiveId(nextIds[0]);
                log('UI', 'Promoted next → Transcribing', { promoted: nextIds[0] });
            } else {
                setActiveId(prev => prev === id ? null : prev);
            }
            setProgressMap(prev => { const n = { ...prev }; delete n[id]; return n; });
        }
    }, []);

    const handleCancel = useCallback((episode) => {
        const id = episode.id;
        const svcActive = getActiveId();
        const wasActive = svcActive === id;
        log('UI', 'Cancel tapped', {
            id, title: episode.title,
            wasActive, svcActiveId: svcActive, queueBefore: getQueueIds(),
        });
        setProgressMap(prev => { const n = { ...prev }; delete n[id]; return n; });
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

    const handleRemoveTranscript = async (episode) => {
        log('UI', 'Remove transcript', { id: episode.id, title: episode.title });
        await deleteEpisodeTranscript(episode.id);
        loadData();
    };

    const handleDelete = async (episode) => {
        log('UI', 'Delete episode', { id: episode.id, title: episode.title });
        dequeueTranscription(episode.id);
        if (episode.local_audio_path) await deleteAudioFile(episode.local_audio_path);
        await deleteEpisodeLocalData(episode.id);
        loadData();
    };

    return (
        <View style={styles.container}>
            <FlatList
                data={episodes}
                keyExtractor={item => item.id.toString()}
                renderItem={({ item }) => {
                    const isActive   = activeId === item.id;
                    const isQueued   = queuedIds.includes(item.id);
                    const progress   = progressMap[item.id] ?? 0;
                    const btnState   = isActive ? 'Transcribing'
                                     : (isQueued && !isActive) ? 'Queued'
                                     : item.has_transcript ? 'HasTranscript'
                                     : 'Idle';

                    return (
                        <SwipeableRow
                            onDelete={() => handleDelete(item)}
                            onRemoveTranscript={item.has_transcript ? () => handleRemoveTranscript(item) : undefined}
                        >
                            <EpisodeItem
                                episode={item}
                                onPress={(ep) => {
                                    log('UI', 'Episode tapped → Player', { id: ep.id, title: ep.title, btnState });
                                    navigation.navigate('Player', { episode: ep });
                                }}
                                onTranscribe={!isQueued && !isActive ? handleTranscribe : undefined}
                                onCancel={handleCancel}
                                isTranscribing={isActive}
                                transcribeProgress={isActive ? progress : 0}
                                isQueued={isQueued && !isActive}
                            />
                        </SwipeableRow>
                    );
                }}
                contentContainerStyle={episodes.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 130 }}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        <View style={styles.emptyIcon}>
                            <Icon name="archive" size={26} color="#3A3A3C" />
                        </View>
                        <Text style={styles.emptyTitle}>Library is empty</Text>
                        <Text style={styles.emptySubtitle}>
                            Downloaded episodes appear here for offline listening
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
        width: ACTION_WIDTH,
        backgroundColor: '#FF453A',
        alignItems: 'center',
        justifyContent: 'center',
    },
    transcriptAction: {
        position: 'absolute',
        left: 0, top: 0, bottom: 0,
        width: ACTION_WIDTH,
        backgroundColor: '#636DAE',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
    },
    actionLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: '#fff',
        letterSpacing: 0.2,
    },
});

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0C0C0E' },
    empty: { flex: 1, alignItems: 'center', paddingHorizontal: 40, paddingTop: 80 },
    emptyIcon: {
        width: 64, height: 64,
        backgroundColor: '#141416',
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
    },
    emptyTitle:    { fontSize: 20, fontWeight: '700', color: '#FFFFFF', marginBottom: 8 },
    emptySubtitle: { fontSize: 14, color: '#636366', textAlign: 'center', lineHeight: 21 },
});

export default DownloadedTimeline;
