import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Switch, Text,
    TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';
import { showAlert } from '../components/AppAlert';
import { formatDuration } from '../components/EpisodeItem';
import { getEpisodesForCollection, getPodcastByFeedUrl } from '../database/queries';
import {
    analyzeSelection, appendToCollection, importCollection, mapChaptersToBook, pickBook, pickImage, prepareCover,
    saveCollectionEdits, stageBookFile,
} from '../services/importService';
import { stemsFromLocalPaths, totalDuration } from '../services/importMeta';
import { loadBook, parseRange } from '../services/bookService';
import { describeRange, paceIfImpossible, rangesAfterEdit, sectionLabel, wordCountInRange } from '../services/bookMap';
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
 *
 * 4.8.0 — the book: an EPUB picked with the files (or attached here) shows
 * as a card, and under each chapter's name a line says which part of the
 * book it reads ("Text: Chapter 3"); a tap opens the list of sections to
 * change it, or to give the chapter no text. A single file with chapter
 * markers inside lists those chapters instead of the file, with a switch
 * to keep the file whole.
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
    const [chapters, setChapters] = useState([]);       // import/append: {uri,name,title,durationSec,hasCover,clip?}; edit: {id,title,originalTitle,durationSec,…}
    const [progress, setProgress] = useState(null);     // { overall, index, total, title, phase }
    // The book (bookService.prepareBook shape), where its staged file sits
    // (null when it is the collection's own), its file name, and one range
    // (bookMap) or null per chapter.
    const [book, setBook] = useState(null);
    const [bookUri, setBookUri] = useState(null);
    const [bookName, setBookName] = useState('');
    const [bookRanges, setBookRanges] = useState(null);
    const [attaching, setAttaching] = useState(false);
    const [picker, setPicker] = useState(null);         // { index } — the section list for one chapter
    // A file with chapter markers: both readings of the selection.
    const [wholeChapters, setWholeChapters] = useState(null);
    const [splitChapters, setSplitChapters] = useState(null);
    const [splitOn, setSplitOn] = useState(true);
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
                    const [podcast, eps, stored] = await Promise.all([
                        getPodcastByFeedUrl(feedUrl), getEpisodesForCollection(feedUrl), loadBook(feedUrl),
                    ]);
                    if (cancelled) return;
                    if (!podcast) throw new Error('Collection not found');
                    setTitle(podcast.title || '');
                    setAuthor(podcast.author || '');
                    setDescription(podcast.description || '');
                    storedCoverRef.current = podcast.image_url || '';
                    setCover(podcast.image_url || null);
                    setChapters(eps.map(e => ({
                        id: e.id, title: e.title || '', originalTitle: e.title || '', durationSec: e.duration || 0,
                        localPath: e.local_audio_path, transcriptSource: e.transcript_source || null,
                        originalRange: e.book_range || null,
                    })));
                    if (stored) {
                        setBook(stored);
                        setBookName(podcast.book_path ? 'book.epub' : '');
                        setBookRanges(eps.map(e => parseRange(e.book_range)));
                    }
                } else {
                    // Appending: name new chapters the way the existing ones
                    // were named (shared file-name prefix, book title).
                    let context = null;
                    let stored = null;
                    if (mode === 'append' && feedUrl) {
                        const [podcast, eps, existingBook] = await Promise.all([
                            getPodcastByFeedUrl(feedUrl), getEpisodesForCollection(feedUrl), loadBook(feedUrl),
                        ]);
                        if (cancelled) return;
                        context = {
                            title: podcast?.title || '',
                            stems: stemsFromLocalPaths(eps.map(e => e.local_audio_path)),
                        };
                        stored = existingBook;
                    }
                    const draft = await analyzeSelection(entries, {
                        folderName,
                        context,
                        onProgress: ({ done, total, note }) => {
                            if (!cancelled) setLoadNote(note || `Reading tags ${Math.min(done + 1, total)} of ${total}…`);
                        },
                    });
                    if (cancelled) return;
                    setTitle(draft.title);
                    setAuthor(draft.author);
                    setDescription(draft.description);
                    setChapters(draft.chapters);
                    if (draft.hasEmbedded) {
                        setWholeChapters(draft.wholeChapters);
                        setSplitChapters(draft.splitChapters);
                        setSplitOn(true);
                    }
                    if (draft.book) {
                        setBook(draft.book);
                        setBookUri(draft.bookUri);
                        setBookName(draft.bookName || '');
                        setBookRanges(draft.bookRanges);
                    } else if (stored) {
                        // New files for a collection that has its book: the
                        // parts are chosen by hand (the rest is already taken).
                        setBook(stored);
                        setBookName('book.epub');
                        setBookRanges(draft.chapters.map(() => null));
                    }
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

    // ── Book ──────────────────────────────────────────────────────────────
    const handleAttachBook = useCallback(async () => {
        try {
            const picked = await pickBook();
            if (!picked) return;
            if (!/\.epub$/i.test(picked.name || '')) {
                showAlert('Not an EPUB', 'Choose the book as an .epub file.');
                return;
            }
            setAttaching(true);
            const staged = await stageBookFile(picked);
            if (!alive.current) return;
            setBook(staged.book);
            setBookUri(staged.uri);
            setBookName(staged.name || 'book.epub');
            setBookRanges(mapChaptersToBook(chapters, staged.book));
        } catch (e) {
            log('UI', 'Book not attached', { error: e?.message || String(e) });
            if (alive.current) showAlert('Could not read the book', e?.message || 'Please try another file.');
        } finally {
            if (alive.current) setAttaching(false);
        }
    }, [chapters]);

    // Only a book staged in this form can be dropped; the collection's own
    // stays (its chapters' text is theirs until each is set to "No text").
    const handleRemoveBook = useCallback(() => {
        setBook(null);
        setBookUri(null);
        setBookName('');
        setBookRanges(null);
    }, []);

    const openPicker = useCallback((index) => setPicker({ index }), []);
    const choosePart = useCallback((startSection) => {
        if (!picker) return;
        setBookRanges(prev => rangesAfterEdit(prev || chapters.map(() => null), picker.index, startSection));
        setPicker(null);
    }, [picker, chapters]);

    // ── Chapters ──────────────────────────────────────────────────────────
    const setChapterTitle = useCallback((index, text) => {
        setChapters(prev => prev.map((c, i) => (i === index ? { ...c, title: text } : c)));
    }, []);
    const removeChapter = useCallback((index) => {
        setChapters(prev => prev.filter((_, i) => i !== index));
        setBookRanges(prev => (prev ? prev.filter((_, i) => i !== index) : prev));
    }, []);
    const toggleSplit = useCallback((on) => {
        const next = on ? splitChapters : wholeChapters;
        if (!next) return;
        setSplitOn(on);
        setChapters(next);
        setBookRanges(book ? mapChaptersToBook(next, book) : null);
    }, [splitChapters, wholeChapters, book]);

    // ── Submit ────────────────────────────────────────────────────────────
    const canSubmit = phase === 'ready' && !attaching && chapters.length > 0 && (mode === 'append' || title.trim().length > 0);

    const handleSubmit = useCallback(async () => {
        if (!canSubmit) return;
        setPhase('working');
        setProgress({ overall: 0, index: 0, total: chapters.length, title: chapters[0]?.title, phase: mode === 'edit' ? 'save' : 'copy' });
        const onProgress = (p) => { if (alive.current) setProgress(prev => ({ ...prev, ...p })); };
        try {
            if (mode === 'edit') {
                await saveCollectionEdits(feedUrl, { title, author, description, coverUri: cover, chapters, book, bookUri, bookRanges, onProgress });
                navigation.goBack();
                return;
            }
            const draft = { title, author, description, coverUri: cover, chapters, book, bookUri, bookRanges };
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
    }, [canSubmit, mode, chapters, title, author, description, cover, feedUrl, navigation, book, bookUri, bookRanges]);

    const submitLabel = mode === 'edit' ? 'Save'
        : mode === 'append' ? `Add ${chapters.length} ${chapters.length === 1 ? 'file' : 'files'}`
        : `Import ${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}`;
    const total = totalDuration(chapters);
    const bookWords = useMemo(() => (book ? book.sections.reduce((n, s) => n + (s.words || 0), 0) : 0), [book]);
    // Where a chapter's audio could not possibly read the part of the book it
    // points at, the pace it would take says so — the clearest sign that the
    // mapping is off, shown where it is put right.
    const misfitPace = useMemo(() => {
        if (!book || !bookRanges) return null;
        return chapters.map((ch, i) => paceIfImpossible(wordCountInRange(book, bookRanges[i]), (ch.durationSec || 0) * 1000));
    }, [book, bookRanges, chapters]);
    const pickerOptions = useMemo(() => {
        if (!book) return [];
        return [
            { key: 'none', label: 'No text', words: 0, section: null, kind: 'none' },
            ...book.sections.map((s, j) => ({ key: String(j), label: sectionLabel(s, j), words: s.words || 0, section: j, kind: s.kind })),
        ];
    }, [book]);
    const progressLabel = (p) => {
        if (!p) return '';
        const n = `${Math.min((p.index ?? 0) + 1, p.total || chapters.length)} of ${p.total || chapters.length}`;
        const what = p.title ? ` · ${p.title}` : '';
        if (p.phase === 'split') return `Splitting${what}`;
        if (p.phase === 'text') return `Writing the book text ${n}${what}`;
        if (p.phase === 'save') return 'Saving…';
        return `Copying ${n}${what}`;
    };

    if (phase === 'loading') {
        return (
            <View style={[styles.container, styles.center]}>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.loadNote}>{mode === 'edit' ? 'Loading…' : loadNote}</Text>
            </View>
        );
    }

    const editing = phase === 'ready';
    const currentPick = picker && bookRanges ? bookRanges[picker.index]?.s0 ?? null : null;
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

                {/* The book: its text stands in for a transcript of every chapter mapped to a part of it. */}
                <View style={styles.section}>
                    <Text style={styles.fieldLabel}>BOOK TEXT</Text>
                    <View style={styles.card}>
                        {book ? (
                            <View style={styles.bookBlock}>
                                <View style={styles.bookRow}>
                                    <Icon name="book-open" size={18} color={colors.accent} />
                                    <View style={styles.bookInfo}>
                                        <Text style={styles.bookTitle} numberOfLines={1}>{book.title || bookName || 'Book'}</Text>
                                        <Text style={styles.bookMeta} numberOfLines={1}>
                                            {`${book.sections.length} sections · ${bookWords.toLocaleString()} words${bookName ? ` · ${bookName}` : ''}`}
                                        </Text>
                                    </View>
                                    {bookUri && (
                                        <TouchableOpacity
                                            onPress={handleRemoveBook}
                                            disabled={!editing}
                                            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                                            accessibilityRole="button"
                                            accessibilityLabel="Leave the book out"
                                        >
                                            <Icon name="x" size={16} color={colors.textFaint} />
                                        </TouchableOpacity>
                                    )}
                                </View>
                                <Text style={styles.bookHint}>
                                    Chapters show the book's words instead of a transcript. Tap a chapter's “Text” line to change which part it reads; sync the times to the audio later from the Player.
                                </Text>
                            </View>
                        ) : (
                            <TouchableOpacity
                                style={styles.bookAttach}
                                onPress={handleAttachBook}
                                disabled={!editing || attaching}
                                accessibilityRole="button"
                                accessibilityLabel="Attach the book as an EPUB"
                            >
                                {attaching
                                    ? <ActivityIndicator size="small" color={colors.accent} />
                                    : <Icon name="book-open" size={18} color={colors.accent} />}
                                <View style={styles.bookInfo}>
                                    <Text style={styles.bookAttachText}>{attaching ? 'Reading the book…' : 'Attach the book (EPUB)…'}</Text>
                                    <Text style={styles.bookMeta}>With the EPUB, chapters read the book's own text — no transcription needed.</Text>
                                </View>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>

                {mode !== 'edit' && splitChapters && wholeChapters && (
                    <View style={styles.section}>
                        <View style={[styles.card, styles.switchRow]}>
                            <View style={styles.bookInfo}>
                                <Text style={styles.switchTitle}>Split into chapters</Text>
                                <Text style={styles.bookMeta} numberOfLines={2}>
                                    {`${splitChapters.length} chapter markers inside ${wholeChapters.length === 1 ? wholeChapters[0].name : `${wholeChapters.length} files`}`}
                                </Text>
                            </View>
                            <Switch
                                value={splitOn}
                                onValueChange={toggleSplit}
                                disabled={!editing}
                                trackColor={{ false: colors.surfaceHigh, true: withAlpha(colors.accent, 0.45) }}
                                thumbColor={splitOn ? colors.accent : colors.textSecondary}
                                ios_backgroundColor={colors.surfaceHigh}
                                accessibilityLabel="Split the file at its chapter markers"
                            />
                        </View>
                    </View>
                )}

                <View style={styles.section}>
                    <View style={styles.chaptersHead}>
                        <Text style={styles.fieldLabel}>
                            {`CHAPTERS · ${chapters.length}${total > 0 ? ` · ${formatDuration(total)}` : ''}`}
                        </Text>
                        {mode !== 'edit' && (
                            <Text style={styles.chaptersHint}>
                                {splitOn && splitChapters ? "Names come from the file's chapter markers; tap to change." : "Names come from the files' tags; tap to change."}
                            </Text>
                        )}
                    </View>
                    <View style={styles.card}>
                        {chapters.map((ch, i) => (
                            <View
                                key={ch.id || (ch.clip ? `${ch.uri}#${ch.clip.startMs}` : ch.uri) || i}
                                style={[styles.chapterRow, i > 0 && styles.rowBorder]}
                            >
                                <Text style={styles.chapterNo}>{i + 1}</Text>
                                <View style={styles.chapterBody}>
                                    <TextInput
                                        style={styles.chapterInput}
                                        value={ch.title}
                                        onChangeText={(t) => setChapterTitle(i, t)}
                                        placeholder={`Chapter ${i + 1}`}
                                        placeholderTextColor={colors.textFaint}
                                        editable={editing}
                                    />
                                    {book && (
                                        <TouchableOpacity
                                            onPress={() => openPicker(i)}
                                            disabled={!editing}
                                            hitSlop={{ top: 4, bottom: 6 }}
                                            accessibilityRole="button"
                                            accessibilityLabel={misfitPace?.[i]
                                                ? `Text this chapter reads: ${describeRange(book, bookRanges?.[i])}, which does not fit its audio. Change`
                                                : `Text this chapter reads: ${describeRange(book, bookRanges?.[i])}. Change`}
                                        >
                                            <Text
                                                style={[
                                                    styles.textLine,
                                                    !bookRanges?.[i] && styles.textLineNone,
                                                    misfitPace?.[i] && styles.textLineWarn,
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {`Text: ${describeRange(book, bookRanges?.[i])}`}
                                                {misfitPace?.[i] ? ' · does not fit' : ''}
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
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
                        <Text style={styles.progressText} numberOfLines={1}>{progressLabel(progress)}</Text>
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

            {/* Which part of the book a chapter reads */}
            <Modal visible={!!picker} transparent animationType="fade" onRequestClose={() => setPicker(null)} statusBarTranslucent>
                <View style={styles.pickerBackdrop}>
                    <TouchableOpacity style={styles.pickerDismiss} onPress={() => setPicker(null)} accessibilityLabel="Close" />
                    <View style={[styles.pickerCard, { paddingBottom: bottom + 8 }]}>
                        <View style={styles.pickerHead}>
                            <Text style={styles.pickerTitle} numberOfLines={1}>
                                {picker ? `Text for chapter ${picker.index + 1}${chapters[picker.index]?.title ? ` · ${chapters[picker.index].title}` : ''}` : ''}
                            </Text>
                            <TouchableOpacity onPress={() => setPicker(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel="Close">
                                <Icon name="x" size={20} color={colors.textSecondary} />
                            </TouchableOpacity>
                        </View>
                        <FlatList
                            data={pickerOptions}
                            keyExtractor={(o) => o.key}
                            getItemLayout={(_, index) => ({ length: PICKER_ROW_H, offset: PICKER_ROW_H * index, index })}
                            initialScrollIndex={currentPick != null ? Math.max(0, currentPick + 1 - 2) : 0}
                            renderItem={({ item }) => {
                                const selected = item.section === currentPick;
                                return (
                                    <TouchableOpacity
                                        style={[styles.pickerRow, selected && styles.pickerRowSelected]}
                                        onPress={() => choosePart(item.section)}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected }}
                                    >
                                        <Text style={[styles.pickerLabel, item.kind === 'matter' && styles.pickerLabelMatter]} numberOfLines={1}>{item.label}</Text>
                                        {item.words > 0 && <Text style={styles.pickerWords}>{`${item.words.toLocaleString()} w`}</Text>}
                                        {selected && <Icon name="check" size={16} color={colors.accent} />}
                                    </TouchableOpacity>
                                );
                            }}
                        />
                    </View>
                </View>
            </Modal>
        </KeyboardAvoidingView>
    );
};

const PICKER_ROW_H = 46;

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
    chapterBody: { flex: 1, minWidth: 0 },
    chapterInput: { color: colors.textPrimary, fontSize: 14, paddingVertical: 8 },
    chapterMeta: { ...type.label, fontWeight: '400', color: colors.textMuted },
    textLine: { ...type.label, fontWeight: '600', color: colors.accent, paddingBottom: 6 },
    textLineNone: { color: colors.textFaint, fontWeight: '400' },
    textLineWarn: { color: colors.warning },
    emptyChapters: { ...type.body, color: colors.textMuted, padding: 16, textAlign: 'center' },

    bookBlock: { padding: 12, gap: 8 },
    bookRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    bookInfo: { flex: 1, minWidth: 0, gap: 2 },
    bookTitle: { ...type.bodyStrong, color: colors.textPrimary },
    bookMeta: { ...type.label, fontWeight: '400', color: colors.textMuted },
    bookHint: { ...type.label, fontWeight: '400', color: colors.textFaint, lineHeight: 17 },
    bookAttach: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
    bookAttachText: { ...type.bodyStrong, color: colors.accent },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
    switchTitle: { ...type.bodyStrong, color: colors.textPrimary },

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

    pickerBackdrop: { flex: 1, backgroundColor: withAlpha('#000000', 0.55), justifyContent: 'flex-end' },
    pickerDismiss: { flex: 1 },
    pickerCard: {
        maxHeight: '75%', backgroundColor: colors.surface,
        borderTopLeftRadius: 18, borderTopRightRadius: 18,
        borderWidth: 0.5, borderColor: colors.hairline,
    },
    pickerHead: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        paddingHorizontal: 16, paddingVertical: 14,
        borderBottomWidth: 0.5, borderBottomColor: colors.hairlineFaint,
    },
    pickerTitle: { ...type.bodyStrong, color: colors.textPrimary, flex: 1 },
    pickerRow: {
        height: PICKER_ROW_H, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16,
        borderBottomWidth: 0.5, borderBottomColor: colors.hairlineFaint,
    },
    pickerRowSelected: { backgroundColor: withAlpha(colors.accent, 0.10) },
    pickerLabel: { ...type.body, color: colors.textPrimary, flex: 1 },
    pickerLabelMatter: { color: colors.textMuted },
    pickerWords: { ...type.label, fontWeight: '400', color: colors.textFaint },
});

export default CollectionEditorScreen;
