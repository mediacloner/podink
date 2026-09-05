import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { showAlert } from '../components/AppAlert';
import EpisodeItem, { formatDuration } from '../components/EpisodeItem';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import Pill from '../components/Pill';
import ShowNotes from '../components/ShowNotes';
import EmptyState from '../components/EmptyState';
import { getEpisodesForCollection, getPodcastByFeedUrl } from '../database/queries';
import { deleteLocalEpisode, reportTranscriptionError, transcribeEpisode } from '../services/episodeService';
import { collectionSize, deleteCollection, pickAudioFiles, pickFolder } from '../services/importService';
import { dequeueTranscription } from '../services/whisperService';
import { useTranscriptionQueue } from '../hooks/useTranscriptionQueue';
import { onLibraryChange } from '../services/libraryEvents';
import { artworkSource } from '../api/userAgent';
import { log } from '../services/logService';
import { showNotesPlainText } from '../services/showNotes';
import { type, useStyles, useTheme } from '../theme';

const formatBytes = (n) => {
    if (!n || n <= 0) return '';
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
};

/**
 * An imported collection (audiobook / local audio files): cover, title,
 * author, description, and every chapter in book order. Chapters open in
 * the Player like any episode; each can be transcribed on demand (a 60-
 * chapter book is not queued wholesale) and swiped away for good. Play /
 * Resume, Add files and Edit sit under the description; Delete collection
 * is the trash in the stack header.
 */
const CollectionScreen = ({ navigation, route }) => {
    const { feedUrl } = route.params;
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const isFocused = useIsFocused();
    const { activeId, queuedIds } = useTranscriptionQueue();
    const [podcast, setPodcast] = useState(null);
    const [episodes, setEpisodes] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [descExpanded, setDescExpanded] = useState(false);
    const [bytes, setBytes] = useState(0);

    const load = useCallback(async () => {
        try {
            const [p, eps] = await Promise.all([getPodcastByFeedUrl(feedUrl), getEpisodesForCollection(feedUrl)]);
            setPodcast(p || null);
            setEpisodes(eps);
            setBytes(collectionSize(feedUrl));
        } catch (e) {
            log('UI', 'Collection load failed', { feedUrl, error: e?.message || String(e) });
        } finally {
            setIsLoading(false);
        }
    }, [feedUrl]);

    useEffect(() => { if (isFocused) load(); }, [isFocused, load]);
    useEffect(() => onLibraryChange((payload) => {
        const t = payload?.type;
        if (t === 'transcript-progress' || t === 'playback-progress') return;
        load();
    }), [load]);


    // ── Header actions ────────────────────────────────────────────────────
    const resumeTarget = useMemo(() => {
        if (!episodes.length) return null;
        const inProgress = episodes
            .filter(e => !e.is_played && e.play_position > 0)
            .sort((a, b) => (b.last_played_at || 0) - (a.last_played_at || 0))[0];
        if (inProgress) return { episode: inProgress, label: 'Resume' };
        const next = episodes.find(e => !e.is_played);
        if (next) return { episode: next, label: next === episodes[0] ? 'Play' : 'Play next' };
        return { episode: episodes[0], label: 'Play again' };
    }, [episodes]);

    const openEpisode = useCallback((episode) => {
        navigation.navigate('Player', { episode });
    }, [navigation]);

    const handleAddFiles = useCallback(() => {
        const go = (entries) => navigation.navigate('CollectionEditor', { mode: 'append', feedUrl, entries });
        showAlert('Add files', null, [
            {
                text: 'Choose files…',
                onPress: async () => {
                    try {
                        const entries = await pickAudioFiles();
                        if (entries) go(entries);
                    } catch (e) { showAlert('Could not open the picker', e?.message || 'Please try again.'); }
                },
            },
            {
                text: 'Choose a folder…',
                onPress: async () => {
                    try {
                        const folder = await pickFolder();
                        if (folder) go(folder.entries);
                    } catch (e) { showAlert('Could not open the picker', e?.message || 'Please try again.'); }
                },
            },
            { text: 'Cancel', style: 'cancel' },
        ]);
    }, [navigation, feedUrl]);

    const handleEdit = useCallback(() => {
        navigation.navigate('CollectionEditor', { mode: 'edit', feedUrl });
    }, [navigation, feedUrl]);

    const handleDeleteCollection = useCallback(() => {
        if (!podcast) return;
        showAlert(
            'Delete collection',
            `Remove "${podcast.title}" with its ${episodes.length} ${episodes.length === 1 ? 'file' : 'files'} from this device? The original files you imported from are not touched.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await deleteCollection(feedUrl);
                            navigation.goBack();
                        } catch (e) {
                            log('UI', 'Collection delete failed', { feedUrl, error: e?.message || String(e) });
                            showAlert('Delete failed', e?.message || 'Please try again.');
                        }
                    },
                },
            ],
        );
    }, [podcast, episodes.length, feedUrl, navigation]);

    // Title and the delete action live in the stack header — the header is
    // where a destructive action for the whole screen is expected, and it
    // keeps the action row below to the things you do *with* the book.
    useEffect(() => {
        navigation.setOptions({
            title: podcast?.title || '',
            headerRight: podcast ? () => (
                <TouchableOpacity
                    onPress={handleDeleteCollection}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    style={styles.headerDelete}
                    accessibilityRole="button"
                    accessibilityLabel="Delete collection"
                >
                    <Icon name="trash-2" size={20} color={colors.danger} />
                </TouchableOpacity>
            ) : undefined,
        });
    }, [navigation, podcast, handleDeleteCollection, colors, styles]);

    // ── Chapter actions ───────────────────────────────────────────────────
    const handleTranscribe = useCallback(async (episode) => {
        try {
            await transcribeEpisode(episode);
        } catch (e) {
            reportTranscriptionError(e, episode);
        }
    }, []);
    const handleCancel = useCallback((episode) => dequeueTranscription(episode.id), []);

    // Chapters still without a transcript and not yet in the queue — what
    // "Transcribe all" would add, in book order.
    const pendingTranscripts = useMemo(
        () => episodes.filter(e => !e.has_transcript && !queuedIds.includes(e.id) && activeId !== e.id),
        [episodes, queuedIds, activeId],
    );
    const queuedHere = useMemo(
        () => episodes.filter(e => queuedIds.includes(e.id) || activeId === e.id).length,
        [episodes, queuedIds, activeId],
    );

    // A whole book is hours of on-device work, so it asks first; the queue
    // then runs chapter by chapter in the background (whisperService FIFO).
    const handleTranscribeAll = useCallback(() => {
        const list = pendingTranscripts;
        if (!list.length) return;
        const secs = list.reduce((s, e) => s + (e.duration || 0), 0);
        const length = secs > 0 ? ` (about ${formatDuration(secs)} of audio)` : '';
        showAlert(
            'Transcribe all',
            `Queue ${list.length} ${list.length === 1 ? 'chapter' : 'chapters'}${length} for on-device transcription? They run one after another in the background; you can cancel from the queue at any time.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Transcribe',
                    onPress: () => {
                        log('UI', 'Transcribe all', { feedUrl, chapters: list.length });
                        for (const ep of list) transcribeEpisode(ep).catch(e => reportTranscriptionError(e, ep));
                    },
                },
            ],
        );
    }, [pendingTranscripts, feedUrl]);

    // Swipe left → Delete, like the Listening and Library rows. The row has
    // already slid out when this runs; returning false springs it back.
    const handleDeleteChapter = useCallback(async (episode) => {
        try {
            await deleteLocalEpisode(episode);
        } catch (e) {
            log('UI', 'Chapter delete failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Delete failed', e?.message || 'Please try again.');
            load();
            return false;
        }
        load();
    }, [load]);

    // ── Render ────────────────────────────────────────────────────────────
    const totalSec = useMemo(() => episodes.reduce((s, e) => s + (e.duration || 0), 0), [episodes]);
    const finished = useMemo(() => episodes.filter(e => e.is_played).length, [episodes]);
    const description = showNotesPlainText(podcast?.description);

    const header = podcast ? (
        <View style={styles.header}>
            <View style={styles.headRow}>
                {podcast.image_url ? (
                    <Image source={artworkSource(podcast.image_url)} style={styles.cover} />
                ) : (
                    <View style={[styles.cover, styles.coverPlaceholder]}>
                        <Icon name="book-open" size={30} color={colors.textFaint} />
                    </View>
                )}
                <View style={styles.headInfo}>
                    <Text style={styles.title} numberOfLines={3}>{podcast.title}</Text>
                    {!!podcast.author && <Text style={styles.author} numberOfLines={2}>{podcast.author}</Text>}
                    <Text style={styles.meta}>
                        {[
                            `${episodes.length} ${episodes.length === 1 ? 'chapter' : 'chapters'}`,
                            totalSec > 0 ? formatDuration(totalSec) : null,
                            finished > 0 ? `${finished} finished` : null,
                            formatBytes(bytes) || null,
                        ].filter(Boolean).join(' · ')}
                    </Text>
                </View>
            </View>

            {!!description && (
                <TouchableOpacity
                    onPress={() => setDescExpanded(v => !v)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={descExpanded ? 'Collapse description' : 'Expand description'}
                >
                    {descExpanded
                        ? <ShowNotes html={podcast.description} collapsible={false} />
                        : <Text style={styles.description} numberOfLines={3}>{description}</Text>}
                </TouchableOpacity>
            )}

            {/* Secondary actions first; the primary Play / Resume sits alone
                on the next line, right-aligned (the user's preferred order). */}
            <View style={styles.actions}>
                <Pill variant="blue" icon="plus" label="Add files" onPress={handleAddFiles} style={styles.actionPill} />
                <Pill variant="blue" icon="edit-2" label="Edit" onPress={handleEdit} style={styles.actionPill} />
                {pendingTranscripts.length > 0 ? (
                    <Pill
                        variant="blue"
                        icon="zap"
                        label={pendingTranscripts.length === episodes.length
                            ? 'Transcribe all'
                            : `Transcribe all · ${pendingTranscripts.length}`}
                        onPress={handleTranscribeAll}
                        style={styles.actionPill}
                        accessibilityLabel={`Transcribe all ${pendingTranscripts.length} remaining chapters`}
                    />
                ) : queuedHere > 0 ? (
                    <Pill
                        variant="orange"
                        icon="clock"
                        label={`Transcribing · ${queuedHere}`}
                        trailingLoading
                        style={styles.actionPill}
                        accessibilityLabel={`${queuedHere} chapters queued for transcription`}
                    />
                ) : null}
            </View>
            {resumeTarget && (
                // Same three-column grid as the row above, so Play / Resume
                // fills the third column and lines up with Transcribe all.
                <View style={styles.actions}>
                    <View style={styles.actionSpacer} />
                    <View style={styles.actionSpacer} />
                    <Pill
                        variant="blue"
                        solid
                        icon="play"
                        label={resumeTarget.label}
                        onPress={() => openEpisode(resumeTarget.episode)}
                        style={styles.actionPill}
                    />
                </View>
            )}
        </View>
    ) : null;

    const renderItem = useCallback(({ item }) => (
        <SwipeableRow
            rightAction={{
                icon: 'trash-2',
                color: colors.danger,
                dismiss: 'slide-out',
                onPress: () => handleDeleteChapter(item),
                accessibilityLabel: `Delete ${item.title}`,
            }}
        >
            <EpisodeItem
                episode={item}
                onPress={openEpisode}
                onTranscribe={handleTranscribe}
                onCancel={handleCancel}
                isTranscribing={activeId === item.id}
                isQueued={queuedIds.includes(item.id) && activeId !== item.id}
                showDownloadedPill={false}
            />
        </SwipeableRow>
    ), [colors, openEpisode, handleTranscribe, handleCancel, handleDeleteChapter, activeId, queuedIds]);

    if (isLoading) {
        return (
            <View style={[styles.container, styles.center]}>
                <ActivityIndicator size="large" color={colors.accent} />
            </View>
        );
    }

    if (!podcast) {
        return (
            <View style={styles.container}>
                <EmptyState icon="book-open" title="Collection not found" subtitle="It may have been deleted." />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <FlatList
                data={episodes}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                ListHeaderComponent={header}
                ListEmptyComponent={
                    <EmptyState icon="music" title="No files" subtitle="Use “Add files” to import audio into this collection" />
                }
                contentContainerStyle={episodes.length === 0 ? { flexGrow: 1 } : { paddingBottom: bottom + 130 }}
                initialNumToRender={12}
                windowSize={7}
                onScrollBeginDrag={closeOpenRow}
            />
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { alignItems: 'center', justifyContent: 'center' },

    header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, gap: 14 },
    headRow: { flexDirection: 'row', gap: 16 },
    cover: { width: 128, height: 128, borderRadius: 16, backgroundColor: colors.surfaceElevated },
    coverPlaceholder: {
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 0.5, borderColor: colors.hairline,
    },
    headInfo: { flex: 1, justifyContent: 'center', gap: 4 },
    title: { ...type.display, color: colors.textPrimary, lineHeight: 26 },
    author: { ...type.bodyStrong, color: colors.textSecondary },
    meta: { ...type.label, fontWeight: '400', color: colors.textMuted, marginTop: 4 },
    description: { ...type.body, color: colors.textSecondary, lineHeight: 20 },

    // Three equal columns; both action rows use it so their edges align.
    actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    actionPill: { flex: 1, minWidth: 0 },
    // Yoga hands a flex: 1 item its padding on top of the shared space, so an
    // empty spacer must carry a Pill's horizontal padding (10) to end up the
    // same width as the pill next to it.
    actionSpacer: { flex: 1, minWidth: 0, paddingHorizontal: 10 },
    headerDelete: { marginRight: 16, marginTop: 3 },
});

export default CollectionScreen;
