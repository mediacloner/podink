import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { showAlert } from '../components/AppAlert';
import EpisodeItem from '../components/EpisodeItem';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import SegmentedControl from '../components/SegmentedControl';
import EmptyState from '../components/EmptyState';
import { getEpisodesByListeningState } from '../database/queries';
import {
    downloadEpisode, markListened, markUnlistened, removeEpisodeDownload, reportDownloadError,
} from '../services/episodeService';
import { onLibraryChange } from '../services/libraryEvents';
import { log } from '../services/logService';
import { useStyles, useTheme } from '../theme';

// "Listening" — the listening pipeline, one segment per stage:
//   Downloaded   on the device, not started   newest release first
//   In progress  started, unfinished          most recently heard first
//   Finished     played to the end            most recently finished first
// Episodes that are neither downloaded nor started live in the Feed only.
// Tapping a row opens it in the Player. Swipe right (left→right) reveals
// Done — or, on a finished row, Unplayed (back to not-started); both stop the
// episode first if it is the one playing (episodeService). Swipe left toggles
// what is on the device: Delete on downloaded rows (audio + transcript go —
// the row leaves the Downloaded segment, stays in the other two) or Download
// on the others — which also queues the transcript, so a Finished episode
// whose download was deleted can be read along again from right here.
const FILTERS = [
    { id: 'downloaded',  label: 'Downloaded' },
    { id: 'in-progress', label: 'In progress' },
    { id: 'finished',    label: 'Finished' },
];
const DEFAULT_FILTER = 'in-progress';
const FILTER_KEY = '@listening_filter';

const EMPTY_COPY = {
    'downloaded': {
        icon: 'download',
        title: 'Nothing downloaded',
        subtitle: 'Episodes you download wait here, transcript ready, until you start them',
    },
    'in-progress': {
        icon: 'play-circle',
        title: 'Nothing in progress',
        subtitle: "Episodes you start but don't finish wait here, so you can pick up where you left off",
    },
    'finished': {
        icon: 'check-circle',
        title: 'Nothing finished yet',
        subtitle: 'Episodes you play to the end are collected here',
    },
};

const ListeningRow = React.memo(({
    episode, filter, isDownloading, downloadProgress,
    onOpen, onMarkPlayed, onMarkUnplayed, onDelete, onDownload,
}) => {
    const { colors } = useTheme();
    const leftAction = filter === 'finished'
        ? {
            icon: 'rotate-ccw',
            label: 'Unplayed',
            color: colors.indigo,
            dismiss: 'slide-out',
            onPress: () => onMarkUnplayed(episode),
            accessibilityLabel: `Mark ${episode.title} as not played`,
        }
        : {
            icon: 'check-circle',
            label: 'Done',
            color: colors.success,
            dismiss: 'slide-out',
            onPress: () => onMarkPlayed(episode),
            accessibilityLabel: `Mark ${episode.title} as played`,
        };
    // Swipe left toggles the on-device state; hidden while a download runs.
    let rightAction;
    if (isDownloading) {
        rightAction = undefined;
    } else if (episode.is_downloaded) {
        rightAction = {
            icon: 'trash-2',
            color: colors.danger,
            // Downloaded segment: the row leaves with its file. Elsewhere only
            // the download goes and the row stays in its segment.
            dismiss: filter === 'downloaded' ? 'slide-out' : 'ack',
            onPress: () => onDelete(episode),
            accessibilityLabel: `Delete download of ${episode.title}`,
        };
    } else {
        rightAction = {
            icon: 'arrow-down-circle',
            label: 'Download',
            color: colors.accent,
            dismiss: 'ack', // the row stays; the meta row shows the progress
            onPress: () => onDownload(episode),
            accessibilityLabel: `Download ${episode.title}`,
        };
    }
    return (
        <SwipeableRow leftAction={leftAction} rightAction={rightAction}>
            <EpisodeItem
                episode={episode}
                onPress={onOpen}
                showArtwork
                hideActions
                isDownloading={isDownloading}
                downloadProgress={downloadProgress}
            />
        </SwipeableRow>
    );
});

const ListeningScreen = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const [episodes, setEpisodes] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    // { [episodeId]: progress 0-100 } for swipe-to-download rows
    const [downloads, setDownloads] = useState({});
    // null until the remembered segment is read, so the list never flashes
    // the default segment's rows before switching.
    const [filter, setFilter] = useState(null);
    const isFocused = useIsFocused();
    // Mirrors for the library-event listener, which is subscribed once.
    const focusedRef = useRef(isFocused);
    focusedRef.current = isFocused;
    const filterRef = useRef(filter);
    filterRef.current = filter;

    useEffect(() => {
        let alive = true;
        AsyncStorage.getItem(FILTER_KEY)
            .then((saved) => { if (alive) setFilter(FILTERS.some(f => f.id === saved) ? saved : DEFAULT_FILTER); })
            .catch(() => { if (alive) setFilter(DEFAULT_FILTER); });
        return () => { alive = false; };
    }, []);

    const changeFilter = useCallback((id) => {
        setFilter(id);
        AsyncStorage.setItem(FILTER_KEY, id).catch(() => {});
    }, []);

    const loadData = useCallback(async (which = filterRef.current) => {
        if (!which) return;
        try {
            const rows = await getEpisodesByListeningState(which);
            // A segment switch mid-query must not paint the old segment's rows.
            if (filterRef.current === which) setEpisodes(rows);
        } catch (e) {
            log('UI', 'Listening load failed', { filter: which, error: e?.message || String(e) });
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => { if (isFocused && filter) loadData(filter); }, [isFocused, filter, loadData]);

    // Every persisted position (~5s while playing) arrives as
    // 'playback-progress', so the "x left" labels and bars stay live while
    // this tab is on screen. Off screen, the focus reload above covers it —
    // no point redrawing a list nobody is looking at.
    useEffect(() => onLibraryChange((payload) => {
        if (!focusedRef.current || !filterRef.current) return;
        if (payload?.type === 'transcript-progress') return;
        loadData();
    }), [loadData]);

    const handleOpen = useCallback((episode) => {
        log('UI', 'Listening row tapped → Player', { id: episode.id, title: episode.title });
        navigation.navigate('Player', { episode });
    }, [navigation]);

    const handleMarkPlayed = useCallback(async (episode) => {
        try {
            // Stops the episode first if it is the one playing — otherwise the
            // next progress save would flip it straight back to In progress.
            await markListened(episode);
        } catch (e) {
            log('UI', 'Mark played failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Could not update', 'Please try again.');
            loadData();
            return false; // SwipeableRow springs the row back
        }
        loadData();
    }, [loadData]);

    const handleMarkUnplayed = useCallback(async (episode) => {
        try {
            await markUnlistened(episode);
        } catch (e) {
            log('UI', 'Mark unplayed failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Could not update', 'Please try again.');
            loadData();
            return false;
        }
        loadData();
    }, [loadData]);

    const handleDelete = useCallback(async (episode) => {
        log('UI', 'Listening delete download', { id: episode.id, title: episode.title });
        try {
            await removeEpisodeDownload(episode);
        } catch (e) {
            log('UI', 'Listening delete failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Delete failed', 'Could not remove this download. Please try again.');
            loadData();
            return false; // a slid-out Downloaded row springs back
        }
        loadData();
    }, [loadData]);

    // Download (and, automatically, transcribe) a streamed row — the way back
    // to a read-along for a Finished episode whose download was deleted.
    const handleDownload = useCallback(async (episode) => {
        log('UI', 'Listening download', { id: episode.id, title: episode.title });
        setDownloads(prev => ({ ...prev, [episode.id]: 0 }));
        try {
            await downloadEpisode(episode, {
                onProgress: (p) => setDownloads(prev => {
                    const pct = Math.round(p);
                    return prev[episode.id] === pct ? prev : { ...prev, [episode.id]: pct };
                }),
            });
        } catch (e) {
            log('UI', 'Listening download failed', { id: episode.id, error: e?.message || String(e) });
            reportDownloadError(e);
        } finally {
            setDownloads(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
        }
        loadData();
    }, [loadData]);

    const renderItem = useCallback(({ item }) => (
        <ListeningRow
            episode={item}
            filter={filter}
            isDownloading={item.id in downloads}
            downloadProgress={downloads[item.id] ?? 0}
            onOpen={handleOpen}
            onMarkPlayed={handleMarkPlayed}
            onMarkUnplayed={handleMarkUnplayed}
            onDelete={handleDelete}
            onDownload={handleDownload}
        />
    ), [filter, downloads, handleOpen, handleMarkPlayed, handleMarkUnplayed, handleDelete, handleDownload]);

    const empty = EMPTY_COPY[filter] || EMPTY_COPY[DEFAULT_FILTER];

    return (
        <View style={styles.container}>
            <SegmentedControl
                options={FILTERS}
                value={filter || DEFAULT_FILTER}
                onChange={changeFilter}
                style={styles.filters}
            />
            {isLoading || !filter ? (
                <View style={styles.loadingWrap}>
                    <ActivityIndicator size="large" color={colors.accent} />
                </View>
            ) : (
                <FlatList
                    style={styles.list}
                    data={episodes}
                    keyExtractor={item => item.id.toString()}
                    renderItem={renderItem}
                    extraData={filter}
                    // flexGrow (not flex) — with the segmented control above
                    // the list, flex: 1 on the content sized it to about twice
                    // the viewport and the empty state centred off-screen.
                    contentContainerStyle={episodes.length === 0 ? { flexGrow: 1 } : { paddingBottom: bottom + 130 }}
                    initialNumToRender={10}
                    maxToRenderPerBatch={10}
                    windowSize={7}
                    onScrollBeginDrag={closeOpenRow}
                    ListEmptyComponent={
                        <EmptyState icon={empty.icon} title={empty.title} subtitle={empty.subtitle} />
                    }
                />
            )}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    filters: { marginHorizontal: 16, marginTop: 4, marginBottom: 8 },
    list: { flex: 1 },
    loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default ListeningScreen;
