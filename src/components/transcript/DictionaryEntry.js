import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { radii, withAlpha, useTheme, useStyles } from '../../theme';

// Renders a dictionary entry flattened by dictionaryHtml.flattenEntry.
//
// One <Text> per paragraph, one span per run; the run flags (bold, italic,
// label, big, sup/sub, "was coloured", link, example) map onto the theme —
// the publisher's own colours never reach the screen, which is what keeps
// the twelve dictionaries readable on both the dark and the paper palette.
// Nesting from the source (senses under senses) becomes an indent with a
// hairline; Collins' grey grammar boxes become tinted cards.
//
// `highlight` marks the phrasal-verb heading the lookup found; that
// paragraph is measured against `measureIn` (the card's body root) and its
// offset handed to `onHighlightLayout` so the card can scroll to it.
//
// Long entries (run, put, go — hundreds of paragraphs) render a first slice
// and a "whole entry" button; the slice always reaches the highlight.

const BASE_FONT = 15;
const INITIAL_PARAGRAPHS = 120;
const TAIL_AFTER_HIGHLIGHT = 40;

const runTextStyle = (run, para, colors, base) => {
    let size = base * (run.size || 1);
    const s = { color: colors.textPrimary };
    if (para.headword && (run.b || run.big)) {
        size = Math.max(size, base * 1.35);
        s.fontWeight = '700';
        s.letterSpacing = -0.2;
    } else if (para.headword) {
        s.color = colors.textSecondary;
    }
    if (run.b) s.fontWeight = '700';
    if (run.i) {
        s.fontStyle = 'italic';
        if (!run.b && !para.headword) s.color = colors.textSecondary;
    }
    if (run.u) s.textDecorationLine = 'underline';
    if (run.big && !para.headword) size *= 1.2;
    if (run.small) {
        size *= 0.78;
        s.fontWeight = '700';
        s.color = colors.warning;
        s.letterSpacing = 0.4;
    }
    if (run.sup || run.sub) {
        size *= 0.7;
        s.color = colors.textMuted;
    }
    if (run.color) s.color = colors.accent;
    if (run.example) {
        s.fontStyle = 'italic';
        s.color = colors.textSecondary;
        s.backgroundColor = withAlpha(colors.success, 0.12);
    }
    if (run.link) {
        s.color = colors.accent;
        s.textDecorationLine = 'underline';
    }
    s.fontSize = Math.round(size * 10) / 10;
    return s;
};

// Splits `text` into [before, inside, after] against a character range.
const splitRange = (text, offset, start, end) => {
    const a = Math.max(0, start - offset);
    const b = Math.min(text.length, end - offset);
    if (b <= 0 || a >= text.length || a >= b) return null;
    return [text.slice(0, a), text.slice(a, b), text.slice(b)];
};

const Paragraph = memo(({ para, base, highlightRange, onLink, isTarget, onTargetRef }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const ref = useRef(null);
    useEffect(() => { if (isTarget) onTargetRef?.(ref); }, [isTarget, onTargetRef]);

    if (para.kind === 'hr') return <View style={st.rule} />;

    let maxSize = base;
    const spans = [];
    let offset = 0;
    para.runs.forEach((run, i) => {
        const style = runTextStyle(run, para, colors, base);
        if (style.fontSize > maxSize) maxSize = style.fontSize;
        const press = run.link && onLink ? () => onLink(run.link) : undefined;
        const parts = highlightRange ? splitRange(run.text, offset, highlightRange.start, highlightRange.end) : null;
        if (parts) {
            if (parts[0]) spans.push(<Text key={`${i}a`} style={style} onPress={press}>{parts[0]}</Text>);
            spans.push(<Text key={`${i}b`} style={[style, st.highlight]} onPress={press}>{parts[1]}</Text>);
            if (parts[2]) spans.push(<Text key={`${i}c`} style={style} onPress={press}>{parts[2]}</Text>);
        } else {
            spans.push(<Text key={i} style={style} onPress={press}>{run.text}</Text>);
        }
        offset += run.text.length;
    });

    const indent = para.indent || 0;
    return (
        <View
            ref={ref}
            collapsable={false}
            style={[
                st.para,
                indent > 0 && { marginLeft: (indent - 1) * 10, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: colors.hairlineStrong },
                para.kind === 'box' && st.box,
                para.headword && st.headword,
                isTarget && st.target,
            ]}
        >
            <Text style={{ lineHeight: Math.round(maxSize * 1.45) }}>{spans}</Text>
        </View>
    );
});

const DictionaryEntry = ({ flats, highlight, onLink, measureIn, onHighlightLayout, fontSize = BASE_FONT }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const [expanded, setExpanded] = useState(false);

    // Flatten bodies into one list, remembering where each record begins so
    // homographs get a divider between them.
    const { items, total, targetIndex } = useMemo(() => {
        const list = [];
        let target = -1;
        (flats || []).forEach((flat, b) => {
            flat.paragraphs.forEach((para, p) => {
                if (highlight && highlight.bodyIndex === b && highlight.paraIndex === p) target = list.length;
                list.push({ para, body: b, first: p === 0 });
            });
        });
        return { items: list, total: list.length, targetIndex: target };
    }, [flats, highlight]);

    useEffect(() => { setExpanded(false); }, [flats]);

    const limit = expanded ? total : Math.max(INITIAL_PARAGRAPHS, targetIndex >= 0 ? targetIndex + TAIL_AFTER_HIGHLIGHT : 0);
    const shown = items.slice(0, limit);
    const hidden = total - shown.length;

    // Report where the highlighted paragraph sits, relative to the card body.
    const measuredRef = useRef(null);
    const onTargetRef = useCallback((ref) => {
        const node = ref?.current;
        const host = measureIn?.current;
        if (!node || !host || !onHighlightLayout) return;
        if (measuredRef.current === node) return;
        measuredRef.current = node;
        // Layout has to settle before measuring; a frame later is enough.
        requestAnimationFrame(() => {
            try {
                node.measureLayout(host, (_x, y) => onHighlightLayout(y), () => {});
            } catch (_) {}
        });
    }, [measureIn, onHighlightLayout]);
    useEffect(() => { measuredRef.current = null; }, [highlight, flats]);

    return (
        <View>
            {shown.map((it, i) => (
                <React.Fragment key={i}>
                    {it.first && it.body > 0 && <View style={st.recordDivider} />}
                    <Paragraph
                        para={it.para}
                        base={fontSize}
                        highlightRange={i === targetIndex ? highlight : null}
                        isTarget={i === targetIndex}
                        onTargetRef={onTargetRef}
                        onLink={onLink}
                    />
                </React.Fragment>
            ))}
            {hidden > 0 && (
                <TouchableOpacity style={st.moreBtn} onPress={() => setExpanded(true)} activeOpacity={0.75} accessibilityRole='button'>
                    <Text style={st.moreText}>Show the whole entry · {hidden} more {hidden === 1 ? 'paragraph' : 'paragraphs'}</Text>
                </TouchableOpacity>
            )}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    para: { marginVertical: 3 },
    headword: { marginTop: 2, marginBottom: 6 },
    box: {
        marginVertical: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: radii.m,
        backgroundColor: withAlpha(colors.accent, 0.08),
        borderLeftWidth: 3,
        borderLeftColor: withAlpha(colors.accent, 0.55),
    },
    target: {
        marginVertical: 6,
        paddingVertical: 6,
        paddingRight: 8,
        borderRadius: 8,
        backgroundColor: withAlpha(colors.transcriptHighlight || colors.accent, colors.transcriptHighlightAlpha > 0 ? 0.18 : 0.10),
    },
    highlight: {
        backgroundColor: withAlpha(colors.transcriptHighlight || colors.accent, colors.transcriptHighlightAlpha > 0 ? 0.55 : 0.35),
        borderRadius: 3,
    },
    rule: { height: 0.5, backgroundColor: colors.hairline, marginVertical: 8 },
    recordDivider: { height: 0.5, backgroundColor: colors.hairlineStrong, marginTop: 14, marginBottom: 12 },
    moreBtn: {
        alignSelf: 'flex-start',
        marginTop: 10,
        marginBottom: 4,
        paddingVertical: 9,
        paddingHorizontal: 14,
        borderRadius: radii.pill,
        backgroundColor: colors.hairlineFaint,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    moreText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
});

export default DictionaryEntry;
