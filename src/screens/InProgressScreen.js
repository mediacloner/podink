import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { showAlert } from '../components/AppAlert';
import EpisodeItem from '../components/EpisodeItem';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import EmptyState from '../components/EmptyState';
import { getInProgressEpisodes, markEpisodeFinished } from '../database/queries';
import { notifyLibraryChange, onLibraryChange } from '../services/libraryEvents';
import { log } from '../services/logService';
import { useStyles, useTheme } from '../theme';

// "Continue Listening" — every episode started but not finished, most recently
// heard first. Tapping a row resumes it in the Player; swiping left marks it
// played, which drops it from the list (same end state as a natural finish).
const InProgressRow = React.memo(({ episode, onOpen, onMarkPlayed }) => {
    const { colors } = useTheme();
    return (
        <SwipeableRow
            rightAction={{
                icon: 'check-circle',
                label: 'Done',
                color: colors.success,
                dismiss: 'slide-out',
                onPress: () => onMarkPlayed(episode),
                accessibilityLabel: `Mark ${episode.title} as played`,
            }}
        >
            <EpisodeItem episode={episode} onPress={onOpen} showArtwork hideActions />
        </SwipeableRow>
    );
});

const InProgressScreen = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const isFocused = useIsFocused();
    // Mirror for the library-event listener, which is subscribed once.
    const focusedRef = useRef(isFocused);
    focusedRef.current = isFocused;

    const loadData = useCallback(async () => {
        try {
            setEpisodes(await getInProgressEpisodes());
        } catch (e) {
            log('UI', 'In-progress load failed', { error: e?.message || String(e) });
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => { if (isFocused) loadData(); }, [isFocused, loadData]);

    // Every persisted position (~5s while playing) arrives as
    // 'playback-progress', so the "x left" labels and bars stay live while
    // this tab is on screen. Off screen, the focus reload above covers it —
    // no point redrawing a list nobody is looking at.
    useEffect(() => onLibraryChange((payload) => {
        if (!focusedRef.current) return;
        if (payload?.type === 'transcript-progress') return;
        loadData();
    }), [loadData]);

    const handleOpen = useCallback((episode) => {
        log('UI', 'In-progress row tapped → Player', { id: episode.id, title: episode.title });
        navigation.navigate('Player', { episode });
    }, [navigation]);

    const handleMarkPlayed = useCallback(async (episode) => {
        log('UI', 'Mark played', { id: episode.id, title: episode.title });
        try {
            await markEpisodeFinished(episode.id);
            // Same event a natural finish emits, so Feed / My Podcasts rows
            // pick up their Played badge.
            notifyLibraryChange({ type: 'playback-complete', episodeId: episode.id });
        } catch (e) {
            log('UI', 'Mark played failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Could not update', 'Please try again.');
            loadData();
            return false; // SwipeableRow springs the row back
        }
        loadData();
    }, [loadData]);

    const renderItem = useCallback(({ item }) => (
        <InProgressRow episode={item} onOpen={handleOpen} onMarkPlayed={handleMarkPlayed} />
    ), [handleOpen, handleMarkPlayed]);

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
                        icon="play-circle"
                        title="Nothing in progress"
                        subtitle="Episodes you start but don't finish wait here, so you can pick up where you left off"
                    />
                }
            />
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    loadingWrap: { alignItems: 'center', justifyContent: 'center' },
});

export default InProgressScreen;
