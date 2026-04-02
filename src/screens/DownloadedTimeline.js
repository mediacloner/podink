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
} from '../services/whisperService';
import { deleteAudioFile } from '../services/downloadService';

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
    const prevQueueLenRef = useRef(0);
    const syncQueue = useCallback(() => {
        const ids = getQueueIds();
        const prevLen = prevQueueLenRef.current;
        prevQueueLenRef.current = ids.length;
        setQueuedIds(ids);
        if (ids.length < prevLen) {
            // An item left the queue — reload so has_transcript flag is current
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
        }
    }, [isFocused]);

    const loadData = async () => {
        const data = await getDownloadedEpisodes();
        setEpisodes(data);
    };

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
            loadData();
        } catch (e) {
            if (e.message !== 'Cancelled' && e.message !== 'Already queued') {
                showAlert(
                    'Transcription Failed',
                    'Could not transcribe this episode. Make sure the AI model is downloaded in Settings.',
                );
            }
        } finally {
            setActiveId(prev => prev === id ? null : prev);
            setProgressMap(prev => { const n = { ...prev }; delete n[id]; return n; });
        }
    }, []);

    const handleCancel = useCallback((episode) => {
        const id = episode.id;
        // Clear UI state immediately so the button reverts right away,
        // without waiting for the native abort to propagate back through the promise.
        setActiveId(prev => prev === id ? null : prev);
        setProgressMap(prev => { const n = { ...prev }; delete n[id]; return n; });
        dequeueTranscription(id);
    }, []);

    const handleRemoveTranscript = async (episode) => {
        await deleteEpisodeTranscript(episode.id);
        loadData();
    };

    const handleDelete = async (episode) => {
        // Remove from queue if waiting
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

                    return (
                        <SwipeableRow
                            onDelete={() => handleDelete(item)}
                            onRemoveTranscript={item.has_transcript ? () => handleRemoveTranscript(item) : undefined}
                        >
                            <EpisodeItem
                                episode={item}
                                onPress={(ep) => navigation.navigate('Player', { episode: ep })}
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
