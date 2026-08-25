import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useStyles } from '../../theme';
import { fetchTranslation, langLabel, translateErrorMessage } from './translate';
import { askAssistantAboutText, copyText, shareText } from './share';
import SheetModal, { AskAssistantButton, SheetIconButton } from './SheetModal';

// In-memory cache, keyed by language + chunk context so repeat long-presses
// on the same paragraph never re-hit the network within a session.
const _cache = new Map();

const TranslationModal = ({ visible, text, contextText, lang = 'es', onClose }) => {
    const { colors } = useTheme();
    const ms = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const [translationParts, setTranslationParts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);

    // Paragraphs fed into the request: up to two preceding chunks plus the
    // pressed one (see TranscriptHighlighter's onLongPress).
    const englishParagraphs = useMemo(
        () => (contextText ?? '').split(/\n\n+/).map(p => p.trim()).filter(Boolean),
        [contextText],
    );

    useEffect(() => {
        if (!visible || !contextText) return;
        setExpanded(false);

        const key = `${lang}:${contextText}`;
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

    // "Copied" flashes on the copy button, then reverts.
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1400);
        return () => clearTimeout(t);
    }, [copied]);
    useEffect(() => { if (!visible) setCopied(false); }, [visible]);

    const onCopy = useCallback(async () => { if (await copyText(text)) setCopied(true); }, [text]);
    const onShare = useCallback(() => shareText(text, 'Share English text'), [text]);
    const onAsk = useCallback(() => askAssistantAboutText(text, lang), [text, lang]);

    const lastTranslation = translationParts[translationParts.length - 1] ?? '';
    const translatedCtx = translationParts.slice(0, -1);
    const englishCtx = englishParagraphs.slice(0, -1);
    const hasContext = translatedCtx.length > 0;

    const header = (
        <View style={ms.langRow}>
            <Text style={ms.lang}>English</Text>
            <Text style={ms.arrow}>→</Text>
            <Text style={ms.lang}>{langLabel(lang)}</Text>
            <View style={ms.headerActions}>
                <SheetIconButton icon={copied ? 'check' : 'copy'} label='Copy English text' onPress={onCopy} active={copied} />
                <SheetIconButton icon='share-2' label='Share English text' onPress={onShare} />
            </View>
        </View>
    );

    const footer = (
        <TouchableOpacity style={[ms.closeBtn, { marginBottom: Math.max(bottom, 16) }]} onPress={onClose}>
            <Text style={ms.closeBtnText}>Close</Text>
        </TouchableOpacity>
    );

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} footer={footer} maxHeight='85%'>
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
                    <View style={ms.linkRow}>
                        {hasContext && (
                            <TouchableOpacity onPress={() => setExpanded(e => !e)} style={ms.linkBtn}>
                                <Text style={ms.linkText}>{expanded ? 'Hide context' : 'Show context'}</Text>
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
    originalText: { color: colors.textMuted, fontSize: 16, lineHeight: 24, marginBottom: 16 },
    divider: { height: 0.5, backgroundColor: colors.hairline, marginBottom: 16 },
    translatedText: { color: colors.textPrimary, fontSize: 19, lineHeight: 28, fontWeight: '600', marginBottom: 12, letterSpacing: -0.2 },
    linkRow: { flexDirection: 'row', alignItems: 'center', gap: 18, marginBottom: 20 },
    linkBtn: { alignSelf: 'flex-start' },
    linkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
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
