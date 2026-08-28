import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import { createAudioPlayer } from 'expo-audio';
import { radii, withAlpha, useTheme, useStyles } from '../../theme';
import {
    addVocabWord, getVocabWords, isVocabWordSaved,
    recordLookup, removeVocabWord,
} from '../../services/vocabularyService';
import { log } from '../../services/logService';
import { fetchTranslation, fetchWordInfo, langLabel, translateErrorMessage } from './translate';
import { fetchDefinitions } from './dictionary';
import { askAssistantAboutWord, copyText, shareText } from './share';
import SheetModal, { AskAssistantButton, SheetIconButton } from './SheetModal';

// In-memory lookup cache, keyed by language + normalized word.
const _cache = new Map();
// The sentence translation is cached separately: the same word turns up in
// different sentences, and each one needs its own contextual rendering.
const _ctxCache = new Map();

const IS_WORD_CHAR = /[\p{L}\p{N}]/u;

// Splits a sentence into alternating plain/matched segments so the looked-up
// word can be emphasised in place: even indices are plain text, odd ones are
// occurrences of the word. Display only — a plain scan rather than a built
// regex, since only literals are checked when the bundle is compiled.
const splitOnWord = (sentence, word) => {
    const needle = (word || '').trim().toLowerCase();
    if (!needle) return [sentence];
    const hay = sentence.toLowerCase();
    const parts = [];
    let plainFrom = 0;
    let search = 0;
    for (;;) {
        const at = hay.indexOf(needle, search);
        if (at < 0) break;
        search = at + needle.length;
        // Skip hits buried inside a longer word ('run' in 'running').
        const before = at > 0 ? sentence[at - 1] : '';
        const after = sentence[search] ?? '';
        if (IS_WORD_CHAR.test(before) || IS_WORD_CHAR.test(after)) continue;
        parts.push(sentence.slice(plainFrom, at), sentence.slice(at, search));
        plainFrom = search;
    }
    parts.push(sentence.slice(plainFrom));
    return parts;
};

export const normalizeWord = (raw) =>
    // Unicode-aware edge-trim so accented loanwords ('café', 'naïve', 'résumé')
    // aren't mangled to 'caf'/'na'/'r' before lookup and save.
    (raw || '').toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

// Bottom-sheet word lookup: translation + dictionary senses, save-to-vocabulary
// and replay-from-here. `data` is null (hidden) or {word, startMs, contextText}.
const WordPopover = ({ data, lang = 'es', episodeId, episodeTitle, onClose, onReplay }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const [lookup, setLookup] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [ctxTranslation, setCtxTranslation] = useState('');
    const [saved, setSaved] = useState(false);
    const [savedId, setSavedId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const [speaking, setSpeaking] = useState(false);

    const visible = !!data;
    const word = data?.word ?? '';
    // The chunk the word sits in — already carried for the vocabulary row.
    const sentence = (data?.contextText ?? '').trim();
    const normalized = normalizeWord(word);

    // ── Pronunciation ────────────────────────────────────────────────────────
    // On-device text-to-speech is the primary voice: it works offline, for
    // every word, and doesn't take audio focus away from the podcast. The
    // dictionary's recordings are only a fallback — its media host answers
    // 502 for most words (that was the "speaker does nothing" bug), and a
    // second player grabbing focus pauses the podcast underneath.
    const soundRef = useRef(null);
    const releaseRecording = useCallback(() => {
        try { soundRef.current?.remove(); } catch (_) {}
        soundRef.current = null;
    }, []);

    const stopPronunciation = useCallback(() => {
        Speech.stop().catch(() => {});
        releaseRecording();
        setSpeaking(false);
    }, [releaseRecording]);

    useEffect(() => {
        if (!visible) stopPronunciation();
        return stopPronunciation;
    }, [visible, stopPronunciation]);

    const playRecording = useCallback(() => {
        const uri = lookup?.audioUrl;
        if (!uri) return;
        releaseRecording();
        try {
            const player = createAudioPlayer({ uri });
            soundRef.current = player;
            player.play();
        } catch (e) {
            log('UI', 'Pronunciation recording failed', { uri, error: String(e?.message || e) });
        }
    }, [lookup, releaseRecording]);

    const pronounce = useCallback(() => {
        const spoken = normalized || word.trim();
        if (!spoken) return;
        releaseRecording();
        setSpeaking(true);
        // Android queues utterances (QUEUE_ADD): flush what's still being said.
        Speech.stop().catch(() => {});
        try {
            Speech.speak(spoken, {
                language: 'en-US',
                rate: 0.9,
                onDone: () => setSpeaking(false),
                onStopped: () => setSpeaking(false),
                onError: (e) => {
                    setSpeaking(false);
                    log('UI', 'TTS failed, falling back to recording', { word: spoken, error: String(e?.message || e) });
                    playRecording();
                },
            });
        } catch (e) {
            setSpeaking(false);
            log('UI', 'TTS unavailable, falling back to recording', { word: spoken, error: String(e?.message || e) });
            playRecording();
        }
    }, [normalized, word, releaseRecording, playRecording]);

    // ── Lookup ───────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!visible) return;
        let stale = false;
        const ctrl = new AbortController();

        setSaved(false);
        setSavedId(null);
        setError('');
        setCtxTranslation('');
        setCopied(false);

        if (!normalized) {
            setLookup({ translation: '', senses: [], phonetic: '', audioUrl: '', meanings: [] });
            setLoading(false);
            return;
        }

        // A bare-word translation is often the wrong sense outright ('left' →
        // 'izquierda' in a sentence that means 'salió'), so the containing
        // sentence is translated too and shown alongside. It's supplementary:
        // a failure here leaves the rest of the sheet untouched.
        if (sentence && sentence.toLowerCase() !== word.trim().toLowerCase()) {
            const ctxKey = `${lang}:${sentence}`;
            const ctxCached = _ctxCache.get(ctxKey);
            if (ctxCached) {
                setCtxTranslation(ctxCached);
            } else {
                fetchTranslation(sentence, lang, ctrl.signal)
                    .then(t => {
                        if (stale) return;
                        const trimmed = (t || '').trim();
                        if (trimmed) _ctxCache.set(ctxKey, trimmed);
                        setCtxTranslation(trimmed);
                    })
                    .catch(() => {});
            }
        }

        recordLookup(word, normalized, episodeId).catch(() => {});
        isVocabWordSaved(normalized)
            .then(v => { if (!stale) setSaved(!!v); })
            .catch(() => {});

        const key = `${lang}:${normalized}`;
        const cached = _cache.get(key);
        if (cached) {
            setLookup(cached);
            setLoading(false);
        } else {
            setLookup(null);
            setLoading(true);
            // Translation and English definitions load in parallel; either one
            // succeeding is enough to show the sheet.
            Promise.allSettled([
                fetchWordInfo(normalized, lang, ctrl.signal),
                fetchDefinitions(normalized, ctrl.signal),
            ]).then(([tRes, dRes]) => {
                if (stale) return;
                const t = tRes.status === 'fulfilled' ? tRes.value : { translation: '', senses: [] };
                const d = dRes.status === 'fulfilled' ? dRes.value : { phonetic: '', audioUrl: '', meanings: [] };
                const info = { ...t, ...d };
                if (!info.translation && !info.senses.length && !info.meanings.length) {
                    // Empty lookup — surface as error and DON'T cache, so
                    // the next open retries instead of a permanent blank.
                    const reason = tRes.status === 'rejected' ? tRes.reason : null;
                    setError(translateErrorMessage(
                        reason,
                        reason ? 'Lookup failed. Try again.' : 'No translation found for this word.',
                    ));
                    setLoading(false);
                    return;
                }
                _cache.set(key, info);
                setLookup(info);
                setLoading(false);
            });
        }

        return () => {
            stale = true;
            ctrl.abort();
        };
    }, [visible, word, normalized, sentence, lang, episodeId]);

    // ── Copy / share / ask ───────────────────────────────────────────────────
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1400);
        return () => clearTimeout(t);
    }, [copied]);

    const onCopy = useCallback(async () => { if (await copyText(word)) setCopied(true); }, [word]);
    const onShare = useCallback(() => {
        const hasSentence = sentence && sentence.toLowerCase() !== word.trim().toLowerCase();
        shareText(hasSentence ? `${word}\n\n“${sentence}”` : word, 'Share word');
    }, [word, sentence]);
    const onAsk = useCallback(() => askAssistantAboutWord(word, sentence, lang), [word, sentence, lang]);

    // ── Save / replay ────────────────────────────────────────────────────────
    const toggleSave = useCallback(async () => {
        if (!data || saving || !normalized) return;
        setSaving(true);
        try {
            if (saved) {
                let id = savedId;
                if (id == null) {
                    // Opened on an already-saved word: resolve the row id by normalized.
                    const all = await getVocabWords();
                    id = all.find(w => w.normalized === normalized)?.id;
                }
                if (id != null) await removeVocabWord(id);
                setSaved(false);
                setSavedId(null);
            } else {
                // Prefer a real English definition; fall back to translated senses.
                const firstMeaning = lookup?.meanings?.[0];
                const firstDef = firstMeaning?.definitions?.[0]?.definition;
                const firstSense = lookup?.senses?.[0];
                const definition = firstDef
                    ? (firstMeaning.pos ? `${firstMeaning.pos}: ${firstDef}` : firstDef)
                    : (firstSense ? `${firstSense.pos}: ${firstSense.terms.join(', ')}` : '');
                const id = await addVocabWord({
                    word,
                    normalized,
                    translation: lookup?.translation || '',
                    definition,
                    language: lang,
                    episode_id: episodeId,
                    episode_title: episodeTitle,
                    context_text: data.contextText || '',
                    word_start_ms: Math.round(data.startMs ?? 0),
                });
                setSavedId(id ?? null);
                setSaved(true);
            }
        } catch (_) {}
        setSaving(false);
    }, [data, saving, saved, savedId, normalized, word, lookup, lang, episodeId, episodeTitle]);

    const handleReplay = useCallback(() => {
        onReplay(Math.max(0, (data?.startMs ?? 0) - 1000));
    }, [onReplay, data]);

    // ── Render ───────────────────────────────────────────────────────────────
    const header = (
        <>
            <View style={st.wordRow}>
                <Text style={st.word} numberOfLines={2}>{word}</Text>
                <TouchableOpacity
                    style={[st.speakerBtn, speaking && st.speakerBtnActive]}
                    onPress={pronounce}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.7}
                    accessibilityRole='button'
                    accessibilityLabel={`Pronounce ${word}`}
                >
                    <Icon name='volume-2' size={17} color={speaking ? colors.bg : colors.accent} />
                </TouchableOpacity>
            </View>
            {!!lookup?.phonetic && <Text style={st.phonetic}>{lookup.phonetic}</Text>}
            <View style={st.langRow}>
                <Text style={st.lang}>English</Text>
                <Icon name='arrow-right' size={13} color={colors.textFaint} />
                <Text style={st.lang}>{langLabel(lang)}</Text>
                <View style={st.headerActions}>
                    <SheetIconButton icon={copied ? 'check' : 'copy'} label='Copy word' onPress={onCopy} active={copied} />
                    <SheetIconButton icon='share-2' label='Share word and sentence' onPress={onShare} />
                </View>
            </View>
        </>
    );

    const footer = (
        <View style={st.actions}>
            <TouchableOpacity
                style={[st.actionBtn, saved ? st.actionBtnSaved : st.actionBtnPrimary]}
                onPress={toggleSave}
                disabled={saving || loading}
                activeOpacity={0.8}
            >
                <Icon name={saved ? 'check' : 'bookmark'} size={15} color={saved ? colors.success : colors.bg} />
                <Text style={[st.actionText, { color: saved ? colors.success : colors.bg }]}>
                    {saved ? 'Saved' : 'Save to vocabulary'}
                </Text>
            </TouchableOpacity>

            <TouchableOpacity style={[st.actionBtn, st.actionBtnGhost]} onPress={handleReplay} activeOpacity={0.8}>
                <Icon name='rotate-ccw' size={15} color={colors.textPrimary} />
                <Text style={[st.actionText, { color: colors.textPrimary }]}>Replay</Text>
            </TouchableOpacity>
        </View>
    );

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} footer={footer} maxHeight='75%'>
            {loading ? (
                <ActivityIndicator color={colors.accent} style={{ marginVertical: 18 }} />
            ) : error ? (
                <View style={st.errorBlock}>
                    <Text style={st.errorText}>{error}</Text>
                    <AskAssistantButton onPress={onAsk} />
                    <Text style={st.askHint}>
                        Sends the word and its sentence to any app you pick — ChatGPT, Gemini, Claude…
                    </Text>
                </View>
            ) : (
                <>
                    <Text style={st.translation}>{lookup?.translation || '—'}</Text>
                    {(lookup?.senses ?? []).map((s, i) => (
                        <View key={i} style={st.sense}>
                            {!!s.pos && <Text style={st.pos}>{s.pos}</Text>}
                            <Text style={st.terms}>{s.terms.join(', ')}</Text>
                        </View>
                    ))}
                    {!!ctxTranslation && (
                        <>
                            <View style={st.sectionDivider} />
                            <Text style={st.sectionLabel}>In this sentence</Text>
                            <Text style={st.ctxEnglish}>
                                {splitOnWord(sentence, word).map((part, i) => (
                                    i % 2 === 1
                                        ? <Text key={i} style={st.ctxWord}>{part}</Text>
                                        : part
                                ))}
                            </Text>
                            <Text style={st.ctxTranslated}>{ctxTranslation}</Text>
                        </>
                    )}
                    {(lookup?.meanings ?? []).length > 0 && (
                        <>
                            <View style={st.sectionDivider} />
                            <Text style={st.sectionLabel}>English definitions</Text>
                            {lookup.meanings.map((m, i) => (
                                <View key={i} style={st.meaning}>
                                    {!!m.pos && <Text style={st.pos}>{m.pos}</Text>}
                                    {m.definitions.map((d, j) => (
                                        <View key={j} style={st.defRow}>
                                            <Text style={st.defNum}>{j + 1}.</Text>
                                            <View style={st.defBody}>
                                                <Text style={st.defText}>{d.definition}</Text>
                                                {!!d.example && <Text style={st.defExample}>“{d.example}”</Text>}
                                            </View>
                                        </View>
                                    ))}
                                </View>
                            ))}
                        </>
                    )}
                    <View style={st.askRow}>
                        <AskAssistantButton onPress={onAsk} compact />
                    </View>
                </>
            )}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    wordRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
    word: { flex: 1, color: colors.textPrimary, fontSize: 30, fontWeight: '700', letterSpacing: -0.4 },
    phonetic: { color: colors.textMuted, fontSize: 14, marginBottom: 6 },
    speakerBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.hairlineFaint,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    speakerBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    langRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 14 },
    lang: { color: colors.accent, fontWeight: '700', fontSize: 13 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
    translation: { color: colors.textPrimary, fontSize: 21, lineHeight: 30, fontWeight: '600', marginBottom: 14, letterSpacing: -0.2 },
    sense: { marginBottom: 10 },
    pos: { color: colors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 3 },
    terms: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
    sectionDivider: { height: 0.5, backgroundColor: colors.hairline, marginTop: 6, marginBottom: 14 },
    sectionLabel: { color: colors.accent, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
    ctxEnglish: { color: colors.textMuted, fontSize: 15, lineHeight: 22, fontStyle: 'italic', marginBottom: 6 },
    ctxWord: { color: colors.textPrimary, fontWeight: '700', fontStyle: 'italic' },
    ctxTranslated: { color: colors.textSecondary, fontSize: 16, lineHeight: 24, marginBottom: 4 },
    meaning: { marginBottom: 12 },
    defRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    defNum: { color: colors.textFaint, fontSize: 14, lineHeight: 21, fontWeight: '600' },
    defBody: { flex: 1 },
    defText: { color: colors.textPrimary, fontSize: 15, lineHeight: 21 },
    defExample: { color: colors.textMuted, fontSize: 14, lineHeight: 20, fontStyle: 'italic', marginTop: 3 },
    askRow: { marginTop: 8, marginBottom: 4 },
    errorBlock: { gap: 14, marginVertical: 8 },
    errorText: { color: colors.danger, fontSize: 15 },
    askHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
    actions: { flexDirection: 'row', gap: 10, paddingTop: 14 },
    actionBtn: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 13,
        borderRadius: radii.pill,
    },
    actionBtnPrimary: { backgroundColor: colors.accent },
    actionBtnSaved: { backgroundColor: withAlpha(colors.success, 0.14), borderWidth: 0.5, borderColor: withAlpha(colors.success, 0.4) },
    actionBtnGhost: { backgroundColor: colors.hairlineFaint, borderWidth: 0.5, borderColor: colors.hairline },
    actionText: { fontSize: 14, fontWeight: '700' },
});

export default WordPopover;
