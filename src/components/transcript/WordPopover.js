import React, { useCallback, useEffect, useState } from 'react';
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
import { fetchWordInfo, langLabel } from './translate';

// In-memory lookup cache, keyed by language + normalized word.
const _cache = new Map();

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
    const [error, setError] = useState(false);
    const [saved, setSaved] = useState(false);
    const [savedId, setSavedId] = useState(null);
    const [saving, setSaving] = useState(false);

    const visible = !!data;
    const word = data?.word ?? '';
    const normalized = normalizeWord(word);

    useEffect(() => {
        if (!visible) return;
        let stale = false;
        const ctrl = new AbortController();

        setSaved(false);
        setSavedId(null);
        setError(false);

        if (!normalized) {
            setLookup({ translation: '', senses: [] });
            setLoading(false);
            return;
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
            fetchWordInfo(normalized, lang, ctrl.signal)
                .then(info => {
                    if (stale) return;
                    if (!info.translation && !info.senses.length) {
                        // Empty lookup — surface as error and DON'T cache, so
                        // the next open retries instead of a permanent blank.
                        setError(true);
                        setLoading(false);
                        return;
                    }
                    _cache.set(key, info);
                    setLookup(info);
                    setLoading(false);
                })
                .catch(e => {
                    if (stale || e?.name === 'AbortError') return;
                    setError(true);
                    setLoading(false);
                });
        }

        return () => {
            stale = true;
            ctrl.abort();
        };
    }, [visible, word, normalized, lang, episodeId]);

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
                const firstSense = lookup?.senses?.[0];
                const id = await addVocabWord({
                    word,
                    normalized,
                    translation: lookup?.translation || '',
                    definition: firstSense ? `${firstSense.pos}: ${firstSense.terms.join(', ')}` : '',
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
                    <View style={st.langRow}>
                        <Text style={st.lang}>English</Text>
                        <Icon name='arrow-right' size={13} color={colors.textFaint} />
                        <Text style={st.lang}>{langLabel(lang)}</Text>
                    </View>

                    <ScrollView style={st.scroll} contentContainerStyle={st.scrollContent} showsVerticalScrollIndicator={false}>
                        {loading ? (
                            <ActivityIndicator color={colors.accent} style={{ marginVertical: 18 }} />
                        ) : error ? (
                            <Text style={st.errorText}>Lookup failed. Check your connection.</Text>
                        ) : (
                            <>
                                <Text style={st.translation}>{lookup?.translation || '—'}</Text>
                                {(lookup?.senses ?? []).map((s, i) => (
                                    <View key={i} style={st.sense}>
                                        {!!s.pos && <Text style={st.pos}>{s.pos}</Text>}
                                        <Text style={st.terms}>{s.terms.join(', ')}</Text>
                                    </View>
                                ))}
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
    langRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
    lang: { color: colors.accent, fontWeight: '700', fontSize: 13 },
    scroll: { flexShrink: 1 },
    scrollContent: { paddingBottom: 12 },
    translation: { color: colors.textPrimary, fontSize: 21, lineHeight: 30, fontWeight: '600', marginBottom: 14, letterSpacing: -0.2 },
    sense: { marginBottom: 10 },
    pos: { color: colors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 3 },
    terms: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
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
