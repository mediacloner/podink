import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator, Modal, Pressable, ScrollView,
    StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii } from '../../theme';
import { fetchTranslation, langLabel } from './translate';

// In-memory cache, keyed by language + chunk context so repeat long-presses
// on the same paragraph never re-hit the network within a session.
const _cache = new Map();

const TranslationModal = ({ visible, text, contextText, lang = 'es', onClose }) => {
    const { bottom } = useSafeAreaInsets();
    const [translationParts, setTranslationParts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (!visible || !contextText) return;
        setExpanded(false);

        const key = `${lang}:${contextText}`;
        const cached = _cache.get(key);
        if (cached) {
            setTranslationParts(cached);
            setLoading(false);
            setError(false);
            return;
        }

        // Stale-flag + AbortController: a re-open with different text can never
        // be overwritten by a slow response from a previous request.
        let stale = false;
        const ctrl = new AbortController();
        setLoading(true);
        setTranslationParts([]);
        setError(false);

        fetchTranslation(contextText, lang, ctrl.signal)
            .then(full => {
                if (stale) return;
                const parts = full.split(/\n+/).map(p => p.trim()).filter(Boolean);
                const out = parts.length ? parts : (full.trim() ? [full] : []);
                if (!out.length) {
                    // Empty result — surface as error and DON'T cache, so the
                    // next open retries instead of showing a permanent blank.
                    setError(true);
                    setLoading(false);
                    return;
                }
                _cache.set(key, out);
                setTranslationParts(out);
                setLoading(false);
            })
            .catch(e => {
                if (stale || e?.name === 'AbortError') return;
                setError(true);
                setLoading(false);
            });

        return () => {
            stale = true;
            ctrl.abort();
        };
    }, [visible, contextText, lang]);

    const lastTranslation = translationParts[translationParts.length - 1] ?? '';
    const translatedCtx = translationParts.slice(0, -1);
    const englishCtx = (contextText ?? '').split(/\n\n+/).map(p => p.trim()).filter(Boolean).slice(0, -1);
    const hasContext = translatedCtx.length > 0;

    return (
        <Modal visible={visible} transparent animationType='slide' onRequestClose={onClose}>
            <Pressable style={ms.backdrop} onPress={onClose}>
                <Pressable style={ms.sheet} onPress={() => {}}>
                    <View style={ms.handle} />
                    <View style={ms.langRow}>
                        <Text style={ms.lang}>English</Text>
                        <Text style={ms.arrow}>→</Text>
                        <Text style={ms.lang}>{langLabel(lang)}</Text>
                    </View>

                    {/* Scrollable body so expanded context never clips */}
                    <ScrollView
                        style={ms.scroll}
                        contentContainerStyle={ms.scrollContent}
                        showsVerticalScrollIndicator={false}
                    >
                        {/* Context pairs — English + translation side by side */}
                        {expanded && hasContext && translatedCtx.map((translated, i) => (
                            <View key={i} style={ms.contextBlock}>
                                <Text style={ms.contextEnglish}>{englishCtx[i] ?? ''}</Text>
                                <Text style={ms.contextTranslated}>{translated}</Text>
                                <View style={ms.contextDivider} />
                            </View>
                        ))}

                        {/* Current paragraph */}
                        <Text style={ms.originalText}>{text}</Text>
                        <View style={ms.divider} />
                        {loading ? <ActivityIndicator color={colors.accent} style={{ marginVertical: 16 }} />
                        : error ? <Text style={ms.errorText}>Translation failed. Check your connection.</Text>
                        : <>
                            <Text style={ms.translatedText}>{lastTranslation}</Text>
                            {hasContext && (
                                <TouchableOpacity onPress={() => setExpanded(e => !e)} style={ms.expandBtn}>
                                    <Text style={ms.expandBtnText}>{expanded ? 'Hide context' : 'Show context'}</Text>
                                </TouchableOpacity>
                            )}
                        </>}
                    </ScrollView>

                    <TouchableOpacity style={[ms.closeBtn, { marginBottom: Math.max(bottom, 16) }]} onPress={onClose}>
                        <Text style={ms.closeBtnText}>Close</Text>
                    </TouchableOpacity>
                </Pressable>
            </Pressable>
        </Modal>
    );
};

const ms = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: radii.xl,
        borderTopRightRadius: radii.xl,
        padding: 24,
        paddingBottom: 0,
        borderTopWidth: 0.5,
        borderTopColor: colors.hairline,
        maxHeight: '85%',
    },
    handle: { width: 36, height: 4, backgroundColor: colors.textMuted, borderRadius: 2, alignSelf: 'center', marginBottom: 22 },
    langRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 12 },
    lang: { color: colors.accent, fontWeight: '700', fontSize: 14 },
    arrow: { color: colors.textFaint, fontSize: 14 },
    scroll: { flexShrink: 1 },
    scrollContent: { paddingBottom: 8 },
    // Previous context blocks — English + translation paired
    contextBlock: { marginBottom: 4 },
    contextEnglish: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 6, fontStyle: 'italic' },
    contextTranslated: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 12 },
    contextDivider: { height: 0.5, backgroundColor: colors.hairlineFaint, marginBottom: 16 },
    // Current paragraph
    originalText: { color: colors.textMuted, fontSize: 16, lineHeight: 24, marginBottom: 16 },
    divider: { height: 0.5, backgroundColor: colors.hairline, marginBottom: 16 },
    translatedText: { color: colors.textPrimary, fontSize: 19, lineHeight: 28, fontWeight: '600', marginBottom: 12, letterSpacing: -0.2 },
    expandBtn: { alignSelf: 'flex-start', marginBottom: 20 },
    expandBtnText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    errorText: { color: colors.danger, fontSize: 15, marginBottom: 24 },
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
