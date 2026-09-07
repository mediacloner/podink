/**
 * BookSheet — the card for a book the transcript mentions: cover, title,
 * author, rating, description, and the way to Open Library / Goodreads.
 * Opens from a bold title in the transcript (TranscriptHighlighter). Laid
 * out like the word card's Wikipedia block so the two read as one family.
 *
 * `data` is { book, startMs } or null; `book` is an EpisodeBooks row.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { useTheme, useStyles, radii, withAlpha } from '../../theme';
import SheetModal, { SheetIconButton } from './SheetModal';
import { shareText } from './share';
import { openLibrarySearchUrl } from '../../api/openLibrary';
import { goodreadsSearchUrl } from '../../api/goodreads';

const DESCRIPTION_FOLD_CHARS = 420;

const heardForms = (book) => {
    let heard = book?.heard_as ?? [];
    if (typeof heard === 'string') { try { heard = JSON.parse(heard); } catch (_) { heard = []; } }
    if (!Array.isArray(heard)) return [];
    const title = (book?.title || '').toLowerCase();
    return heard.filter(h => h && h.toLowerCase() !== title);
};

const formatCount = (n) => {
    if (!n) return '';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const BookSheet = ({ data, onClose, onReplay }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const visible = !!data;
    const book = data?.book || null;
    const [expanded, setExpanded] = useState(false);
    useEffect(() => { if (visible) setExpanded(false); }, [visible, book?.id]);

    const heard = useMemo(() => heardForms(book), [book]);
    const rating = book?.rating != null ? Number(book.rating) : null;
    const description = (book?.description || '').trim();
    const folded = !expanded && description.length > DESCRIPTION_FOLD_CHARS;
    const shownDescription = useMemo(() => {
        if (!folded) return description;
        const head = description.slice(0, DESCRIPTION_FOLD_CHARS);
        const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'), head.lastIndexOf(', '));
        return (cut > DESCRIPTION_FOLD_CHARS * 0.5 ? head.slice(0, cut + 1) : head).trim() + '…';
    }, [description, folded]);

    const openUrl = useCallback((url) => { if (url) Linking.openURL(url).catch(() => {}); }, []);
    const openLibraryUrl = book ? (book.openlibrary_url || openLibrarySearchUrl(book.title)) : null;
    const goodreadsUrl = book ? (book.goodreads_url || goodreadsSearchUrl(book.author ? `${book.title} ${book.author}` : book.title)) : null;
    const onShare = useCallback(() => {
        if (!book) return;
        const line = book.author ? `${book.title} by ${book.author}` : book.title;
        shareText(`${line}\n${book.goodreads_url || book.openlibrary_url || ''}`.trim(), 'Share book');
    }, [book]);
    const onReplayPress = useCallback(() => {
        if (data?.startMs != null && onReplay) onReplay(data.startMs);
    }, [data, onReplay]);

    const facts = [];
    if (book?.year) facts.push(String(book.year));
    if (book?.pages) facts.push(`${book.pages} pages`);

    const header = book ? (
        <>
            <View style={st.labelRow}>
                <Icon name='book' size={13} color={colors.textMuted} />
                <Text style={st.label}>Book</Text>
                <View style={{ flex: 1 }} />
                <SheetIconButton icon='share-2' label='Share book' onPress={onShare} />
            </View>
            <Text style={st.title} numberOfLines={3}>{book.title}</Text>
            {!!book.author && <Text style={st.author}>by {book.author}</Text>}
        </>
    ) : null;

    const footer = book ? (
        <View style={st.actions}>
            <TouchableOpacity
                style={[st.actionBtn, st.actionBtnGhost]}
                onPress={() => openUrl(openLibraryUrl)}
                activeOpacity={0.8}
                accessibilityRole='link'
                accessibilityLabel='Open on Open Library'
            >
                <Icon name='external-link' size={14} color={colors.accent} />
                <Text style={[st.actionText, { color: colors.accent }]} numberOfLines={1}>Open Library</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={[st.actionBtn, st.actionBtnGhost]}
                onPress={() => openUrl(goodreadsUrl)}
                activeOpacity={0.8}
                accessibilityRole='link'
                accessibilityLabel='Open on Goodreads'
            >
                <Icon name='external-link' size={14} color={colors.accent} />
                <Text style={[st.actionText, { color: colors.accent }]} numberOfLines={1}>Goodreads</Text>
            </TouchableOpacity>
            {data?.startMs != null && !!onReplay && (
                <TouchableOpacity
                    style={[st.actionBtn, st.replayBtn]}
                    onPress={onReplayPress}
                    activeOpacity={0.8}
                    accessibilityRole='button'
                    accessibilityLabel='Replay from this mention'
                >
                    <Icon name='rotate-ccw' size={14} color={colors.onAccent} />
                    <Text style={[st.actionText, { color: colors.onAccent }]}>Replay</Text>
                </TouchableOpacity>
            )}
        </View>
    ) : null;

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} footer={footer} maxHeight='88%'>
            {!!book && (
                <View>
                    <View style={st.head}>
                        {book.cover_url ? (
                            <Image source={{ uri: book.cover_url }} style={st.cover} accessibilityIgnoresInvertColors />
                        ) : (
                            <View style={[st.cover, st.coverEmpty]}>
                                <Icon name='book-open' size={22} color={colors.textMuted} />
                            </View>
                        )}
                        <View style={{ flex: 1, gap: 6 }}>
                            {rating != null ? (
                                <View style={st.ratingRow}>
                                    <Icon name='star' size={15} color={colors.warning} />
                                    <Text style={st.rating}>{rating.toFixed(2)}</Text>
                                    {!!book.ratings_count && (
                                        <Text style={st.ratingCount}>· {formatCount(book.ratings_count)} ratings</Text>
                                    )}
                                </View>
                            ) : (
                                <Text style={st.ratingCount}>No rating yet</Text>
                            )}
                            {facts.length > 0 && <Text style={st.facts}>{facts.join(' · ')}</Text>}
                            {heard.length > 0 && (
                                <Text style={st.heard} numberOfLines={2}>
                                    Heard as “{heard.slice(0, 2).join('”, “')}”
                                </Text>
                            )}
                            <Text style={st.source}>
                                {book.source === 'goodreads' ? 'Found on Goodreads' : 'Found on Open Library'}
                            </Text>
                        </View>
                    </View>

                    {description ? (
                        <>
                            <View style={st.sectionDivider} />
                            {shownDescription.split(/\n+/).map((para, i) => (
                                <Text key={i} style={st.description}>{para.trim()}</Text>
                            ))}
                            {folded && (
                                <TouchableOpacity style={st.inlineLink} onPress={() => setExpanded(true)} activeOpacity={0.7} accessibilityRole='button'>
                                    <Text style={st.inlineLinkText}>Show more</Text>
                                </TouchableOpacity>
                            )}
                        </>
                    ) : (
                        <>
                            <View style={st.sectionDivider} />
                            <Text style={st.softNote}>No description available. Open Library and Goodreads have more about this book.</Text>
                        </>
                    )}
                </View>
            )}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    label: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    title: { color: colors.textPrimary, fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.4 },
    author: { color: colors.textSecondary, fontSize: 16, lineHeight: 22, fontStyle: 'italic', marginTop: 4, marginBottom: 12 },

    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginBottom: 6 },
    cover: { width: 84, height: 126, borderRadius: 10, backgroundColor: colors.hairlineFaint },
    coverEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: colors.hairline },
    ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
    rating: { color: colors.textPrimary, fontSize: 17, fontWeight: '700' },
    ratingCount: { color: colors.textSecondary, fontSize: 14 },
    facts: { color: colors.textSecondary, fontSize: 14 },
    heard: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
    source: { color: colors.textFaint, fontSize: 12, marginTop: 2 },

    sectionDivider: { height: 0.5, backgroundColor: colors.hairline, marginVertical: 14 },
    description: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
    softNote: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
    inlineLink: { alignSelf: 'flex-start', marginTop: 2, marginBottom: 6 },
    inlineLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },

    actions: { flexDirection: 'row', gap: 10, paddingTop: 14 },
    actionBtn: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        paddingVertical: 13,
        paddingHorizontal: 10,
        borderRadius: radii.pill,
    },
    actionBtnGhost: { backgroundColor: colors.hairlineFaint, borderWidth: 0.5, borderColor: colors.hairline },
    replayBtn: { backgroundColor: colors.accent },
    actionText: { fontSize: 14, fontWeight: '700' },
});

export default BookSheet;
