import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator, Modal, Pressable, ScrollView,
    StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, withAlpha } from '../../theme';
import {
    addVocabWord, getVocabWords, isVocabWordSaved,
    recordLookup, removeVocabWord,
} from '../../services/vocabularyService';
import { fetchTranslation, fetchWordInfo, langLabel, translateErrorMessage } from './translate';
import { fetchDefinitions } from './dictionary';
import { createAudioPlayer } from 'expo-audio';

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
    const { bottom } = useSafeAreaInsets();
    const [lookup, setLookup] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [ctxTranslation, setCtxTranslation] = useState('');
    const [saved, setSaved] = useState(false);
    const [savedId, setSavedId] = useState(null);
    const [saving, setSaving] = useState(false);

    const visible = !!data;
    const word = data?.word ?? '';
    // The chunk the word sits in — already carried for the vocabulary row.
    const sentence = (data?.contextText ?? '').trim();
    const normalized = normalizeWord(word);

    // Pronunciation audio — a fresh throwaway player per press so replays
    // always start from the beginning; the previous one is released first.
    const soundRef = useRef(null);
    const stopPronunciation = useCallback(() => {
        try { soundRef.current?.remove(); } catch (_) {}
        soundRef.current = null;
    }, []);

    useEffect(() => {
        if (!visible) stopPronunciation();
        return stopPronunciation;
    }, [visible, stopPronunciation]);

    const playPronunciation = useCallback(() => {
        const uri = lookup?.audioUrl;
        if (!uri) return;
        stopPronunciation();
        try {
            const player = createAudioPlayer({ uri });
            soundRef.current = player;
            player.play();
        } catch (_) {}
    }, [lookup, stopPronunciation]);

    useEffect(() => {
        if (!visible) return;
        let stale = false;
        const ctrl = new AbortController();

        setSaved(false);
        setSavedId(null);
        setError('');
        setCtxTranslation('');

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
                const d = dRes.status === 'fulfilled' ? dRes.value : { phonetic: '', meanings: [] };
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

    return (
        <Modal visible={visible} transparent animationType='slide' onRequestClose={onClose}>
            <Pressable style={st.backdrop} onPress={onClose}>
                <Pressable style={st.sheet} onPress={() => {}}>
                    <View style={st.handle} />
                    <Text style={st.word}>{word}</Text>
                    {(!!lookup?.phonetic || !!lookup?.audioUrl) && (
                        <View style={st.phoneticRow}>
                            {!!lookup?.phonetic && <Text style={st.phonetic}>{lookup.phonetic}</Text>}
                            {!!lookup?.audioUrl && (
                                <TouchableOpacity
                                    style={st.speakerBtn}
                                    onPress={playPronunciation}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    activeOpacity={0.7}
                                >
                                    <Icon name='volume-2' size={15} color={colors.accent} />
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                    <View style={st.langRow}>
                        <Text style={st.lang}>English</Text>
                        <Icon name='arrow-right' size={13} color={colors.textFaint} />
                        <Text style={st.lang}>{langLabel(lang)}</Text>
                    </View>

                    <ScrollView style={st.scroll} contentContainerStyle={st.scrollContent} showsVerticalScrollIndicator={false}>
                        {loading ? (
                            <ActivityIndicator color={colors.accent} style={{ marginVertical: 18 }} />
                        ) : error ? (
                            <Text style={st.errorText}>{error}</Text>
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
                            </>
                        )}
                    </ScrollView>

                    <View style={[st.actions, { paddingBottom: Math.max(bottom, 16) }]}>
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
                </Pressable>
            </Pressable>
        </Modal>
    );
};

const st = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: radii.xl,
        borderTopRightRadius: radii.xl,
        padding: 24,
        paddingBottom: 0,
        borderTopWidth: 0.5,
        borderTopColor: colors.hairline,
        maxHeight: '75%',
    },
    handle: { width: 36, height: 4, backgroundColor: colors.textMuted, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    word: { color: colors.textPrimary, fontSize: 30, fontWeight: '700', letterSpacing: -0.4, marginBottom: 10 },
    phoneticRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: -6, marginBottom: 10 },
    phonetic: { color: colors.textMuted, fontSize: 14 },
    speakerBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.hairlineFaint,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    langRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
    lang: { color: colors.accent, fontWeight: '700', fontSize: 13 },
    scroll: { flexShrink: 1 },
    scrollContent: { paddingBottom: 12 },
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
    errorText: { color: colors.danger, fontSize: 15, marginVertical: 12 },
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
