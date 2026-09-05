/**
 * ShowNotes — an episode's show notes laid out to be read: paragraphs with
 * space between them, headings set in the primary colour, bullet and
 * numbered lists, bold / italic kept, links (and bare URLs) tappable in the
 * accent colour. Long notes open folded to about a screen of text with a
 * "Show more" line; the podcast's own <br>-separated timestamps and chapter
 * lists keep their line breaks.
 *
 * The structure comes from services/showNotes.js (showNotesToBlocks); this
 * component only draws it.
 *
 *   <ShowNotes html={episode.description} />
 *   <ShowNotes html={book.description} collapsible={false} />
 */

import React, { useMemo, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { blockText, showNotesToBlocks } from '../services/showNotes';
import { type, useStyles } from '../theme';

// Roughly a phone screen of body text before the fold.
const DEFAULT_COLLAPSE_CHARS = 700;
// A single very long first paragraph is clamped by lines instead.
const COLLAPSED_MAX_LINES = 10;

const openLink = (url) => { Linking.openURL(url).catch(() => {}); };

/** Blocks to show while folded, and whether anything was left out. */
const fold = (blocks, budget) => {
    const visible = [];
    let used = 0;
    for (const b of blocks) {
        if (visible.length && used >= budget) break;
        visible.push(b);
        used += blockText(b).length + 1;
    }
    const clampFirst = visible.length === 1 && used > budget;
    return { visible, truncated: visible.length < blocks.length || clampFirst, clampFirst };
};

const Runs = ({ runs, styles }) => runs.map((r, i) => {
    const runStyle = [
        r.bold && styles.bold,
        r.italic && styles.italic,
        r.link && styles.link,
    ];
    return (
        <Text
            key={i}
            style={runStyle}
            onPress={r.link ? () => openLink(r.link) : undefined}
            accessibilityRole={r.link ? 'link' : undefined}
        >
            {r.text}
        </Text>
    );
});

const ShowNotes = ({
    html,
    emptyText = 'No description available.',
    collapsible = true,
    collapseChars = DEFAULT_COLLAPSE_CHARS,
    style,
}) => {
    const styles = useStyles(makeStyles);
    const [expanded, setExpanded] = useState(false);
    const blocks = useMemo(() => showNotesToBlocks(html), [html]);
    // canFold: the notes are long enough to have a fold at all — the toggle
    // shows in both states so "Show less" is there after expanding.
    const { visible, clampFirst, canFold } = useMemo(() => {
        const f = collapsible ? fold(blocks, collapseChars) : null;
        const canFold = !!f?.truncated;
        if (f && !expanded) return { visible: f.visible, clampFirst: f.clampFirst, canFold };
        return { visible: blocks, clampFirst: false, canFold };
    }, [blocks, collapsible, expanded, collapseChars]);

    if (!blocks.length) {
        return emptyText ? <Text style={[styles.body, style]}>{emptyText}</Text> : null;
    }

    return (
        <View style={[styles.wrap, style]}>
            {visible.map((b, i) => {
                const indent = b.depth > 0 ? { marginLeft: b.depth * 16 } : null;
                const clamp = clampFirst && i === 0 ? COLLAPSED_MAX_LINES : undefined;
                if (b.kind === 'li') {
                    return (
                        <View key={i} style={[styles.item, indent]}>
                            <Text style={[styles.body, styles.marker]}>{b.ordinal > 0 ? `${b.ordinal}.` : '•'}</Text>
                            <Text style={[styles.body, styles.itemText]} numberOfLines={clamp}>
                                <Runs runs={b.runs} styles={styles} />
                            </Text>
                        </View>
                    );
                }
                return (
                    <Text
                        key={i}
                        style={[styles.body, b.kind === 'h' && styles.heading, indent]}
                        numberOfLines={clamp}
                    >
                        <Runs runs={b.runs} styles={styles} />
                    </Text>
                );
            })}
            {canFold && (
                <Text
                    style={styles.more}
                    onPress={() => setExpanded(v => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={expanded ? 'Show less of the show notes' : 'Show more of the show notes'}
                >
                    {expanded ? 'Show less' : 'Show more'}
                </Text>
            )}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    wrap: { gap: 9 },
    body: { ...type.body, fontSize: 14, lineHeight: 21, color: colors.textSecondary },
    heading: { ...type.bodyStrong, fontSize: 14, lineHeight: 21, color: colors.textPrimary, marginTop: 3 },
    bold: { fontWeight: '600', color: colors.textPrimary },
    italic: { fontStyle: 'italic' },
    link: { color: colors.accent, textDecorationLine: 'underline' },
    item: { flexDirection: 'row', alignItems: 'flex-start' },
    marker: { minWidth: 20, paddingRight: 4, color: colors.textMuted },
    itemText: { flex: 1 },
    more: { ...type.bodyStrong, color: colors.accent, marginTop: 1 },
});

export default React.memo(ShowNotes);
