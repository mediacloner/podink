import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator, FlatList, Image, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import NetInfo from '@react-native-community/netinfo';
import { Feather as Icon } from '@expo/vector-icons';
import { showAlert } from '../components/AppAlert';
import EpisodeItem from '../components/EpisodeItem';
import EmptyState from '../components/EmptyState';
import Pill from '../components/Pill';
import {
    getPodcastByFeedUrl, getStoredEpisodesForPodcast, saveEpisode, YOUTUBE_KIND,
} from '../database/queries';
import {
    downloadEpisode, reportDownloadError, reportTranscriptionError, transcribeEpisode,
} from '../services/episodeService';
import { dequeueTranscription } from '../services/whisperService';
import { useTranscriptionQueue } from '../hooks/useTranscriptionQueue';
import { openFeedHistory } from '../api/rssParser';
import { artworkSource } from '../api/userAgent';
import { onLibraryChange } from '../services/libraryEvents';
import { log } from '../services/logService';
import { type, useStyles, useTheme } from '../theme';

// Items parsed per step, and the pause between steps that lets taps and
// scrolls through. A hundred items parse in well under a second on the phone.
const PAGE = 100;
const BREATHER_MS = 40;

const EMPTY_STORED = { list: [], byId: {} };

/**
 * A podcast's whole back catalogue (4.5.1), opened from "More episodes"
 * under the latest five in My Podcasts.
 *
 * The rows on the device (at most the feed's latest 50, plus anything
 * downloaded or started) show at once and are all there is offline. Online,
 * the feed is fetched once and parsed a page at a time (rssParser.
 * openFeedHistory); the list switches to it as the first page lands and
 * grows behind while you scroll or search by title. A feed item that is
 * also on the device is shown as its row — downloaded, transcript, played,
 * position — and one that is not is written to the database only when you
 * open or download it, as seen (is_new 0), so the badges never count it.
 *
 * A YouTube channel has no feed: its screen is the imported videos, which
 * the five-row accordion cannot hold once there are more than five.
 */
const PodcastEpisodesScreen = ({ navigation, route }) => {
    const { feedUrl } = route.params;
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const isFocused = useIsFocused();
    const { activeId, queuedIds } = useTranscriptionQueue();
    const [podcast, setPodcast] = useState(null);
    const [storedLoaded, setStoredLoaded] = useState(false);
    // Rows on the device, by id — the state a feed item is shown with.
    const [stored, setStored] = useState(EMPTY_STORED);
    const storedRef = useRef(EMPTY_STORED);
    useEffect(() => { storedRef.current = stored; }, [stored]);
    // Normalized feed items, newest first, growing a page at a time.
    const [feedItems, setFeedItems] = useState([]);
    const [total, setTotal] = useState(null);
    // idle → loading → done; or offline / error (the on-device rows stand
    // in); none for a channel without a feed.
    const [feedStatus, setFeedStatus] = useState('idle');
    const [query, setQuery] = useState('');
    const [downloads, setDownloads] = useState({}); // { [episodeId]: progress 0-100 }
    const [isConnected, setIsConnected] = useState(true);
    // Bumped to abandon a page loop: a retry, or leaving the screen.
    const runRef = useRef(0);

    const isYouTube = podcast?.kind === YOUTUBE_KIND;

    useEffect(() => {
        const unsub = NetInfo.addEventListener(state => setIsConnected(state.isConnected !== false));
        return () => unsub();
    }, []);
    useEffect(() => () => { runRef.current += 1; }, []);

    const loadStored = useCallback(async () => {
        try {
            const [p, rows] = await Promise.all([getPodcastByFeedUrl(feedUrl), getStoredEpisodesForPodcast(feedUrl)]);
            setPodcast(p || null);
            const byId = {};
            rows.forEach(r => { byId[r.id] = r; });
            setStored({ list: rows, byId });
        } catch (e) {
            log('UI', 'Podcast episodes load failed', { feedUrl, error: e?.message || String(e) });
        } finally {
            setStoredLoaded(true);
        }
    }, [feedUrl]);

    // Reads the feed and parses it page by page into feedItems. Each page
    // yields to the UI before the next; leaving the screen or a retry stops
    // the loop at the next boundary.
    const loadFeed = useCallback(async () => {
        const run = ++runRef.current;
        const live = () => runRef.current === run;
        setFeedStatus('loading');
        try {
            const history = await openFeedHistory(feedUrl);
            if (!live()) return;
            setTotal(history.total);
            const seen = new Set();
            for (let offset = 0; offset < history.total; offset += PAGE) {
                const items = await history.page(offset, PAGE);
                if (!live()) return;
                // Un-keyable items are never stored either; a guid repeated in
                // the feed would be two rows with one key.
                const fresh = items.filter(it => it.id && !seen.has(it.id));
                fresh.forEach(it => seen.add(it.id));
                setFeedItems(prev => (offset === 0 ? fresh : prev.concat(fresh)));
                if (offset + PAGE < history.total) {
                    await new Promise(resolve => setTimeout(resolve, BREATHER_MS));
                }
            }
            if (live()) setFeedStatus('done');
        } catch (e) {
            if (!live()) return;
            log('UI', 'Feed history failed', { feedUrl, error: e?.message || String(e) });
            setFeedStatus('error');
        }
    }, [feedUrl]);

    // The on-device rows: on open, on return from the Player (position,
    // played), and whenever a download / transcription lands anywhere.
    // Per-window transcript ticks and ~5 s position saves are skipped.
    useEffect(() => { if (isFocused) loadStored(); }, [isFocused, loadStored]);
    useEffect(() => onLibraryChange((payload) => {
        const t = payload?.type;
        if (t === 'transcript-progress' || t === 'playback-progress') return;
        loadStored();
    }), [loadStored]);

    // Start on the feed once the podcast row says what kind it is.
    useEffect(() => {
        if (!podcast || feedStatus !== 'idle') return undefined;
        if (podcast.kind === YOUTUBE_KIND) { setFeedStatus('none'); return undefined; }
        let cancelled = false;
        NetInfo.fetch().catch(() => null).then(net => {
            if (cancelled) return;
            if (net?.isConnected === false) setFeedStatus('offline');
            else loadFeed();
        });
        return () => { cancelled = true; };
    }, [podcast, feedStatus, loadFeed]);

    // Back online while the list is the on-device one: fetch the feed now.
    useEffect(() => {
        if (isConnected && feedStatus === 'offline') loadFeed();
    }, [isConnected, feedStatus, loadFeed]);

    useEffect(() => {
        navigation.setOptions({ title: podcast?.title || '' });
    }, [navigation, podcast?.title]);

    // A feed item shaped like an Episodes row: the pills read is_downloaded /
    // has_transcript, the meta line reads is_played / play_position.
    const asEpisode = useCallback((item) => ({
        id: item.id,
        title: item.title,
        description: item.description || '',
        podcast_title: podcast?.title || '',
        podcast_feed_url: feedUrl,
        release_date: item.release_date,
        audio_url: item.enclosure,
        local_audio_path: null,
        is_downloaded: 0,
        has_transcript: 0,
        play_position: 0,
        is_played: 0,
        is_new: 0,
        duration: item.duration || 0,
        image_url: podcast?.image_url || null,
        podcast_kind: podcast?.kind || 'rss',
        books_count: 0,
    }), [podcast, feedUrl]);

    const rows = useMemo(() => {
        if (feedItems.length === 0) return stored.list;
        const inFeed = new Set();
        const out = feedItems.map(item => {
            inFeed.add(item.id);
            return stored.byId[item.id] || asEpisode(item);
        });
        if (feedStatus === 'done') {
            // Downloads and started episodes the feed has since dropped.
            const gone = stored.list.filter(r => !inFeed.has(r.id));
            if (gone.length > 0) {
                out.push(...gone);
                out.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
            }
        }
        return out;
    }, [feedItems, stored, feedStatus, asEpisode]);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(r => String(r.title || '').toLowerCase().includes(q));
    }, [rows, query]);

    // A row that came from the feed alone has no Episodes row yet; the Player
    // re-reads by id and a download updates by id, so write it first.
    const ensureStored = useCallback(async (episode) => {
        if (storedRef.current.byId[episode.id]) return;
        await saveEpisode({ ...episode, is_new: 0 });
        await loadStored();
    }, [loadStored]);

    const openEpisode = useCallback(async (episode) => {
        try {
            await ensureStored(episode);
        } catch (e) {
            log('UI', 'Could not store episode before opening', { id: episode.id, error: e?.message || String(e) });
        }
        navigation.navigate('Player', { episode });
    }, [ensureStored, navigation]);

    // The download queues its own transcription (episodeService), so the row
    // goes Download → Downloaded → Queued / % → Transcript without another
    // tap; the 'download-complete' event reloads the rows.
    const handleDownload = useCallback(async (episode) => {
        log('UI', 'Download tapped', { id: episode.id, title: episode.title, from: 'history' });
        if (!isConnected) {
            showAlert('Offline', 'You need an internet connection to download episodes.');
            return;
        }
        if (!episode.audio_url) return;
        setDownloads(prev => ({ ...prev, [episode.id]: 0 }));
        try {
            await ensureStored(episode);
            await downloadEpisode(episode, {
                onProgress: (p) => setDownloads(prev => {
                    // Whole percent only: the same object for sub-percent
                    // ticks skips the re-render.
                    const pct = Math.round(p);
                    return prev[episode.id] === pct ? prev : { ...prev, [episode.id]: pct };
                }),
            });
        } catch (e) {
            log('UI', 'Download failed', { id: episode.id, error: e?.message || String(e) });
            reportDownloadError(e);
        } finally {
            setDownloads(prev => { const n = { ...prev }; delete n[episode.id]; return n; });
        }
    }, [isConnected, ensureStored]);

    // The Transcribe pill shows on a downloaded row whose automatic
    // transcription failed or was cancelled — this is the retry.
    const handleTranscribe = useCallback(async (episode) => {
        if (!episode.local_audio_path) {
            await handleDownload(episode);
            return;
        }
        try {
            await transcribeEpisode(episode);
        } catch (e) {
            reportTranscriptionError(e, episode);
        }
    }, [handleDownload]);

    const handleCancel = useCallback((episode) => {
        dequeueTranscription(episode.id);
    }, []);

    const renderItem = useCallback(({ item }) => (
        <EpisodeItem
            episode={item}
            onPress={openEpisode}
            onDownload={handleDownload}
            onTranscribe={handleTranscribe}
            onCancel={handleCancel}
            isDownloading={item.id in downloads}
            downloadProgress={downloads[item.id] ?? 0}
            isTranscribing={activeId === item.id}
            isQueued={queuedIds.includes(item.id) && activeId !== item.id}
        />
    ), [openEpisode, handleDownload, handleTranscribe, handleCancel, downloads, activeId, queuedIds]);

    // ── Summary line ──────────────────────────────────────────────────────
    const count = total ?? rows.length;
    const noun = isYouTube ? 'video' : 'episode';
    const countLabel = `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`;
    const complete = feedStatus === 'done' || feedStatus === 'none';
    const oldest = complete && rows.length > 0 ? rows[rows.length - 1].release_date : null;
    const sinceLabel = oldest
        ? ` · since ${new Date(oldest).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
        : '';
    const onDevice = stored.list.length;
    const onDeviceLabel = `the ${onDevice} ${onDevice === 1 ? noun : `${noun}s`} on this device`;

    let status = null;
    if (feedStatus === 'loading') {
        status = (
            <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.statusText}>
                    {total === null
                        ? 'Fetching the feed…'
                        : `Loading the full list… ${feedItems.length.toLocaleString()} of ${total.toLocaleString()}`}
                </Text>
            </View>
        );
    } else if (feedStatus === 'offline') {
        status = (
            <View style={styles.statusRow}>
                <Icon name="wifi-off" size={12} color={colors.textMuted} />
                <Text style={styles.statusText}>You're offline — showing {onDeviceLabel}</Text>
            </View>
        );
    } else if (feedStatus === 'error') {
        status = (
            <View style={styles.statusRow}>
                <Text style={styles.statusText}>Couldn't load the feed — showing {onDeviceLabel}</Text>
                <Pill variant="blue" icon="refresh-cw" label="Retry" onPress={loadFeed} accessibilityLabel="Retry loading the feed" />
            </View>
        );
    }

    if (!storedLoaded) {
        return (
            <View style={[styles.container, styles.loadingWrap]}>
                <ActivityIndicator size="large" color={colors.accent} />
            </View>
        );
    }

    const emptyState = query.trim()
        ? (
            <EmptyState
                icon="search"
                title="No episodes match"
                subtitle={feedStatus === 'loading'
                    ? 'The full list is still loading — it may turn up in a moment'
                    : `Nothing titled “${query.trim()}”`}
            />
        ) : (
            <EmptyState
                icon={isYouTube ? 'youtube' : 'headphones'}
                title={isYouTube ? 'No videos yet' : 'No episodes yet'}
                subtitle={feedStatus === 'loading' ? 'Loading the feed…' : feedStatus === 'offline'
                    ? 'Connect to the internet to load this podcast\'s episodes'
                    : 'This feed has no episodes to show'}
            />
        );

    return (
        <View style={styles.container}>
            <View style={styles.summary}>
                {podcast?.image_url ? (
                    <Image source={artworkSource(podcast.image_url)} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkPlaceholder]}>
                        <Icon name={isYouTube ? 'youtube' : 'headphones'} size={20} color={colors.textFaint} />
                    </View>
                )}
                <View style={styles.summaryInfo}>
                    <Text style={styles.summaryCount}>{countLabel}{sinceLabel}</Text>
                    {status}
                </View>
            </View>

            <View style={styles.searchWrap}>
                <Icon name="search" size={14} color={colors.textMuted} />
                <TextInput
                    style={styles.searchInput}
                    placeholder={isYouTube ? 'Search these videos by title' : 'Search episodes by title'}
                    placeholderTextColor={colors.textMuted}
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    accessibilityLabel="Search episodes by title"
                />
                {query.length > 0 && (
                    <TouchableOpacity
                        onPress={() => setQuery('')}
                        hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                    >
                        <Icon name="x" size={14} color={colors.textMuted} />
                    </TouchableOpacity>
                )}
            </View>

            <FlatList
                data={shown}
                keyExtractor={item => String(item.id)}
                renderItem={renderItem}
                initialNumToRender={12}
                maxToRenderPerBatch={12}
                windowSize={7}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={shown.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 130 }}
                ListEmptyComponent={emptyState}
            />
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    loadingWrap: { alignItems: 'center', justifyContent: 'center' },

    summary: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 12,
    },
    artwork: {
        width: 48,
        height: 48,
        borderRadius: 10,
        backgroundColor: colors.surfaceElevated,
    },
    artworkPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    summaryInfo: { flex: 1, gap: 4 },
    summaryCount: { ...type.bodyStrong, color: colors.textPrimary },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    statusText: { ...type.body, color: colors.textMuted, flexShrink: 1 },

    searchWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: 12,
        paddingHorizontal: 14,
        height: 44,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        gap: 8,
        marginHorizontal: 16,
        marginBottom: 8,
    },
    searchInput: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: 14,
        height: '100%',
    },
});

export default PodcastEpisodesScreen;
