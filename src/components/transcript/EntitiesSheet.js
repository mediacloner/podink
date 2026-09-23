/**
 * What this episode names, as a list: everything the entity pass found and
 * a catalogue could confirm, grouped by kind, each row opening its own card
 * (EntitySheet). The pass itself runs from here — one reading of the
 * transcript, then a lookup per thing (services/entityIndex.js).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, useStyles, useTheme, withAlpha } from '../../theme';
import SheetModal, { SheetIconButton } from './SheetModal';
import { getEpisodeBooks, getEpisodeEntities, getEpisodePhrases } from '../../database/queries';
import { ENTITY_TYPES, TYPE_ICON, TYPE_LABEL, indexEpisodeEntities, isIndexingEntities } from '../../services/entityIndex';
import { formatClock } from '../../services/sentenceBoundary';
import { imageSourceFor } from '../../api/wikipedia';

const PLURAL = { person: 'People', place: 'Places', book: 'Books', film: 'Films', tv: 'Television', podcast: 'Podcasts', album: 'Records' };

const EntitiesSheet = ({ visible, onClose, episode, onOpenEntity, onOpenIdiom, onOpenSettings }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const epId = episode?.id;

    const [rows, setRows] = useState([]);
    const [books, setBooks] = useState([]);       // EpisodeBooks — the title scan's route
    const [idioms, setIdioms] = useState([]);     // EpisodePhrases of kind idiom, from the same pass
    const [running, setRunning] = useState(false);
    const [percent, setPercent] = useState(0);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        if (!epId) return;
        try { setRows(await getEpisodeEntities(epId)); } catch (_) { setRows([]); }
        try { setBooks(await getEpisodeBooks(epId)); } catch (_) { setBooks([]); }
        try { setIdioms((await getEpisodePhrases(epId)).filter(p => p.kind === 'idiom')); } catch (_) { setIdioms([]); }
    }, [epId]);

    useEffect(() => {
        if (!visible) return;
        setError(null);
        setRunning(isIndexingEntities(epId));
        load();
    }, [visible, epId, load]);

    const run = useCallback(async () => {
        if (!epId || running) return;
        setError(null);
        setRunning(true);
        setPercent(0);
        try {
            await indexEpisodeEntities(epId, { onProgress: setPercent });
            await load();
        } catch (e) {
            setError({ message: e?.message || 'The scan failed.', kind: e?.kind });
        } finally {
            setRunning(false);
        }
    }, [epId, running, load]);

    // Books come by two routes — the title scan (EpisodeBooks) and the entity
    // pass — and the list badge counts the union of the two, once per title.
    // The Books group here is that same union, so the badge, this list and
    // the bold titles in the text all say the same number (user: "in list of
    // podcast identify the book and put 2 meanwhile inside appear 3"). A
    // scanned book that the pass did not name is shown in the entity's shape.
    const groups = useMemo(() => {
        const named = new Set(rows.filter(r => r.type === 'book').map(r => String(r.canonical).toLowerCase()));
        const scannedOnly = (books || [])
            .filter(b => b.first_ms != null && !named.has(String(b.title).toLowerCase()))
            .map(b => ({
                id: `book-${b.id}`, type: 'book', canonical: b.title, surface: b.title, hint: '', context: '',
                first_ms: b.first_ms, source: b.source || 'openlibrary',
                source_url: b.goodreads_url || b.openlibrary_url || null, image_url: b.cover_url || null,
                subtitle: b.author ? `by ${b.author}` : '',
                facts: [b.year, b.pages ? `${b.pages} pages` : ''].filter(Boolean).join(' \u00b7 '),
                blurb: b.description || '', rating: b.rating, ratings_count: b.ratings_count,
            }));
        return ENTITY_TYPES
            .map(type => ({
                type,
                items: type === 'book'
                    ? [...rows.filter(r => r.type === 'book'), ...scannedOnly].sort((a, b) => (a.first_ms ?? 0) - (b.first_ms ?? 0))
                    : rows.filter(r => r.type === type),
            }))
            .filter(g => g.items.length);
    }, [rows, books]);

    const header = (
        <View style={st.labelRow}>
            <Icon name='tag' size={13} color={colors.textMuted} />
            <Text style={st.label}>What this episode names</Text>
            <View style={{ flex: 1 }} />
            {(rows.length > 0 || episode?.entities_indexed_at) && !running && <SheetIconButton icon='refresh-cw' label='Look again' onPress={run} />}
        </View>
    );

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} maxHeight='88%'>
            {!!error && (
                <View style={st.errorBox}>
                    <Icon name='alert-circle' size={14} color={colors.danger} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1, gap: 8 }}>
                        <Text style={st.errorText}>{error.message}</Text>
                        {(error.kind === 'nokey' || error.kind === 'auth') && !!onOpenSettings && (
                            <TouchableOpacity onPress={onOpenSettings} accessibilityRole='button'>
                                <Text style={st.link}>Open Settings</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            )}

            {running && (
                <View style={st.runningRow}>
                    <ActivityIndicator size='small' color={colors.accent} />
                    <Text style={st.runningText}>Reading the transcript and looking things up… {percent}%</Text>
                </View>
            )}

            {!rows.length && !episode?.entities_indexed_at && !running && (
                <View style={{ gap: 14 }}>
                    <Text style={st.body}>
                        The people, places, books, films, programmes and records this episode talks about — each looked up where that kind of thing is catalogued, so a misheard name still finds the right one — and the idioms and phrasal verbs its speakers use. About a cent for an hour of audio.
                    </Text>
                    <TouchableOpacity style={st.primaryBtn} onPress={run} activeOpacity={0.85} accessibilityRole='button'>
                        <Icon name='search' size={16} color={colors.onAccent} />
                        <Text style={st.primaryText}>Find what it names</Text>
                    </TouchableOpacity>
                </View>
            )}

            {groups.map(group => (
                <View key={group.type} style={{ marginBottom: 18 }}>
                    <Text style={st.groupLabel}>{PLURAL[group.type] || TYPE_LABEL[group.type]}</Text>
                    <View style={st.list}>
                        {group.items.map((item, i) => (
                            <TouchableOpacity
                                key={item.id}
                                style={[st.row, i > 0 && st.rowBorder]}
                                onPress={() => onOpenEntity?.({ entity: item, startMs: item.first_ms })}
                                activeOpacity={0.7}
                                accessibilityRole='button'
                                accessibilityLabel={`${item.canonical}, ${TYPE_LABEL[item.type]}`}
                            >
                                <View style={[st.thumb, st.thumbEmpty]}>
                                    <Icon name={TYPE_ICON[item.type] || 'tag'} size={14} color={colors.textMuted} />
                                    {!!item.image_url && (
                                        <Image
                                            source={imageSourceFor(item.image_url)}
                                            style={[st.thumbImage, item.type === 'person' && st.thumbFace]}
                                            resizeMode='cover'
                                            accessibilityIgnoresInvertColors
                                        />
                                    )}
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={st.name} numberOfLines={1}>{item.canonical}</Text>
                                    <Text style={st.meta} numberOfLines={1}>
                                        {[item.subtitle, item.facts].filter(Boolean).join(' · ')
                                            || (item.source ? '' : 'not in any catalogue')}
                                    </Text>
                                </View>
                                {item.first_ms != null && <Text style={st.time}>{formatClock(item.first_ms)}</Text>}
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            ))}

            {/* The idioms the same reading found, each opening its own card
                (user: "the list of idioms appear in list of people, films,
                etc"). The phrasal verbs stay in the text only — there are
                dozens an hour, and the underline is where they are wanted. */}
            {idioms.length > 0 && (
                <View style={{ marginBottom: 18 }}>
                    <Text style={st.groupLabel}>Idioms</Text>
                    <View style={st.list}>
                        {idioms.map((item, i) => (
                            <TouchableOpacity
                                key={`idiom-${item.id}`}
                                style={[st.row, i > 0 && st.rowBorder]}
                                onPress={() => onOpenIdiom?.({ phrase: item, startMs: item.first_ms, contextText: item.context || '' })}
                                activeOpacity={0.7}
                                accessibilityRole='button'
                                accessibilityLabel={`${item.base}, idiom`}
                            >
                                <View style={[st.thumb, st.thumbEmpty, st.thumbIdiom]}>
                                    <Icon name='message-circle' size={14} color={colors.textMuted} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={st.name} numberOfLines={1}>{item.base}</Text>
                                    <Text style={st.meta} numberOfLines={1}>{item.meaning}</Text>
                                </View>
                                {item.first_ms != null && <Text style={st.time}>{formatClock(item.first_ms)}</Text>}
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            )}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
    label: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    body: { fontSize: 15, lineHeight: 22, color: colors.textSecondary },

    runningRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, marginBottom: 12 },
    runningText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.textSecondary },

    groupLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textMuted, marginBottom: 8 },
    list: { borderRadius: radii.m, borderWidth: 0.5, borderColor: colors.hairline, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 12 },
    rowBorder: { borderTopWidth: 0.5, borderTopColor: colors.hairline },
    thumb: { width: 38, height: 38, borderRadius: 6, backgroundColor: colors.hairlineFaint, overflow: 'hidden' },
    thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
    thumbIdiom: { backgroundColor: withAlpha(colors.phraseBand, colors.phraseBandAlpha) },
    thumbImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 6 },
    // A portrait is taller than the box, so the box shows its top — a face
    // sits in the upper part of nearly every painting, bust and photograph.
    thumbFace: { bottom: undefined, height: 62 },
    name: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
    meta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },

    primaryBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingVertical: 13, paddingHorizontal: 18, borderRadius: radii.pill, backgroundColor: colors.accent,
    },
    primaryText: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },
    link: { color: colors.accent, fontSize: 14, fontWeight: '700' },

    errorBox: {
        flexDirection: 'row', gap: 10, padding: 12, marginBottom: 14, borderRadius: radii.m,
        backgroundColor: withAlpha(colors.danger, 0.1), borderWidth: 0.5, borderColor: withAlpha(colors.danger, 0.35),
    },
    errorText: { fontSize: 14, lineHeight: 20, color: colors.textPrimary },
});

export default EntitiesSheet;
