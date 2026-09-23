/**
 * The card for an idiom the episode uses (services/phraseIndex.js): what it
 * means, why those words have come to mean it, and what the speaker is
 * saying with it here — the three things a dictionary entry for "bite the
 * bullet" cannot tell a listener about this particular sentence. The line
 * itself is quoted with the idiom set in bold.
 *
 * `data` is { phrase, startMs, contextText } or null; `phrase` is an
 * EpisodePhrases row of kind 'idiom'. The footer hands over to the word card
 * on the idiom's dictionary form, or replays the line.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, useStyles, useTheme, withAlpha } from '../../theme';
import SheetModal, { SheetIconButton } from './SheetModal';
import { shareText } from './share';
import { fetchTranslation, langLabel, translateErrorMessage } from './translate';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The quoted line cut around the idiom, so it can be set in bold: the words
// as heard, with any punctuation or spacing the recogniser put between them.
const splitAround = (line, surface) => {
    const words = String(surface || '').split(/\s+/).filter(Boolean).map(w => escapeRe(w.replace(/[^\p{L}\p{N}'’]/gu, '')));
    if (!line || !words.length || words.some(w => !w)) return null;
    const re = new RegExp(words.join('[^\\p{L}\\p{N}]+'), 'iu');
    const m = re.exec(line);
    if (!m) return null;
    return [line.slice(0, m.index), m[0], line.slice(m.index + m[0].length)];
};

const IdiomSheet = ({ data, lang = 'es', onClose, onReplay, onDictionary }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const visible = !!data;
    const phrase = data?.phrase || null;
    // The whole explanation in the learner's language — the meaning, why the
    // words mean it, and what the speaker is saying with it here (user: "when
    // you translate in spanish translate all explanations"):
    // idle | loading | ready { meaning, origin, here } | error { message }
    const [tr, setTr] = useState({ status: 'idle' });
    useEffect(() => { setTr({ status: 'idle' }); }, [phrase?.id, lang]);

    const translate = useCallback(async () => {
        if (!phrase?.meaning || tr.status === 'loading') return;
        if (tr.status === 'ready') { setTr({ status: 'idle' }); return; }
        setTr({ status: 'loading' });
        try {
            // One after another: Google throttles a burst from one address.
            const out = {};
            for (const key of ['meaning', 'origin', 'here']) {
                const text = String(phrase[key] || '').trim();
                out[key] = text ? await fetchTranslation(text, lang) : '';
            }
            setTr({ status: 'ready', ...out });
        } catch (e) {
            setTr({ status: 'error', message: translateErrorMessage(e) });
        }
    }, [phrase, lang, tr.status]);

    const line = (data?.contextText || phrase?.context || '').trim();
    const parts = useMemo(() => splitAround(line, phrase?.surface), [line, phrase?.surface]);

    const onShare = useCallback(() => {
        if (!phrase) return;
        shareText([phrase.base, phrase.meaning, line ? `“${line}”` : ''].filter(Boolean).join('\n\n'), 'Share');
    }, [phrase, line]);

    if (!phrase) return <SheetModal visible={false} onClose={onClose} />;

    const heardDiffers = phrase.surface && phrase.surface.toLowerCase() !== phrase.base.toLowerCase();

    const header = (
        <>
            <View style={st.labelRow}>
                <Icon name='message-circle' size={13} color={colors.textMuted} />
                <Text style={st.label}>Idiom</Text>
                <View style={{ flex: 1 }} />
                <SheetIconButton icon='share-2' label='Share' onPress={onShare} />
            </View>
            <Text style={st.title} numberOfLines={3}>{phrase.base}</Text>
            {heardDiffers && <Text style={st.heard} numberOfLines={2}>Heard as “{phrase.surface}”</Text>}
        </>
    );

    const footer = (
        <View style={st.actions}>
            {!!onDictionary && (
                <TouchableOpacity
                    style={[st.actionBtn, st.actionBtnGhost]}
                    onPress={onDictionary}
                    activeOpacity={0.8}
                    accessibilityRole='button'
                    accessibilityLabel='Look it up in the dictionary'
                >
                    <Icon name='book-open' size={14} color={colors.accent} />
                    <Text style={[st.actionText, { color: colors.accent }]}>Dictionary</Text>
                </TouchableOpacity>
            )}
            {data?.startMs != null && !!onReplay && (
                <TouchableOpacity
                    style={[st.actionBtn, st.replayBtn]}
                    onPress={() => onReplay(Math.max(0, data.startMs - 1000))}
                    activeOpacity={0.8}
                    accessibilityRole='button'
                    accessibilityLabel='Play this line again'
                >
                    <Icon name='rotate-ccw' size={14} color={colors.onAccent} />
                    <Text style={[st.actionText, { color: colors.onAccent }]}>Replay</Text>
                </TouchableOpacity>
            )}
        </View>
    );

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} footer={footer} maxHeight='88%'>
            <Text style={st.sectionLabel}>Meaning</Text>
            <Text style={st.meaning}>{phrase.meaning}</Text>
            <TouchableOpacity style={st.inlineLink} onPress={translate} activeOpacity={0.7} accessibilityRole='button'>
                {tr.status === 'loading'
                    ? <ActivityIndicator size='small' color={colors.accent} />
                    : <Text style={st.inlineLinkText}>{tr.status === 'ready' ? 'Hide translation' : `In ${langLabel(lang)}`}</Text>}
            </TouchableOpacity>
            {tr.status === 'ready' && !!tr.meaning && <Text style={st.translation}>{tr.meaning}</Text>}
            {tr.status === 'error' && <Text style={st.softError}>{tr.message}</Text>}

            {!!phrase.origin && (
                <>
                    <View style={st.divider} />
                    <Text style={st.sectionLabel}>Why it means this</Text>
                    <Text style={st.body}>{phrase.origin}</Text>
                    {tr.status === 'ready' && !!tr.origin && <Text style={st.translation}>{tr.origin}</Text>}
                </>
            )}

            {!!phrase.here && (
                <>
                    <View style={st.divider} />
                    <Text style={st.sectionLabel}>In this episode</Text>
                    <Text style={st.body}>{phrase.here}</Text>
                    {tr.status === 'ready' && !!tr.here && <Text style={st.translation}>{tr.here}</Text>}
                </>
            )}

            {!!line && (
                <>
                    <View style={st.divider} />
                    <Text style={st.context}>
                        “{parts ? (
                            <>
                                {parts[0]}
                                <Text style={st.contextIdiom}>{parts[1]}</Text>
                                {parts[2]}
                            </>
                        ) : line}”
                    </Text>
                </>
            )}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    label: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    title: { color: colors.textPrimary, fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.4 },
    heard: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic', marginTop: 4 },

    sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
    meaning: { color: colors.textPrimary, fontSize: 17, lineHeight: 24 },
    translation: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, fontStyle: 'italic' },
    softError: { color: colors.textMuted, fontSize: 13 },
    body: { color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
    divider: { height: 0.5, backgroundColor: colors.hairline, marginVertical: 14 },
    context: { color: colors.textMuted, fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
    contextIdiom: {
        color: colors.textPrimary, fontWeight: '700', fontStyle: 'normal',
        backgroundColor: withAlpha(colors.phraseBand, colors.phraseBandAlpha),
    },
    inlineLink: { alignSelf: 'flex-start', marginTop: 6, marginBottom: 6, minHeight: 20, justifyContent: 'center' },
    inlineLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },

    actions: { flexDirection: 'row', gap: 10, paddingTop: 14 },
    actionBtn: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 7, paddingVertical: 13, paddingHorizontal: 10, borderRadius: radii.pill,
    },
    actionBtnGhost: { backgroundColor: colors.hairlineFaint, borderWidth: 0.5, borderColor: colors.hairline },
    replayBtn: { backgroundColor: colors.accent },
    actionText: { fontSize: 14, fontWeight: '700' },
});

export default IdiomSheet;
