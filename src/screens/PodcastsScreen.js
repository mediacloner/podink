import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, Image } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { getPodcasts, deletePodcast } from '../database/queries';

const PodcastsScreen = () => {
    const [podcasts, setPodcasts] = useState([]);
    const isFocused = useIsFocused();

    useEffect(() => {
        if (isFocused) loadPodcasts();
    }, [isFocused]);

    const loadPodcasts = async () => {
        const data = await getPodcasts();
        setPodcasts(data);
    };

    const handleUnsubscribe = (podcast) => {
        Alert.alert(
            'Unsubscribe',
            `Remove "${podcast.title}" and all its episodes?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove', style: 'destructive', onPress: async () => {
                        await deletePodcast(podcast.feed_url);
                        loadPodcasts();
                    }
                }
            ]
        );
    };

    const renderPodcast = ({ item }) => (
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
            <TouchableOpacity
                style={styles.removeBtn}
                onPress={() => handleUnsubscribe(item)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
                <Icon name="trash-2" size={17} color="#3A3A3C" />
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={styles.container}>
            <FlatList
                data={podcasts}
                keyExtractor={item => item.id.toString()}
                renderItem={renderPodcast}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                contentContainerStyle={podcasts.length === 0 ? { flex: 1 } : undefined}
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

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0C0C0E' },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 14,
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
    info: { flex: 1, gap: 4, marginRight: 12 },
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
    removeBtn: {
        padding: 4,
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
