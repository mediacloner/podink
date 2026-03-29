import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, Image } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
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
                    text: 'Unsubscribe', style: 'destructive', onPress: async () => {
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
                    <Icon name="mic" size={24} color="#555" />
                </View>
            )}
            <View style={styles.info}>
                <Text style={styles.podcastTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.podcastDesc} numberOfLines={2}>{item.description?.replace(/<[^>]+>/g, '') || ''}</Text>
            </View>
            <TouchableOpacity style={styles.unsubBtn} onPress={() => handleUnsubscribe(item)}>
                <Icon name="user-minus" size={18} color="#e24a4a" />
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={styles.container}>
            <FlatList
                data={podcasts}
                keyExtractor={item => item.id.toString()}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Icon name="rss" size={48} color="#333" />
                        <Text style={styles.emptyText}>No subscriptions yet</Text>
                        <Text style={styles.emptySubText}>Add an RSS feed URL from the Timeline tab</Text>
                    </View>
                }
                renderItem={renderPodcast}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#121212' },
    row: { flexDirection: 'row', alignItems: 'center', padding: 16 },
    artwork: { width: 56, height: 56, borderRadius: 8, marginRight: 14 },
    artworkPlaceholder: { backgroundColor: '#222', alignItems: 'center', justifyContent: 'center' },
    info: { flex: 1 },
    podcastTitle: { color: '#fff', fontSize: 15, fontWeight: 'bold', marginBottom: 4 },
    podcastDesc: { color: '#888', fontSize: 12, lineHeight: 17 },
    unsubBtn: { padding: 10 },
    separator: { height: 1, backgroundColor: '#222', marginLeft: 86 },
    emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingTop: 100 },
    emptyText: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginTop: 20 },
    emptySubText: { color: '#888', fontSize: 14, marginTop: 8, textAlign: 'center', paddingHorizontal: 40 }
});

export default PodcastsScreen;
