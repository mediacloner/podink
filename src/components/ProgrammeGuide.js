import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { formatClock, minutesLeft } from '../services/radioSchedule';
import { radii, type, useStyles, useTheme, withAlpha } from '../theme';

/**
 * What a station is broadcasting: the programme on air (title, description,
 * time span with a progress bar) and the next two. Used by the station screen
 * and by the Player when a station plays without a transcript.
 *
 *   guide     radioSchedule.fetchGuide() result, or null while loading
 *             (its optional `note` is printed under the list)
 *   icyTitle  the stream's own "now playing" text, for stations without a guide
 *   compact   tighter spacing (inside the Player)
 */
const ProgrammeGuide = ({ guide, icyTitle, compact = false, accent }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const tint = accent || colors.accent;
    // Re-render once a minute so "x min left" and the bar stay honest.
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick(n => n + 1), 30 * 1000);
        return () => clearInterval(t);
    }, []);

    const now = guide?.now || (icyTitle ? { title: icyTitle, subtitle: '', description: '', start: 0, end: 0 } : null);
    const next = guide?.next || [];
    const nowMs = Date.now();
    const progress = now && now.start && now.end > now.start
        ? Math.min(1, Math.max(0, (nowMs - now.start) / (now.end - now.start)))
        : null;

    return (
        <View style={[styles.root, compact && styles.rootCompact]}>
            <Text style={styles.sectionLabel}>ON AIR NOW</Text>
            {now ? (
                <View style={[styles.nowCard, { borderColor: withAlpha(tint, 0.35) }]}>
                    <View style={styles.nowHead}>
                        <View style={[styles.liveDot, { backgroundColor: colors.danger }]} />
                        <Text style={[styles.nowTime, { color: tint }]}>
                            {now.start ? `${formatClock(now.start)} – ${formatClock(now.end)}` : 'Now playing'}
                        </Text>
                        {now.end > nowMs && now.start > 0 && (
                            <Text style={styles.nowLeft}>{minutesLeft(now, nowMs)} min left</Text>
                        )}
                    </View>
                    <Text style={styles.nowTitle}>{now.title}</Text>
                    {!!now.subtitle && <Text style={styles.nowSubtitle}>{now.subtitle}</Text>}
                    {!!now.description && (
                        <Text style={styles.nowDesc} numberOfLines={compact ? 5 : 8}>{now.description}</Text>
                    )}
                    {progress != null && (
                        <View style={styles.bar}>
                            <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%`, backgroundColor: tint }]} />
                        </View>
                    )}
                </View>
            ) : (
                <View style={styles.emptyCard}>
                    <Icon name={guide ? 'info' : 'clock'} size={16} color={colors.textMuted} />
                    <Text style={styles.emptyText}>
                        {!guide
                            ? 'Loading the programme guide…'
                            : guide.source === 'none'
                                ? 'This station publishes no programme guide the app can read.'
                                : guide.source === 'error'
                                    ? 'The programme guide could not be reached.'
                                    : 'Nothing listed right now.'}
                    </Text>
                </View>
            )}

            {next.length > 0 && (
                <>
                    <Text style={[styles.sectionLabel, styles.nextLabel]}>COMING UP</Text>
                    {next.map((p, i) => (
                        <View key={`${p.start}-${i}`} style={[styles.nextRow, i > 0 && styles.nextRowBorder]}>
                            <View style={styles.nextWhen}>
                                <Text style={styles.nextTime}>{formatClock(p.start)}</Text>
                                {p.end > p.start && (
                                    <Text style={styles.nextLength}>{Math.round((p.end - p.start) / 60000)} min</Text>
                                )}
                            </View>
                            <View style={styles.nextBody}>
                                <Text style={styles.nextTitle} numberOfLines={2}>{p.title}</Text>
                                {!!p.subtitle && <Text style={styles.nextSubtitle} numberOfLines={1}>{p.subtitle}</Text>}
                                {!!p.description && (
                                    <Text style={styles.nextDesc} numberOfLines={compact ? 3 : 4}>{p.description}</Text>
                                )}
                            </View>
                        </View>
                    ))}
                </>
            )}
            {!!guide?.note && <Text style={styles.note}>{guide.note}</Text>}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    root: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
    rootCompact: { paddingHorizontal: 24 },
    sectionLabel: { ...type.caption, color: colors.textMuted, marginBottom: 8 },
    nextLabel: { marginTop: 22 },
    nowCard: {
        backgroundColor: colors.surfaceElevated,
        borderRadius: radii.m,
        borderWidth: 0.5,
        padding: 16,
        gap: 6,
    },
    nowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
    liveDot: { width: 7, height: 7, borderRadius: 3.5 },
    nowTime: { ...type.label, fontVariant: ['tabular-nums'] },
    nowLeft: { ...type.label, color: colors.textMuted, marginLeft: 'auto' },
    nowTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, color: colors.textPrimary, lineHeight: 26 },
    nowSubtitle: { ...type.bodyStrong, fontSize: 14, color: colors.textSecondary },
    nowDesc: { fontSize: 14, lineHeight: 21, color: colors.textSecondary, marginTop: 2 },
    bar: { height: 3, borderRadius: 2, backgroundColor: colors.hairline, marginTop: 10, overflow: 'hidden' },
    barFill: { height: 3, borderRadius: 2 },
    emptyCard: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        backgroundColor: colors.surface, borderRadius: radii.m, borderWidth: 0.5, borderColor: colors.hairline,
        padding: 14,
    },
    emptyText: { ...type.body, color: colors.textSecondary, flex: 1, lineHeight: 18 },
    nextRow: { flexDirection: 'row', gap: 14, paddingVertical: 10 },
    nextRowBorder: { borderTopWidth: 0.5, borderTopColor: colors.hairline },
    nextWhen: { width: 52, paddingTop: 1, gap: 2 },
    nextTime: { ...type.bodyStrong, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    nextLength: { ...type.caption, color: colors.textMuted, letterSpacing: 0 },
    nextBody: { flex: 1, gap: 3 },
    nextTitle: { ...type.title, color: colors.textPrimary },
    nextSubtitle: { ...type.bodyStrong, color: colors.textSecondary },
    nextDesc: { ...type.body, fontSize: 13.5, color: colors.textMuted, lineHeight: 19 },
    // Where a guide comes from when that matters (a fixed weekly line-up).
    note: { ...type.caption, letterSpacing: 0, textTransform: 'none', color: colors.textFaint, lineHeight: 16, marginTop: 14 },
});

export default ProgrammeGuide;
