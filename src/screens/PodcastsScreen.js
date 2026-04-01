import React, { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, View, Text, FlatList, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { getPodcasts, deletePodcast } from '../database/queries';

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

const PodcastsScreen = () => {
    const { bottom } = useSafeAreaInsets();
    const [podcasts, setPodcasts] = useState([]);
    const isFocused = useIsFocused();

    useEffect(() => {
        if (isFocused) loadPodcasts();
    }, [isFocused]);

    const loadPodcasts = async () => {
        const data = await getPodcasts();
        setPodcasts(data);
    };

    const handleUnsubscribe = async (podcast) => {
        await deletePodcast(podcast.feed_url);
        loadPodcasts();
    };

    const renderPodcast = ({ item }) => (
        <SwipeableRow onDelete={() => handleUnsubscribe(item)}>
            <View style={styles.row}>
                {item.image_url ? (
                    <Image source={{ uri: item.image_url }} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkPlaceholder]}>
                        <Icon name="headphones" size={22} color="#3A3A3C" />
                    </View>
                )}
                <View style={styles.info}>
                    <Text style={styles.podcastTitle} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.podcastDesc} numberOfLines={2}>
                        {item.description?.replace(/<[^>]+>/g, '') || ''}
                    </Text>
                </View>
            </View>
        </SwipeableRow>
    );

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
