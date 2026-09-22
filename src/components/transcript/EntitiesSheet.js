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
import { getEpisodeEntities } from '../../database/queries';
import { ENTITY_TYPES, TYPE_ICON, TYPE_LABEL, indexEpisodeEntities, isIndexingEntities } from '../../services/entityIndex';
import { formatClock } from '../../services/sentenceBoundary';

const PLURAL = { person: 'People', place: 'Places', book: 'Books', film: 'Films', tv: 'Television', album: 'Records' };

const EntitiesSheet = ({ visible, onClose, episode, onOpenEntity, onOpenSettings }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const epId = episode?.id;

    const [rows, setRows] = useState([]);
    const [running, setRunning] = useState(false);
    const [percent, setPercent] = useState(0);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        if (!epId) return;
        try { setRows(await getEpisodeEntities(epId)); } catch (_) { setRows([]); }
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

    const groups = useMemo(() => ENTITY_TYPES
        .map(type => ({ type, items: rows.filter(r => r.type === type) }))
        .filter(g => g.items.length), [rows]);

    const header = (
        <View style={st.labelRow}>
            <Icon name='tag' size={13} color={colors.textMuted} />
            <Text style={st.label}>What this episode names</Text>
            <View style={{ flex: 1 }} />
            {rows.length > 0 && !running && <SheetIconButton icon='refresh-cw' label='Look again' onPress={run} />}
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

            {!rows.length && !running && (
                <View style={{ gap: 14 }}>
                    <Text style={st.body}>
                        The people, places, books, films, programmes and records this episode talks about — each looked up where that kind of thing is catalogued, so a misheard name still finds the right one. About a cent for an hour of audio.
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
                                {item.image_url ? (
                                    <Image source={{ uri: item.image_url }} style={st.thumb} accessibilityIgnoresInvertColors />
                                ) : (
                                    <View style={[st.thumb, st.thumbEmpty]}>
                                        <Icon name={TYPE_ICON[item.type] || 'tag'} size={14} color={colors.textMuted} />
                                    </View>
                                )}
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
    thumb: { width: 38, height: 38, borderRadius: 6, backgroundColor: colors.hairlineFaint },
    thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
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
