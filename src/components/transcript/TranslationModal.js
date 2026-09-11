import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, withAlpha, useTheme, useStyles } from '../../theme';
import { fetchTranslation, langLabel, translateErrorMessage } from './translate';
import { askAssistantAboutText, copyText, shareText } from './share';
import { getOpenAIKey, translateParagraphs } from '../../services/aiService';
import SheetModal, { AskAssistantButton, SheetIconButton } from './SheetModal';
import { showAlert } from '../AppAlert';
import {
    getNotebookEntry, removeNotebookEntry, saveNotebookEntry, updateNotebookNote, updateNotebookTranslation,
} from '../../services/notebookService';

// In-memory cache, keyed by engine + language + chunk context so repeat
// long-presses on the same paragraph never re-hit the network within a session.
const _cache = new Map();

// A note is written to the row this long after the last keystroke; the
// close of the card flushes whatever is still pending.
const NOTE_SAVE_DELAY_MS = 500;

// An English paragraph where every word opens the word card. Split on
// whitespace — the same cut the transcript makes — so the tapped token's
// index maps straight onto the chunk's words. The tap lands on a plain
// nested Text (RN routes presses only to real Text spans); the token's
// leading space is inside the span so the gap before a word counts too.
const TappableParagraph = ({ text, style, onWordPress, paragraphOffset = 0, translation = '' }) => {
    const tokens = useMemo(() => (text || '').split(/\s+/).filter(Boolean), [text]);
    if (!onWordPress) return <Text style={style}>{text}</Text>;
    return (
        <Text style={style}>
            {tokens.map((token, index) => (
                <Text
                    key={index}
                    suppressHighlighting
                    onPress={() => onWordPress({ token, index, tokens, paragraphOffset, translation })}
                >
                    {index > 0 ? ' ' : ''}{token}
                </Text>
            ))}
        </Text>
    );
};

// `onWordPress({ token, index, tokens, paragraphOffset, translation })`,
// optional, makes the English words tappable (see TappableParagraph).
// `precedingText` (the transcript just before the paragraph) and
// `episodeTitle` go along with the "ask an assistant" request as context.
// `episodeId` + `startMs` (the chunk's first-word time) name the sentence in
// the notebook (services/notebookService.js): the pencil in the header keeps
// it there, and a note field opens under the English text.
const TranslationModal = ({
    visible, text, contextText, precedingText = '', startMs = 0,
    episodeId, episodeTitle = '', podcastTitle = '', lang = 'es', onClose, onWordPress,
}) => {
    const { colors } = useTheme();
    const ms = useStyles(makeStyles);
    const [translationParts, setTranslationParts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [expanded, setExpanded] = useState(false);
    // Which engine produced what is on screen: 'g' the free one (always
    // first), 'ai' the model re-reading it with the lines before. `aiBusy`
    // is that second request in flight, `aiError` its failure — the free
    // translation stays on screen through both.
    const [engine, setEngine] = useState('g');
    const [aiBusy, setAiBusy] = useState(false);
    const [aiError, setAiError] = useState('');
    const [hasKey, setHasKey] = useState(false);
    const [copied, setCopied] = useState(false);

    // Paragraphs fed into the request: up to two preceding chunks plus the
    // pressed one (see TranscriptHighlighter's onLongPress).
    const englishParagraphs = useMemo(
        () => (contextText ?? '').split(/\n\n+/).map(p => p.trim()).filter(Boolean),
        [contextText],
    );

    // Only offer the model when there is a key to pay with.
    // What goes to the model as context. `precedingText` runs three chunks
    // back, and the card already shows (and sends for translation) the two
    // just before the pressed one — so the tail they occupy is trimmed off
    // rather than handing the model the same sentences twice.
    const contextBefore = useMemo(() => {
        const before = (precedingText || '').trim();
        const shown = englishParagraphs.slice(0, -1).join(' ').trim();
        if (before && shown && before.endsWith(shown)) return before.slice(0, -shown.length).trim();
        return before;
    }, [precedingText, englishParagraphs]);

    useEffect(() => {
        if (!visible) return;
        let alive = true;
        getOpenAIKey().then(k => { if (alive) setHasKey(!!k); }).catch(() => {});
        return () => { alive = false; };
    }, [visible]);

    useEffect(() => {
        if (!visible || !contextText) return;
        setExpanded(false);
        setEngine('g');
        setAiError('');

        // Two engines give two different answers for the same paragraph, so
        // the engine is part of the key. A paragraph already re-read with
        // context keeps that answer when the card opens on it again.
        const aiKey = `ai:${lang}:${contextText}`;
        const better = _cache.get(aiKey);
        if (better) {
            setTranslationParts(better);
            setEngine('ai');
            setLoading(false);
            setError('');
            return;
        }
        const key = `g:${lang}:${contextText}`;
        const cached = _cache.get(key);
        if (cached) {
            setTranslationParts(cached);
            setLoading(false);
            setError('');
            return;
        }

        // Stale-flag + AbortController: a re-open with different text can never
        // be overwritten by a slow response from a previous request.
        let stale = false;
        const ctrl = new AbortController();
        setLoading(true);
        setTranslationParts([]);
        setError('');

        const finish = (out) => {
            if (!out.length) {
                // Empty result — surface as error and DON'T cache, so the
                // next open retries instead of showing a permanent blank.
                setError('No translation came back for this text.');
                setLoading(false);
                return;
            }
            _cache.set(key, out);
            setTranslationParts(out);
            setLoading(false);
        };

        // The free engine always answers first: it is instant and costs
        // nothing, and most paragraphs need nothing more. The button under
        // the translation is what pays for a second, context-aware reading.
        fetchTranslation(contextText, lang, ctrl.signal)
            .then(full => {
                if (stale) return;
                const parts = full.split(/\n+/).map(p => p.trim()).filter(Boolean);
                // The paragraphs only pair up with the English ones when the
                // blank lines survive translation. They normally do, but if
                // Google collapses or adds breaks the counts drift and every
                // context pair would be off by one — so rather than show
                // mismatched pairs, re-ask for the pressed paragraph alone.
                if (parts.length === englishParagraphs.length) return finish(parts);
                return fetchTranslation(text, lang, ctrl.signal).then(solo => {
                    if (stale) return;
                    const one = (solo || '').trim();
                    finish(one ? [one] : []);
                });
            })
            .catch(e => {
                if (stale || e?.name === 'AbortError') return;
                setError(translateErrorMessage(e));
                setLoading(false);
            });

        return () => {
            stale = true;
            ctrl.abort();
        };
    }, [visible, contextText, englishParagraphs, text, lang]);

    // "Read it again with the lines before" — the one place the card spends
    // anything. The free translation stays on screen while the model works
    // and stays if it fails, so this can only improve what is there.
    const retryWithContext = useCallback(async () => {
        if (aiBusy || !contextText) return;
        setAiBusy(true);
        setAiError('');
        try {
            const out = await translateParagraphs({
                paragraphs: englishParagraphs, lang, before: contextBefore,
            });
            if (!out.length) throw new Error('empty');
            _cache.set(`ai:${lang}:${contextText}`, out);
            setTranslationParts(out);
            setEngine('ai');
        } catch (e) {
            setAiError(e?.kind === 'nokey'
                ? 'Add your OpenAI API key in Settings → Episode assistant first.'
                : e?.kind === 'quota' || e?.kind === 'auth' ? e.message
                : 'The model could not be reached. The translation below is unchanged.');
        } finally {
            setAiBusy(false);
        }
    }, [aiBusy, contextText, englishParagraphs, lang, contextBefore]);

    // Back to the free translation. Both readings are kept, so switching
    // between them costs nothing and asks no one — except the one case where
    // the card opened straight onto a paragraph read earlier with the model
    // and the free one was never fetched in this session.
    const backToGoogle = useCallback(async () => {
        if (aiBusy || !contextText) return;
        setAiError('');
        const cached = _cache.get(`g:${lang}:${contextText}`);
        if (cached) {
            setTranslationParts(cached);
            setEngine('g');
            return;
        }
        setAiBusy(true);
        try {
            const full = await fetchTranslation(contextText, lang);
            const parts = (full || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
            const out = parts.length === englishParagraphs.length
                ? parts
                : [((await fetchTranslation(text, lang)) || '').trim()].filter(Boolean);
            if (!out.length) throw new Error('empty');
            _cache.set(`g:${lang}:${contextText}`, out);
            setTranslationParts(out);
            setEngine('g');
        } catch (e) {
            setAiError(translateErrorMessage(e));
        } finally {
            setAiBusy(false);
        }
    }, [aiBusy, contextText, englishParagraphs, lang, text]);

    // "Copied" flashes on the copy button, then reverts.
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1400);
        return () => clearTimeout(t);
    }, [copied]);
    useEffect(() => { if (!visible) setCopied(false); }, [visible]);

    const onCopy = useCallback(async () => { if (await copyText(text)) setCopied(true); }, [text]);
    const onShare = useCallback(() => shareText(text, 'Share English text'), [text]);
    const onAsk = useCallback(
        () => askAssistantAboutText(text, lang, { before: precedingText, source: episodeTitle }),
        [text, lang, precedingText, episodeTitle],
    );

    const lastTranslation = translationParts[translationParts.length - 1] ?? '';
    const translatedCtx = translationParts.slice(0, -1);
    const englishCtx = englishParagraphs.slice(0, -1);
    const hasContext = translatedCtx.length > 0;

    // ── Notebook ─────────────────────────────────────────────────────────────
    // `entry` is the Notebook row for this sentence (null: not kept). The
    // note is edited locally and written NOTE_SAVE_DELAY_MS after the last
    // keystroke; closing the card writes whatever is still pending. Refs
    // mirror the state so the flush can run from effects and unmount.
    const [entry, setEntry] = useState(null);
    const [note, setNote] = useState('');
    const [focusNote, setFocusNote] = useState(false);
    const [notebookBusy, setNotebookBusy] = useState(false);
    const entryRef = useRef(null);
    const pendingNoteRef = useRef(null);
    const saveTimerRef = useRef(null);
    useEffect(() => { entryRef.current = entry; }, [entry]);

    const flushNote = useCallback(() => {
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        const pending = pendingNoteRef.current;
        const row = entryRef.current;
        pendingNoteRef.current = null;
        if (pending == null || !row) return;
        updateNotebookNote(row.id, pending).catch(() => {});
    }, []);

    useEffect(() => {
        if (!visible) { flushNote(); return undefined; }
        setEntry(null);
        setNote('');
        setFocusNote(false);
        if (episodeId == null) return undefined;
        let stale = false;
        getNotebookEntry(episodeId, startMs)
            .then((row) => {
                if (stale) return;
                setEntry(row);
                setNote(row?.note ?? '');
            })
            .catch(() => {});
        return () => { stale = true; };
    }, [visible, episodeId, startMs, flushNote]);
    useEffect(() => () => flushNote(), [flushNote]);

    // The translation arrives after the sentence was kept: fill it in.
    useEffect(() => {
        if (!entry || entry.translation || !lastTranslation) return;
        updateNotebookTranslation(entry.id, lastTranslation).catch(() => {});
    }, [entry, lastTranslation]);

    const onChangeNote = useCallback((t) => {
        setNote(t);
        pendingNoteRef.current = t;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(flushNote, NOTE_SAVE_DELAY_MS);
    }, [flushNote]);

    const toggleNotebook = useCallback(async () => {
        if (notebookBusy || episodeId == null) return;
        if (entry) {
            const remove = async () => {
                setNotebookBusy(true);
                try {
                    pendingNoteRef.current = null;
                    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
                    await removeNotebookEntry(entry.id);
                    setEntry(null);
                    setNote('');
                } catch (_) {}
                setNotebookBusy(false);
            };
            // A note typed in is the listener's own work: ask before losing it.
            if ((pendingNoteRef.current ?? note).trim()) {
                showAlert('Remove from notebook?', 'The sentence and the note you wrote will be deleted.', [
                    { text: 'Keep', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => { remove(); } },
                ]);
            } else {
                await remove();
            }
            return;
        }
        setNotebookBusy(true);
        try {
            const row = await saveNotebookEntry({
                episode_id: episodeId,
                episode_title: episodeTitle,
                podcast_title: podcastTitle,
                sentence: text,
                translation: lastTranslation,
                start_ms: startMs,
            });
            setEntry(row);
            setNote(row?.note ?? '');
            setFocusNote(true);
        } catch (_) {}
        setNotebookBusy(false);
    }, [notebookBusy, episodeId, entry, note, episodeTitle, podcastTitle, text, lastTranslation, startMs]);

    const header = (
        <View style={ms.langRow}>
            <Text style={ms.lang}>English</Text>
            <Text style={ms.arrow}>→</Text>
            <Text style={ms.lang}>{langLabel(lang)}</Text>
            <View style={ms.headerActions}>
                {episodeId != null && (
                    <SheetIconButton
                        icon={entry ? 'check' : 'edit-3'}
                        label={entry ? 'Remove from notebook' : 'Save to notebook'}
                        onPress={toggleNotebook}
                        active={!!entry}
                    />
                )}
                <SheetIconButton icon={copied ? 'check' : 'copy'} label='Copy English text' onPress={onCopy} active={copied} />
                <SheetIconButton icon='share-2' label='Share English text' onPress={onShare} />
            </View>
        </View>
    );

    const footer = (
        <TouchableOpacity style={ms.closeBtn} onPress={onClose}>
            <Text style={ms.closeBtnText}>Close</Text>
        </TouchableOpacity>
    );

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} footer={footer} maxHeight='85%'>
            {/* Context pairs — English + translation side by side */}
            {expanded && hasContext && translatedCtx.map((translated, i) => (
                <View key={i} style={ms.contextBlock}>
                    <TappableParagraph
                        text={englishCtx[i] ?? ''}
                        style={ms.contextEnglish}
                        onWordPress={onWordPress}
                        paragraphOffset={englishCtx.length - i}
                        translation={translated}
                    />
                    <Text style={ms.contextTranslated}>{translated}</Text>
                    <View style={ms.contextDivider} />
                </View>
            ))}

            {/* Current paragraph — tap a word to look it up */}
            <TappableParagraph
                text={text}
                style={ms.originalText}
                onWordPress={onWordPress}
                translation={lastTranslation}
            />

            {/* The sentence is in the notebook: its note, saved as it is typed */}
            {!!entry && (
                <View style={ms.noteBox}>
                    <View style={ms.noteHead}>
                        <Icon name='edit-3' size={12} color={colors.accent} />
                        <Text style={ms.noteLabel}>IN YOUR NOTEBOOK</Text>
                    </View>
                    <TextInput
                        style={ms.noteInput}
                        value={note}
                        onChangeText={onChangeNote}
                        onBlur={flushNote}
                        placeholder='Your note — the idea, why it matters, how you would put it…'
                        placeholderTextColor={colors.textMuted}
                        multiline
                        autoFocus={focusNote}
                        textAlignVertical='top'
                        scrollEnabled={false}
                        accessibilityLabel='Note for this sentence'
                    />
                </View>
            )}

            <View style={ms.divider} />
            {loading ? <ActivityIndicator color={colors.accent} style={{ marginVertical: 16 }} />
            : error ? (
                <View style={ms.errorBlock}>
                    <Text style={ms.errorText}>{error}</Text>
                    <AskAssistantButton onPress={onAsk} />
                    <Text style={ms.askHint}>
                        Sends the English text with a translation request to any app you pick — ChatGPT, Gemini, Claude…
                    </Text>
                </View>
            ) : (
                <>
                    <Text style={ms.translatedText}>{lastTranslation}</Text>
                    {/* Which engine wrote this, and whether it cost anything */}
                    <View style={ms.engineRow}>
                        <Icon
                            name={engine === 'ai' ? 'zap' : 'globe'}
                            size={12}
                            color={engine === 'ai' ? colors.success : colors.textMuted}
                        />
                        <Text style={[ms.engineText, engine === 'ai' && ms.engineTextAi]}>
                            {engine === 'ai' ? 'OpenAI · paid' : 'Google Translate · free'}
                        </Text>
                    </View>
                    {!!aiError && <Text style={ms.aiError}>{aiError}</Text>}
                    <View style={ms.linkRow}>
                        {hasContext && (
                            <TouchableOpacity onPress={() => setExpanded(e => !e)} style={ms.linkBtn}>
                                <Text style={ms.linkText}>{expanded ? 'Hide context' : 'Show context'}</Text>
                            </TouchableOpacity>
                        )}
                        {/* The two readings, either way round — whichever is
                            not on screen is the one offered. */}
                        {aiBusy ? (
                            <View style={ms.withCtx}>
                                <ActivityIndicator size='small' color={colors.accent} />
                                <Text style={ms.linkText}>Translating…</Text>
                            </View>
                        ) : engine === 'ai' ? (
                            <TouchableOpacity onPress={backToGoogle} style={ms.linkBtn}>
                                <Text style={ms.linkText}>Translate Google</Text>
                            </TouchableOpacity>
                        ) : hasKey && (
                            <TouchableOpacity onPress={retryWithContext} style={ms.linkBtn}>
                                <Text style={ms.linkText}>Translate OpenAI</Text>
                            </TouchableOpacity>
                        )}
                        <AskAssistantButton onPress={onAsk} compact />
                    </View>
                </>
            )}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    langRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 12 },
    lang: { color: colors.accent, fontWeight: '700', fontSize: 14 },
    arrow: { color: colors.textFaint, fontSize: 14 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
    // Previous context blocks — English + translation paired
    contextBlock: { marginBottom: 4 },
    contextEnglish: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 6, fontStyle: 'italic' },
    contextTranslated: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 12 },
    contextDivider: { height: 0.5, backgroundColor: colors.hairlineFaint, marginBottom: 16 },
    // Current paragraph
    // Larger than before and a step up from muted: this is the text to tap.
    originalText: { color: colors.textSecondary, fontSize: 18, lineHeight: 27, marginBottom: 16 },
    // Notebook: a ruled card under the sentence, accent-tinted like the
    // "ask" button so it reads as the listener's own layer on the text.
    noteBox: {
        marginBottom: 16,
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
    divider: { height: 0.5, backgroundColor: colors.hairline, marginBottom: 16 },
    translatedText: { color: colors.textPrimary, fontSize: 19, lineHeight: 28, fontWeight: '600', marginBottom: 12, letterSpacing: -0.2 },
    linkRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16, rowGap: 10, marginBottom: 20 },
    linkBtn: { alignSelf: 'flex-start' },
    linkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    withCtx: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    engineRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: -10, marginBottom: 14 },
    engineText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
    engineTextAi: { color: colors.success },
    aiError: { color: colors.danger, fontSize: 13, lineHeight: 19, marginBottom: 10 },
    errorBlock: { gap: 14, marginBottom: 20 },
    errorText: { color: colors.danger, fontSize: 15 },
    askHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
    closeBtn: {
        alignSelf: 'center',
        paddingVertical: 11,
        paddingHorizontal: 36,
        marginTop: 20,
        backgroundColor: colors.hairlineFaint,
        borderRadius: 22,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    closeBtnText: { color: colors.textPrimary, fontWeight: '600', fontSize: 15 },
});

export default TranslationModal;
