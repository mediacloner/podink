import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator, FlatList, KeyboardAvoidingView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { Feather as Icon } from '@expo/vector-icons';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import EmptyState from '../components/EmptyState';
import { showAlert } from '../components/AppAlert';
import {
    buildNotebookExport, formatNotebookTime, getNotebookEntries, groupNotebookByEpisode,
    removeNotebookEntry, updateNotebookNote,
} from '../services/notebookService';
import { shareText } from '../components/transcript/share';
import { getEpisodeById } from '../database/queries';
import { radii, withAlpha, type, useTheme, useStyles } from '../theme';

// A note edited here is written this long after the last keystroke (and on
// blur, on leaving the screen) — the same rhythm as the sentence card.
const NOTE_SAVE_DELAY_MS = 500;

// The Notebook (4.5.0): every sentence kept from a transcript, filed under
// its episode in the order it was said, each with the listener's note. Tap a
// sentence to write or change its note and to replay it; swipe left to
// remove it; search covers sentences, notes and titles; the header's share
// glyph hands the whole notebook (or the search's matches) to another app.

const EpisodeHeader = ({ group }) => {
    const styles = useStyles(makeStyles);
    const n = group.entries.length;
    return (
        <View style={styles.episodeHead}>
            {!!group.podcast_title && (
                <Text style={styles.podcastTitle} numberOfLines={1}>{group.podcast_title.toUpperCase()}</Text>
            )}
            <View style={styles.episodeTitleRow}>
                <Text style={styles.episodeTitle} numberOfLines={2}>{group.episode_title}</Text>
                <Text style={styles.episodeCount}>{n === 1 ? '1 note' : `${n} notes`}</Text>
            </View>
        </View>
    );
};

const EntryRow = React.memo(({ item, expanded, onToggle, onChangeNote, onBlurNote, onPlay, onDelete }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const hasNote = !!(item.note || '').trim();
    return (
        <SwipeableRow
            rightAction={{
                icon: 'trash-2',
                color: colors.danger,
                // A written note gets a confirmation; a bare sentence just goes.
                dismiss: hasNote ? 'close' : 'slide-out',
                onPress: () => onDelete(item),
                accessibilityLabel: 'Remove this sentence from the notebook',
            }}
        >
            <TouchableOpacity
                style={styles.row}
                onPress={() => onToggle(item.id)}
                activeOpacity={0.7}
                accessibilityRole='button'
                accessibilityLabel={`${item.sentence}. ${expanded ? 'Collapse' : 'Open the note'}`}
            >
                <View style={styles.quoteRow}>
                    <View style={styles.quoteRule} />
                    <View style={styles.quoteBody}>
                        <Text style={styles.sentence}>{item.sentence}</Text>
                        {!!item.translation && expanded && (
                            <Text style={styles.translation}>{item.translation}</Text>
                        )}
                    </View>
                </View>

                {expanded ? (
                    <View style={styles.noteBox}>
                        <View style={styles.noteHead}>
                            <Icon name='edit-3' size={12} color={colors.accent} />
                            <Text style={styles.noteLabel}>YOUR NOTE</Text>
                        </View>
                        <TextInput
                            style={styles.noteInput}
                            value={item.note || ''}
                            onChangeText={(t) => onChangeNote(item.id, t)}
                            onBlur={() => onBlurNote(item.id)}
                            placeholder='The idea, why it matters, how you would put it…'
                            placeholderTextColor={colors.textMuted}
                            multiline
                            autoFocus={!hasNote}
                            textAlignVertical='top'
                            scrollEnabled={false}
                            accessibilityLabel='Note for this sentence'
                        />
                    </View>
                ) : hasNote ? (
                    <View style={styles.notePreviewRow}>
                        <Icon name='edit-3' size={12} color={colors.accent} style={{ marginTop: 3 }} />
                        <Text style={styles.notePreview} numberOfLines={3}>{item.note.trim()}</Text>
                    </View>
                ) : (
                    <Text style={styles.noNote}>No note yet — tap to write one</Text>
                )}

                <View style={styles.rowMeta}>
                    <TouchableOpacity
                        style={styles.playBtn}
                        onPress={() => onPlay(item.episode_id, item.start_ms)}
                        activeOpacity={0.7}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole='button'
                        accessibilityLabel={`Play the episode at ${formatNotebookTime(item.start_ms)}`}
                    >
                        <Icon name='play' size={11} color={colors.accent} />
                        <Text style={styles.playBtnText}>{formatNotebookTime(item.start_ms)}</Text>
                    </TouchableOpacity>
                </View>
            </TouchableOpacity>
        </SwipeableRow>
    );
});

const NotebookScreen = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isFocused = useIsFocused();
    const [entries, setEntries] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [expandedId, setExpandedId] = useState(null);

    // Notes being edited: id → text not yet written, with one timer each.
    const pendingRef = useRef(new Map());
    const timersRef = useRef(new Map());
    const flushNote = useCallback((id) => {
        const timer = timersRef.current.get(id);
        if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
        if (!pendingRef.current.has(id)) return;
        const text = pendingRef.current.get(id);
        pendingRef.current.delete(id);
        updateNotebookNote(id, text).catch(() => {});
    }, []);
    const flushAll = useCallback(() => {
        for (const id of [...pendingRef.current.keys()]) flushNote(id);
    }, [flushNote]);
    useEffect(() => () => flushAll(), [flushAll]);
    useEffect(() => { if (!isFocused) flushAll(); }, [isFocused, flushAll]);

    const loadEntries = useCallback(async () => {
        try {
            const rows = await getNotebookEntries();
            setEntries(rows || []);
        } catch (_) {
            setEntries([]);
        } finally {
            setIsLoading(false);
        }
    }, []);
    useEffect(() => { if (isFocused) loadEntries(); }, [isFocused, loadEntries]);

    const trimmedQuery = query.trim().toLowerCase();
    const filtered = useMemo(() => {
        if (!trimmedQuery) return entries;
        return entries.filter(e =>
            (e.sentence || '').toLowerCase().includes(trimmedQuery)
            || (e.note || '').toLowerCase().includes(trimmedQuery)
            || (e.translation || '').toLowerCase().includes(trimmedQuery)
            || (e.episode_title || '').toLowerCase().includes(trimmedQuery)
            || (e.podcast_title || '').toLowerCase().includes(trimmedQuery));
    }, [entries, trimmedQuery]);

    const onShareAll = useCallback(() => {
        if (!filtered.length) return;
        shareText(buildNotebookExport(filtered), 'Share notebook');
    }, [filtered]);

    useEffect(() => {
        navigation.setOptions({
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.textPrimary,
            headerTitleStyle: { fontWeight: '700', fontSize: 17, letterSpacing: -0.3 },
            headerShadowVisible: false,
            title: 'Notebook',
            headerRight: () => (
                <TouchableOpacity
                    onPress={onShareAll}
                    disabled={!filtered.length}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={{ marginRight: 16, opacity: filtered.length ? 1 : 0.35 }}
                    accessibilityRole='button'
                    accessibilityLabel='Share the notebook as text'
                >
                    <Icon name='share-2' size={19} color={colors.textPrimary} />
                </TouchableOpacity>
            ),
        });
    }, [navigation, colors, onShareAll, filtered.length]);

    const listData = useMemo(() => {
        const data = [];
        for (const g of groupNotebookByEpisode(filtered)) {
            data.push({ type: 'episode', key: `e-${g.key}`, group: g });
            for (const e of g.entries) data.push({ type: 'entry', key: `n-${e.id}`, item: e });
        }
        return data;
    }, [filtered]);

    const handleToggle = useCallback((id) => {
        setExpandedId(prev => {
            if (prev != null && prev !== id) flushNote(prev);
            return prev === id ? null : id;
        });
    }, [flushNote]);

    const handleChangeNote = useCallback((id, text) => {
        setEntries(prev => prev.map(e => (e.id === id ? { ...e, note: text } : e)));
        pendingRef.current.set(id, text);
        const old = timersRef.current.get(id);
        if (old) clearTimeout(old);
        timersRef.current.set(id, setTimeout(() => flushNote(id), NOTE_SAVE_DELAY_MS));
    }, [flushNote]);

    const handleDelete = useCallback((item) => {
        const remove = async () => {
            pendingRef.current.delete(item.id);
            const timer = timersRef.current.get(item.id);
            if (timer) { clearTimeout(timer); timersRef.current.delete(item.id); }
            setEntries(prev => prev.filter(e => e.id !== item.id));
            if (expandedId === item.id) setExpandedId(null);
            try {
                await removeNotebookEntry(item.id);
            } catch (_) {
                loadEntries();
            }
        };
        if ((item.note || '').trim()) {
            showAlert('Remove from notebook?', 'The sentence and the note you wrote will be deleted.', [
                { text: 'Keep', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => { remove(); } },
            ]);
        } else {
            remove();
        }
    }, [expandedId, loadEntries]);

    const handlePlay = useCallback(async (episodeId, startMs) => {
        flushAll();
        try {
            const episode = episodeId != null ? await getEpisodeById(episodeId) : null;
            if (!episode) {
                showAlert('Episode unavailable', 'This episode is no longer in your library. The sentence and your note stay here.');
                return;
            }
            // A second back before the sentence, so its first word is heard whole.
            navigation.navigate('Player', { episode, seekToMs: Math.max(0, (startMs || 0) - 1000) });
        } catch (_) {
            showAlert('Episode unavailable', 'This episode is no longer in your library. The sentence and your note stay here.');
        }
    }, [navigation, flushAll]);

    const renderItem = useCallback(({ item }) => {
        if (item.type === 'episode') return <EpisodeHeader group={item.group} />;
        return (
            <EntryRow
                item={item.item}
                expanded={expandedId === item.item.id}
                onToggle={handleToggle}
                onChangeNote={handleChangeNote}
                onBlurNote={flushNote}
                onPlay={handlePlay}
                onDelete={handleDelete}
            />
        );
    }, [expandedId, handleToggle, handleChangeNote, flushNote, handlePlay, handleDelete]);

    if (isLoading) {
        return (
            <View style={[styles.container, styles.loadingWrap]}>
                <ActivityIndicator size='large' color={colors.accent} />
            </View>
        );
    }

    return (
        <KeyboardAvoidingView style={styles.container} behavior='padding' keyboardVerticalOffset={headerHeight}>
            <View style={styles.searchWrap}>
                <Icon name='search' size={14} color={colors.textMuted} />
                <TextInput
                    style={styles.searchInput}
                    placeholder='Search sentences and notes…'
                    placeholderTextColor={colors.textMuted}
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize='none'
                    autoCorrect={false}
                    accessibilityLabel='Search the notebook'
                />
                {query.length > 0 && (
                    <TouchableOpacity
                        onPress={() => setQuery('')}
                        hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                        accessibilityRole='button'
                        accessibilityLabel='Clear search'
                    >
                        <Icon name='x' size={14} color={colors.textMuted} />
                    </TouchableOpacity>
                )}
            </View>

            <FlatList
                data={listData}
                keyExtractor={item => item.key}
                renderItem={renderItem}
                extraData={expandedId}
                contentContainerStyle={listData.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 40 }}
                initialNumToRender={12}
                windowSize={7}
                onScrollBeginDrag={closeOpenRow}
                keyboardShouldPersistTaps='handled'
                keyboardDismissMode='on-drag'
                ListEmptyComponent={
                    trimmedQuery ? (
                        <EmptyState
                            icon='search'
                            title='No matches'
                            subtitle='Nothing in your sentences or notes matches this search'
                        />
                    ) : (
                        <EmptyState
                            icon='edit-3'
                            title='Your notebook is empty'
                            subtitle='Slide a sentence to the right in a transcript and tap the pencil to keep it here with your own notes'
                        />
                    )
                }
            />
        </KeyboardAvoidingView>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    loadingWrap: { alignItems: 'center', justifyContent: 'center' },

    searchWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        paddingHorizontal: 14,
        height: 44,
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 4,
    },
    searchInput: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: 14,
        height: '100%',
    },

    // Episode heading: the show in small caps over the episode's title.
    episodeHead: {
        paddingHorizontal: 20,
        paddingTop: 22,
        paddingBottom: 8,
        gap: 3,
    },
    podcastTitle: { ...type.caption, color: colors.textMuted, letterSpacing: 0.7 },
    episodeTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
    episodeTitle: { ...type.title, fontSize: 16, color: colors.textPrimary, flex: 1 },
    episodeCount: { ...type.label, color: colors.textMuted },

    row: {
        paddingHorizontal: 20,
        paddingVertical: 14,
        gap: 10,
        backgroundColor: colors.bg,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairlineFaint,
    },
    quoteRow: { flexDirection: 'row', gap: 12 },
    quoteRule: { width: 2, borderRadius: 1, backgroundColor: withAlpha(colors.accent, 0.5) },
    quoteBody: { flex: 1, gap: 6 },
    sentence: { fontSize: 15.5, lineHeight: 23, color: colors.textPrimary },
    translation: { fontSize: 14, lineHeight: 21, color: colors.textSecondary, fontStyle: 'italic' },

    notePreviewRow: { flexDirection: 'row', gap: 8, paddingLeft: 14 },
    notePreview: { flex: 1, fontSize: 14, lineHeight: 21, color: colors.textSecondary },
    noNote: { fontSize: 12.5, color: colors.textMuted, paddingLeft: 14, fontStyle: 'italic' },

    noteBox: {
        marginLeft: 14,
        padding: 12,
        paddingTop: 10,
        borderRadius: radii.s,
        backgroundColor: withAlpha(colors.accent, 0.07),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.3),
        gap: 6,
    },
    noteHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    noteLabel: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },
    noteInput: {
        color: colors.textPrimary,
        fontSize: 15,
        lineHeight: 22,
        minHeight: 66,
        padding: 0,
        paddingTop: 0,
    },

    rowMeta: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14 },
    playBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: radii.pill,
        backgroundColor: withAlpha(colors.accent, 0.10),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.25),
    },
    playBtnText: { ...type.label, color: colors.accent, fontVariant: ['tabular-nums'] },
});

export default NotebookScreen;
