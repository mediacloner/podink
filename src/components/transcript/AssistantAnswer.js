import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, withAlpha, useTheme, useStyles } from '../../theme';
import {
    ASK_BETTER_MODEL, ASK_FIRST_MODEL, askAssistant, formatDollars, getOpenAIKey, modelInfo,
} from '../../services/aiService';
import { shareQuestion } from './share';
import { AskAssistantButton } from './SheetModal';

// The "ask" link of the translation and word cards. With an OpenAI key the
// question goes to Luna and the answer lands in the card; "Ask
// Sol" hands the same question, and Luna's answer, to the flagship model.
// Without a key it is the share sheet, as before — and "Other apps", under
// an answer, keeps that door open.
//
// `question` is the full request text (share.questionAboutText / Word);
// a new question clears the answers. `large` is the error-state button.
// Each answer shows in English first, then the same in `lang` beneath it.
// `leading` is the card's own links, set in the same row as the ask ones;
// the answers open under that row. `onAnswered` fires as each one lands.
const AssistantAnswer = ({ question, lang = 'en', large = false, leading = null, onAnswered }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const [hasKey, setHasKey] = useState(null);
    const [answers, setAnswers] = useState([]);   // [{ model, answer, cost }]
    const [busy, setBusy] = useState(null);       // model id being asked
    const [error, setError] = useState('');
    const abortRef = useRef(null);

    useEffect(() => {
        let live = true;
        getOpenAIKey().then((k) => { if (live) setHasKey(!!k); }).catch(() => {});
        return () => { live = false; };
    }, []);

    useEffect(() => {
        abortRef.current?.abort();
        setAnswers([]);
        setBusy(null);
        setError('');
    }, [question]);
    useEffect(() => () => abortRef.current?.abort(), []);
    // Tells the card each time an answer lands (the translation card folds
    // its own translation away then — again after "Show translation").
    useEffect(() => { if (answers.length) onAnswered?.(); }, [answers.length]); // eslint-disable-line react-hooks/exhaustive-deps

    const ask = useCallback(async (model, unclear = '') => {
        if (busy || !question) return;
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setBusy(model);
        setError('');
        try {
            const r = await askAssistant({ question, lang, model, unclear, signal: ctrl.signal });
            if (!ctrl.signal.aborted) setAnswers((a) => [...a, r]);
        } catch (e) {
            if (!ctrl.signal.aborted) setError(e?.message || 'The assistant did not answer.');
        } finally {
            if (!ctrl.signal.aborted) setBusy(null);
        }
    }, [busy, question, lang]);

    const onShare = useCallback(() => shareQuestion(question), [question]);

    if (hasKey !== true) {
        return (
            <View style={st.row}>
                {leading}
                {hasKey === false && <AskAssistantButton onPress={onShare} compact={!large} />}
            </View>
        );
    }

    const last = answers[answers.length - 1];
    const askedSol = answers.some((a) => a.model === ASK_BETTER_MODEL);
    const label = (id) => modelInfo(id).label;

    return (
        <View style={st.root}>
            <View style={st.row}>
                {leading}
                {busy ? (
                    <View style={st.busy}>
                        <ActivityIndicator size='small' color={colors.accent} />
                        <Text style={st.linkText}>Asking {label(busy)}…</Text>
                    </View>
                ) : !last ? (
                    <TouchableOpacity
                        style={large ? st.bigBtn : st.link}
                        onPress={() => ask(ASK_FIRST_MODEL)}
                        activeOpacity={0.75}
                        accessibilityRole='button'
                        accessibilityLabel={`Ask ${label(ASK_FIRST_MODEL)} about this text`}
                    >
                        <Icon name='message-circle' size={large ? 15 : 13} color={colors.accent} />
                        <Text style={large ? st.bigBtnText : st.linkText}>
                            {error ? 'Try again' : `Ask ${label(ASK_FIRST_MODEL)}`}
                        </Text>
                    </TouchableOpacity>
                ) : !askedSol && (
                    <TouchableOpacity
                        style={st.link}
                        onPress={() => ask(ASK_BETTER_MODEL, last.english || last.translated)}
                        activeOpacity={0.75}
                        accessibilityRole='button'
                        accessibilityLabel={`Not clear? Ask ${label(ASK_BETTER_MODEL)}`}
                    >
                        <Icon name='zap' size={13} color={colors.accent} />
                        <Text style={st.linkText}>Ask {label(ASK_BETTER_MODEL)}</Text>
                    </TouchableOpacity>
                )}
            </View>

            {answers.map((a, i) => (
                <View key={i} style={st.answerBox}>
                    <View style={st.answerHead}>
                        <Icon name='message-circle' size={12} color={colors.accent} />
                        <Text style={st.answerLabel}>{label(a.model).toUpperCase()}</Text>
                        <Text style={st.answerCost}>{formatDollars(a.cost)}</Text>
                    </View>
                    {!!a.english && <Text style={st.answerText} selectable>{a.english}</Text>}
                    {!!a.english && !!a.translated && <View style={st.answerRule} />}
                    {!!a.translated && <Text style={st.translatedText} selectable>{a.translated}</Text>}
                </View>
            ))}

            {!!error && <Text style={st.error}>{error}</Text>}

            {/* Under the answer: the same question to any app on the phone */}
            {(!!last || !!error) && !busy && (
                <TouchableOpacity style={[st.link, st.otherLink]} onPress={onShare} activeOpacity={0.75} accessibilityRole='button'>
                    <Icon name='share-2' size={12} color={colors.textMuted} />
                    <Text style={st.otherText}>Other apps</Text>
                </TouchableOpacity>
            )}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    root: { gap: 10, alignSelf: 'stretch' },
    answerBox: {
        padding: 12,
        paddingTop: 10,
        borderRadius: radii.s,
        backgroundColor: withAlpha(colors.accent, 0.07),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.3),
        gap: 6,
    },
    answerHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    answerLabel: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },
    answerCost: { color: colors.textMuted, fontSize: 11, marginLeft: 'auto' },
    answerText: { color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
    answerRule: { height: 0.5, backgroundColor: withAlpha(colors.accent, 0.3), marginVertical: 4 },
    translatedText: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
    error: { color: colors.danger, fontSize: 13, lineHeight: 19 },
    row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16, rowGap: 10 },
    busy: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    link: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    linkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    otherLink: { alignSelf: 'flex-start' },
    otherText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
    bigBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        paddingVertical: 11,
        paddingHorizontal: 16,
        borderRadius: radii.pill,
        backgroundColor: withAlpha(colors.accent, 0.12),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.35),
    },
    bigBtnText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
});

export default AssistantAnswer;
