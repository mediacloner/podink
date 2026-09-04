import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator, Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput,
    TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';
import { showAlert } from '../components/AppAlert';
import { formatDuration } from '../components/EpisodeItem';
import { getEpisodesForCollection, getPodcastByFeedUrl } from '../database/queries';
import {
    analyzeSelection, appendToCollection, importCollection, pickImage, prepareCover, saveCollectionEdits,
} from '../services/importService';
import { stemsFromLocalPaths, totalDuration } from '../services/importMeta';
import { artworkSource } from '../api/userAgent';
import { log } from '../services/logService';
import { type, useStyles, useTheme, withAlpha } from '../theme';

/**
 * One form for three jobs, chosen by route.params.mode:
 *   'import' { entries, folderName }  — files just picked: read their tags,
 *                                       propose title / author / cover /
 *                                       chapter names, then copy them in
 *   'append' { feedUrl, entries }     — more files for an existing collection
 *   'edit'   { feedUrl }              — rename the collection, its chapters,
 *                                       swap or remove the cover
 * The metadata the files carry (tags, an .nfo, a cover.jpg or embedded art)
 * is only the starting point; every field is editable before anything is
 * written.
 */
const CollectionEditorScreen = ({ navigation, route }) => {
    const { mode = 'import', entries = [], folderName = '', feedUrl = null } = route.params || {};
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();

    const [phase, setPhase] = useState('loading'); // loading | ready | working
    const [loadNote, setLoadNote] = useState('Reading files…');
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [description, setDescription] = useState('');
    const [cover, setCover] = useState(null);           // file:// URI shown (cache or the stored cover)
    const [chapters, setChapters] = useState([]);       // import/append: {uri,name,title,durationSec,hasCover}; edit: {id,title,originalTitle,duration}
    const [progress, setProgress] = useState(null);     // { overall, index, total, title }
    const storedCoverRef = useRef('');                  // edit mode: the collection's current cover
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        navigation.setOptions({
            title: mode === 'edit' ? 'Edit collection' : mode === 'append' ? 'Add files' : 'Import audio',
        });
    }, [navigation, mode]);

    // ── Load: tags for picked files, or the stored collection ──────────────
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                if (mode === 'edit') {
                    const [podcast, eps] = await Promise.all([getPodcastByFeedUrl(feedUrl), getEpisodesForCollection(feedUrl)]);
                    if (cancelled) return;
                    if (!podcast) throw new Error('Collection not found');
                    setTitle(podcast.title || '');
                    setAuthor(podcast.author || '');
                    setDescription(podcast.description || '');
                    storedCoverRef.current = podcast.image_url || '';
                    setCover(podcast.image_url || null);
                    setChapters(eps.map(e => ({
                        id: e.id, title: e.title || '', originalTitle: e.title || '', durationSec: e.duration || 0,
                        localPath: e.local_audio_path,
                    })));
                } else {
                    // Appending: name new chapters the way the existing ones
                    // were named (shared file-name prefix, book title).
                    let context = null;
                    if (mode === 'append' && feedUrl) {
                        const [podcast, eps] = await Promise.all([getPodcastByFeedUrl(feedUrl), getEpisodesForCollection(feedUrl)]);
                        if (cancelled) return;
                        context = {
                            title: podcast?.title || '',
                            stems: stemsFromLocalPaths(eps.map(e => e.local_audio_path)),
                        };
                    }
                    const draft = await analyzeSelection(entries, {
                        folderName,
                        context,
                        onProgress: ({ done, total }) => {
                            if (!cancelled) setLoadNote(`Reading tags ${Math.min(done + 1, total)} of ${total}…`);
                        },
                    });
                    if (cancelled) return;
                    setTitle(draft.title);
                    setAuthor(draft.author);
                    setDescription(draft.description);
                    setChapters(draft.chapters);
                    if (draft.cover) {
                        try {
                            const uri = await prepareCover(draft.cover);
                            if (!cancelled) setCover(uri);
                        } catch (e) {
                            log('UI', 'Import: cover not prepared', { error: e?.message || String(e) });
                        }
                    }
                }
                if (!cancelled) setPhase('ready');
            } catch (e) {
                if (cancelled) return;
                log('UI', 'Collection editor load failed', { mode, error: e?.message || String(e) });
                showAlert(
                    e?.code === 'NO_AUDIO' ? 'No audio files' : 'Could not read the files',
                    e?.code === 'NO_AUDIO'
                        ? 'Nothing in that selection is an audio file.'
                        : (e?.message || 'Please try again.'),
                    [{ text: 'OK', onPress: () => navigation.goBack() }],
                );
            }
        })();
        return () => { cancelled = true; };
    // Route params are fixed for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Cover ─────────────────────────────────────────────────────────────
    const embeddedSource = useMemo(() => {
        if (mode === 'edit') return null;
        const ch = chapters.find(c => c.hasCover);
        return ch ? { type: 'embedded', uri: ch.uri } : null;
    }, [chapters, mode]);

    const applyCoverSource = useCallback(async (source) => {
        try {
            const uri = await prepareCover(source);
            if (!alive.current) return;
            if (!uri) {
                showAlert('No picture', 'That file has no picture that can be used as a cover.');
                return;
            }
            setCover(uri);
        } catch (e) {
            log('UI', 'Cover change failed', { error: e?.message || String(e) });
            showAlert('Could not use that image', e?.message || 'Please try another file.');
        }
    }, []);

    const handleCoverPress = useCallback(() => {
        const buttons = [
            {
                text: 'Choose an image…',
                onPress: async () => {
                    try {
                        const picked = await pickImage();
                        if (picked?.uri) await applyCoverSource({ type: 'image', uri: picked.uri });
                    } catch (e) {
                        showAlert('Could not open the picker', e?.message || 'Please try again.');
                    }
                },
            },
        ];
        if (embeddedSource) {
            buttons.push({ text: 'Use the picture in the audio', onPress: () => applyCoverSource(embeddedSource) });
        }
        if (cover) buttons.push({ text: 'Remove cover', style: 'destructive', onPress: () => setCover(null) });
        buttons.push({ text: 'Cancel', style: 'cancel' });
        showAlert('Cover', null, buttons);
    }, [applyCoverSource, cover, embeddedSource]);

    // ── Chapters ──────────────────────────────────────────────────────────
    const setChapterTitle = useCallback((index, text) => {
        setChapters(prev => prev.map((c, i) => (i === index ? { ...c, title: text } : c)));
    }, []);
    const removeChapter = useCallback((index) => {
        setChapters(prev => prev.filter((_, i) => i !== index));
    }, []);

    // ── Submit ────────────────────────────────────────────────────────────
    const canSubmit = phase === 'ready' && chapters.length > 0 && (mode === 'append' || title.trim().length > 0);

    const handleSubmit = useCallback(async () => {
        if (!canSubmit) return;
        setPhase('working');
        setProgress(mode === 'edit' ? null : { overall: 0, index: 0, total: chapters.length, title: chapters[0]?.title });
        const onProgress = (p) => { if (alive.current) setProgress(p); };
        try {
            if (mode === 'edit') {
                await saveCollectionEdits(feedUrl, { title, author, description, coverUri: cover, chapters });
                navigation.goBack();
                return;
            }
            const draft = { title, author, description, coverUri: cover, chapters };
            if (mode === 'append') {
                await appendToCollection(feedUrl, draft, { onProgress });
                navigation.goBack();
                return;
            }
            const newFeedUrl = await importCollection(draft, { onProgress });
            navigation.replace('Collection', { feedUrl: newFeedUrl });
        } catch (e) {
            log('UI', 'Collection save failed', { mode, error: e?.message || String(e) });
            if (!alive.current) return;
            setPhase('ready');
            setProgress(null);
            showAlert(
                mode === 'edit' ? 'Could not save' : 'Import failed',
                mode === 'edit'
                    ? (e?.message || 'Please try again.')
                    : `${e?.message || 'A file could not be copied.'}\n\nChapters copied so far are kept — you can delete the collection from My Podcasts.`,
            );
        }
    }, [canSubmit, mode, chapters, title, author, description, cover, feedUrl, navigation]);

    const submitLabel = mode === 'edit' ? 'Save'
        : mode === 'append' ? `Add ${chapters.length} ${chapters.length === 1 ? 'file' : 'files'}`
        : `Import ${chapters.length} ${chapters.length === 1 ? 'file' : 'files'}`;
    const total = totalDuration(chapters);

    if (phase === 'loading') {
        return (
            <View style={[styles.container, styles.center]}>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.loadNote}>{mode === 'edit' ? 'Loading…' : loadNote}</Text>
            </View>
        );
    }

    const editing = phase === 'ready';
    return (
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView
                contentContainerStyle={{ paddingBottom: bottom + 110 }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                {mode !== 'append' && (
                    <View style={styles.headBlock}>
                        <TouchableOpacity
                            onPress={handleCoverPress}
                            disabled={!editing}
                            activeOpacity={0.8}
                            accessibilityRole="button"
                            accessibilityLabel={cover ? 'Change cover' : 'Add a cover'}
                        >
                            {cover ? (
                                <Image source={artworkSource(cover)} style={styles.cover} />
                            ) : (
                                <View style={[styles.cover, styles.coverPlaceholder]}>
                                    <Icon name="image" size={26} color={colors.textFaint} />
                                    <Text style={styles.coverHint}>Add cover</Text>
                                </View>
                            )}
                            <View style={styles.coverBadge}>
                                <Icon name="edit-2" size={12} color={colors.onAccent} />
                            </View>
                        </TouchableOpacity>

                        <View style={styles.fields}>
                            <Text style={styles.fieldLabel}>TITLE</Text>
                            <TextInput
                                style={styles.input}
                                value={title}
                                onChangeText={setTitle}
                                placeholder="Book or collection title"
                                placeholderTextColor={colors.textFaint}
                                editable={editing}
                                returnKeyType="next"
                            />
                            <Text style={styles.fieldLabel}>AUTHOR</Text>
                            <TextInput
                                style={styles.input}
                                value={author}
                                onChangeText={setAuthor}
                                placeholder="Author or artist"
                                placeholderTextColor={colors.textFaint}
                                editable={editing}
                                returnKeyType="next"
                            />
                        </View>
                    </View>
                )}

                {mode !== 'append' && (
                    <View style={styles.section}>
                        <Text style={styles.fieldLabel}>DESCRIPTION</Text>
                        <TextInput
                            style={[styles.input, styles.multiline]}
                            value={description}
                            onChangeText={setDescription}
                            placeholder="Optional"
                            placeholderTextColor={colors.textFaint}
                            editable={editing}
                            multiline
                            textAlignVertical="top"
                        />
                    </View>
                )}

                <View style={styles.section}>
                    <View style={styles.chaptersHead}>
                        <Text style={styles.fieldLabel}>
                            {`CHAPTERS · ${chapters.length}${total > 0 ? ` · ${formatDuration(total)}` : ''}`}
                        </Text>
                        {mode !== 'edit' && (
                            <Text style={styles.chaptersHint}>Names come from the files' tags; tap to change.</Text>
                        )}
                    </View>
                    <View style={styles.card}>
                        {chapters.map((ch, i) => (
                            <View key={ch.id || ch.uri || i} style={[styles.chapterRow, i > 0 && styles.rowBorder]}>
                                <Text style={styles.chapterNo}>{i + 1}</Text>
                                <TextInput
                                    style={styles.chapterInput}
                                    value={ch.title}
                                    onChangeText={(t) => setChapterTitle(i, t)}
                                    placeholder={`Chapter ${i + 1}`}
                                    placeholderTextColor={colors.textFaint}
                                    editable={editing}
                                />
                                {ch.durationSec > 0 && (
                                    <Text style={styles.chapterMeta}>{formatDuration(ch.durationSec)}</Text>
                                )}
                                {mode !== 'edit' && (
                                    <TouchableOpacity
                                        onPress={() => removeChapter(i)}
                                        disabled={!editing}
                                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Leave out ${ch.title || `chapter ${i + 1}`}`}
                                    >
                                        <Icon name="x" size={16} color={colors.textFaint} />
                                    </TouchableOpacity>
                                )}
                            </View>
                        ))}
                        {chapters.length === 0 && (
                            <Text style={styles.emptyChapters}>No files left to import.</Text>
                        )}
                    </View>
                </View>
            </ScrollView>

            <View style={[styles.footer, { paddingBottom: bottom + 14 }]}>
                {progress && phase === 'working' ? (
                    <View style={styles.progressWrap}>
                        <Text style={styles.progressText} numberOfLines={1}>
                            {`Copying ${Math.min(progress.index + 1, progress.total)} of ${progress.total}${progress.title ? ` · ${progress.title}` : ''}`}
                        </Text>
                        <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${Math.max(1, Math.round((progress.overall || 0) * 100))}%` }]} />
                        </View>
                    </View>
                ) : (
                    <TouchableOpacity
                        style={[styles.submit, !canSubmit && styles.submitDisabled]}
                        onPress={handleSubmit}
                        disabled={!canSubmit || phase === 'working'}
                        accessibilityRole="button"
                        accessibilityLabel={submitLabel}
                    >
                        {phase === 'working'
                            ? <ActivityIndicator size="small" color={colors.onAccent} />
                            : <Text style={styles.submitText}>{submitLabel}</Text>}
                    </TouchableOpacity>
                )}
            </View>
        </KeyboardAvoidingView>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { alignItems: 'center', justifyContent: 'center', gap: 14 },
    loadNote: { ...type.body, color: colors.textMuted },

    headBlock: { flexDirection: 'row', gap: 16, paddingHorizontal: 16, paddingTop: 16 },
    cover: { width: 118, height: 118, borderRadius: 14, backgroundColor: colors.surfaceElevated },
    coverPlaceholder: {
        alignItems: 'center', justifyContent: 'center', gap: 6,
        borderWidth: 0.5, borderColor: colors.hairline,
    },
    coverHint: { ...type.label, color: colors.textMuted },
    coverBadge: {
        position: 'absolute', right: -6, bottom: -6,
        width: 26, height: 26, borderRadius: 13,
        backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: colors.bg,
    },
    fields: { flex: 1, gap: 6 },
    fieldLabel: { ...type.caption, fontWeight: '700', color: colors.textMuted, marginTop: 4 },
    input: {
        height: 42,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: colors.surfaceElevated,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        color: colors.textPrimary,
        fontSize: 14,
    },
    multiline: { height: undefined, minHeight: 96, paddingVertical: 10, lineHeight: 20 },

    section: { paddingHorizontal: 16, paddingTop: 14, gap: 6 },
    chaptersHead: { gap: 2 },
    chaptersHint: { ...type.label, fontWeight: '400', color: colors.textFaint },
    card: {
        backgroundColor: colors.surface,
        borderRadius: 14,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        overflow: 'hidden',
    },
    chapterRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
    rowBorder: { borderTopWidth: 0.5, borderTopColor: colors.hairlineFaint },
    chapterNo: { ...type.label, color: colors.textFaint, width: 24, textAlign: 'right' },
    chapterInput: { flex: 1, color: colors.textPrimary, fontSize: 14, paddingVertical: 8 },
    chapterMeta: { ...type.label, fontWeight: '400', color: colors.textMuted },
    emptyChapters: { ...type.body, color: colors.textMuted, padding: 16, textAlign: 'center' },

    footer: {
        position: 'absolute', left: 0, right: 0, bottom: 0,
        paddingHorizontal: 16, paddingTop: 12,
        backgroundColor: colors.bg,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairlineStrong,
    },
    submit: {
        height: 48, borderRadius: 12, backgroundColor: colors.accent,
        alignItems: 'center', justifyContent: 'center',
    },
    submitDisabled: { opacity: 0.45 },
    submitText: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },
    progressWrap: { gap: 8, paddingVertical: 4 },
    progressText: { ...type.label, color: colors.textSecondary },
    progressTrack: { height: 6, borderRadius: 3, backgroundColor: withAlpha(colors.accent, 0.18), overflow: 'hidden' },
    progressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.accent },
});

export default CollectionEditorScreen;
