import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, View, FlatList, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import EpisodeItem from '../components/EpisodeItem';
import { getDownloadedEpisodes, saveTranscripts, deleteEpisodeLocalData } from '../database/queries';
import {
    initializeWhisper,
    enqueueTranscription,
    dequeueTranscription,
    onQueueChange,
    getQueueIds,
} from '../services/whisperService';
import { deleteAudioFile } from '../services/downloadService';

// ─── Swipeable delete row ─────────────────────────────────────────────────────

const DELETE_WIDTH = 80;
const SWIPE_THRESHOLD = 50;

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

// ─── Screen ───────────────────────────────────────────────────────────────────

const DownloadedTimeline = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes]         = useState([]);
    const [activeId, setActiveId]         = useState(null);
    const [queuedIds, setQueuedIds]       = useState([]);
    const [progressMap, setProgressMap]   = useState({}); // { [id]: 0-99 }
    const isFocused = useIsFocused();

    // Sync queue state from the service
    const syncQueue = useCallback(() => {
        setQueuedIds(getQueueIds());
    }, []);

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

        try {
            const segments = await enqueueTranscription(
                episode.id,
                episode.local_audio_path,
                (p) => setProgressMap(prev => ({ ...prev, [episode.id]: p })),
                ()  => setActiveId(episode.id),
            );
            await saveTranscripts(episode.id, segments);
            setActiveId(null);
            setProgressMap(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
            loadData();
        } catch (e) {
            setActiveId(null);
            setProgressMap(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
            if (e.message !== 'Cancelled' && e.message !== 'Already queued') {
                // Alert only for real failures, shown after the episode's turn
                console.error('Transcription failed', e);
            }
        }
    }, []);

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
                        <SwipeableRow onDelete={() => handleDelete(item)}>
                            <EpisodeItem
                                episode={item}
                                onPress={(ep) => navigation.navigate('Player', { episode: ep })}
                                onTranscribe={!isQueued ? handleTranscribe : undefined}
                                isTranscribing={isActive}
                                transcribeProgress={isActive ? progress : 0}
                                isQueued={isQueued && !isActive}
                            />
                        </SwipeableRow>
                    );
                }}
                contentContainerStyle={episodes.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 50 }}
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
        width: DELETE_WIDTH,
        backgroundColor: '#FF453A',
        alignItems: 'center',
        justifyContent: 'center',
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
