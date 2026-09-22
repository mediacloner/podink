import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import SegmentedControl from '../components/SegmentedControl';
import EmptyState from '../components/EmptyState';
import {
    bucketed, finishedCount, formatMoney, formatSpan, lastDays, lastMonths, listeningBySource,
    listeningTotals, loadStats, serviceLabel, spendByService,
} from '../services/statsService';
import { radii, type, useStyles, useTheme, withAlpha } from '../theme';

// Statistics (5.1.0, Settings → Learning → Statistics): how much was really
// listened to, and what the paid passes cost to make it readable.
//
// "Really" is the point of the page. The library knows where a listener got
// to in an episode; it does not know an hour replayed twice, an advert
// skipped, or a download started and abandoned. services/statsService.js
// counts the audio that actually went past while something played, and this
// screen adds it up by day, by podcast and against the money.
//
// Everything from before the meter existed is estimated from what the
// library remembers and drawn in the paler half-tone, with a line at the
// bottom saying so — an honest gap is better than a total that quietly
// mixes what was measured with what was guessed.

const RANGES = [
    { id: 'week',  label: '7 days',  days: 7,  chart: 'Last 7 days' },
    { id: 'month', label: '30 days', days: 30, chart: 'Last 30 days' },
    { id: 'all',   label: 'All time', days: 0, chart: 'Last 12 months' },
];
const CHART_HEIGHT = 92;
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const KIND_ICON = { rss: 'rss', local: 'book-open', youtube: 'youtube', radio: 'radio' };

const dayLabel = (key, range) => {
    // Parsed as local noon: a bare 'YYYY-MM-DD' is UTC midnight, which is the
    // day before for anyone west of Greenwich. Over all time the keys are
    // months ('YYYY-MM') and carry no day at all.
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d || 1, 12);
    if (range === 'all') return MONTH[date.getMonth()];
    if (range === 'week') return WEEKDAY[date.getDay()];
    return date.getDate() === 1 || date.getDate() % 10 === 0 ? `${date.getDate()}` : '';
};

const longDate = (ms) => new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric', month: 'long', year: 'numeric',
});
const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Days listened to in a row, counting back from today (a day begun but not
 *  yet listened to does not break it). */
const streakOf = (rows) => {
    const days = new Set(rows.filter(r => r.seconds > 0).map(r => r.day));
    const keys = lastDays(400).reverse();
    let n = 0;
    for (let i = 0; i < keys.length; i++) {
        if (days.has(keys[i])) n += 1;
        else if (i > 0) break;          // today is allowed to be empty still
    }
    return n;
};

// One column a day (or a month, over all time), tallest in the stretch full
// height. A column is drawn in two pieces: what was measured, and under it
// the half-tone of what could only be estimated from the library.
const Bars = ({ buckets, range }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const max = Math.max(...buckets.map(b => b.seconds), 1);
    return (
        <View>
            <View style={styles.chartRow}>
                {buckets.map((b) => {
                    const height = b.seconds > 0
                        ? Math.max(3, Math.round(b.seconds / max * CHART_HEIGHT)) : 0;
                    const estimated = b.seconds > 0 ? Math.round(height * (b.estimated / b.seconds)) : 0;
                    return (
                        <View key={b.key} style={styles.column}>
                            {height > 0 ? (
                                <View style={[styles.bar, { height }]}>
                                    <View style={{ height: height - estimated, backgroundColor: colors.accent }} />
                                    <View style={{ height: estimated, backgroundColor: withAlpha(colors.accent, 0.35) }} />
                                </View>
                            ) : (
                                <View style={styles.barEmpty} />
                            )}
                        </View>
                    );
                })}
            </View>
            <View style={styles.tickRow}>
                {buckets.map(b => (
                    <View key={b.key} style={styles.column}>
                        <Text style={styles.tick} numberOfLines={1}>{dayLabel(b.key, range)}</Text>
                    </View>
                ))}
            </View>
        </View>
    );
};

const ShareRow = ({ label, sub, icon, value, fraction, tint, estimated }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    return (
        <View style={styles.shareRow}>
            <View style={styles.shareHead}>
                {!!icon && <Icon name={icon} size={13} color={colors.textMuted} style={{ marginRight: 8 }} />}
                <Text style={styles.shareLabel} numberOfLines={1}>{label}</Text>
                <Text style={[styles.shareValue, estimated && styles.faded]}>{value}</Text>
            </View>
            <View style={styles.track}>
                <View style={[styles.trackFill, {
                    width: `${Math.max(2, Math.round(fraction * 100))}%`,
                    backgroundColor: estimated ? withAlpha(tint, 0.35) : tint,
                }]} />
            </View>
            {!!sub && <Text style={styles.shareSub} numberOfLines={1}>{sub}</Text>}
        </View>
    );
};

const StatsScreen = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const isFocused = useIsFocused();
    const [stats, setStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [range, setRange] = useState('week');

    const load = useCallback(async () => {
        try { setStats(await loadStats()); } catch (_) { setStats(null); } finally { setIsLoading(false); }
    }, []);
    useEffect(() => { if (isFocused) load(); }, [isFocused, load]);

    useEffect(() => {
        navigation.setOptions({
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.textPrimary,
            headerTitleStyle: { fontWeight: '700', fontSize: 17, letterSpacing: -0.3 },
            headerShadowVisible: false,
            title: 'Statistics',
        });
    }, [navigation, colors]);

    const view = useMemo(() => {
        if (!stats) return null;
        const conf = RANGES.find(r => r.id === range) || RANGES[0];
        const keys = conf.days ? lastDays(conf.days) : lastMonths(12);
        const from = conf.days ? keys[0] : null;
        const totals = listeningTotals(stats.listening, from);
        const spend = spendByService(stats.spend, from);
        const hours = totals.seconds / 3600;
        return {
            conf,
            buckets: bucketed(stats.listening, keys, !conf.days),
            totals,
            spend,
            sources: listeningBySource(stats.listening, from),
            finished: finishedCount(stats.finished, from),
            days: conf.days || Math.max(1, new Set(stats.listening.map(r => r.day)).size),
            streak: streakOf(stats.listening),
            perHour: hours > 0.05 ? spend.total / hours : null,
            runs: stats.spend.filter(r => !from || r.day >= from),
        };
    }, [stats, range]);

    if (isLoading) {
        return (
            <View style={styles.loading}>
                <ActivityIndicator size='large' color={colors.accent} />
            </View>
        );
    }

    if (!view || (!stats.listening.length && !stats.spend.length)) {
        return (
            <View style={styles.container}>
                <EmptyState
                    icon='bar-chart-2'
                    title='Nothing counted yet'
                    subtitle='Play an episode and this page fills in: the time that really went past, where it went, and what the cloud passes cost.'
                />
            </View>
        );
    }

    const { conf, buckets, totals, spend, sources, finished, days, streak, perHour, runs } = view;
    const topSeconds = sources.length ? sources[0].seconds : 0;
    const speed = totals.real > 60 ? totals.seconds / totals.real : 0;

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={[styles.content, { paddingBottom: bottom + 32 }]}
        >
            <SegmentedControl
                options={RANGES.map(({ id, label }) => ({ id, label }))}
                value={range}
                onChange={setRange}
                style={styles.segments}
            />

            {/* Listening */}
            <View style={styles.card}>
                <Text style={styles.cardLabel}>REALLY LISTENED</Text>
                <View style={styles.bigRow}>
                    <Text style={styles.big}>{formatSpan(totals.seconds)}</Text>
                    {totals.estimated > 0 && (
                        <Text style={styles.bigNote}>
                            {totals.estimated >= totals.seconds - 1
                                ? 'all of it estimated'
                                : `${formatSpan(totals.estimated)} of it estimated`}
                        </Text>
                    )}
                </View>
                <Text style={styles.cardHint}>
                    {/* Over a fixed stretch that is a day of the week; over all
                        time only the days with something in them are known. */}
                    {formatSpan(totals.seconds / days)} a day{conf.days ? '' : ' you listened'}
                    {finished > 0 ? ` · ${finished} episode${finished === 1 ? '' : 's'} finished` : ''}
                    {streak > 1 ? ` · ${streak} days in a row` : ''}
                </Text>
                {speed > 1.02 && (
                    <Text style={styles.cardHint}>
                        {formatSpan(totals.real)} of your own time, at {speed.toFixed(2)}× on average
                    </Text>
                )}

                <View style={styles.chartHead}>
                    <Text style={styles.chartTitle}>{conf.chart}</Text>
                    <Text style={styles.chartPeak}>
                        peak {formatSpan(Math.max(...buckets.map(b => b.seconds), 0))}
                    </Text>
                </View>
                <Bars buckets={buckets} range={range} />
            </View>

            {/* Where it went */}
            {sources.length > 0 && (
                <>
                    <Text style={styles.sectionLabel}>WHERE IT WENT</Text>
                    <View style={styles.card}>
                        {sources.slice(0, 7).map(s => (
                            <ShareRow
                                key={s.key}
                                icon={KIND_ICON[s.kind] || 'headphones'}
                                label={s.source}
                                value={formatSpan(s.seconds)}
                                fraction={topSeconds ? s.seconds / topSeconds : 0}
                                tint={colors.accent}
                                estimated={s.estimated}
                            />
                        ))}
                        {sources.length > 7 && (
                            <Text style={styles.more}>
                                and {sources.length - 7} more, {formatSpan(sources.slice(7).reduce((n, s) => n + s.seconds, 0))} between them
                            </Text>
                        )}
                    </View>
                </>
            )}

            {/* Money */}
            <Text style={styles.sectionLabel}>WHAT THE CLOUD COST</Text>
            <View style={styles.card}>
                <View style={styles.bigRow}>
                    <Text style={[styles.big, { color: colors.purple }]}>{formatMoney(spend.total)}</Text>
                    {spend.estimated > 0 && (
                        <Text style={styles.bigNote}>{formatMoney(spend.estimated)} of it estimated</Text>
                    )}
                </View>
                <Text style={styles.cardHint}>
                    {runs.length} request{runs.length === 1 ? '' : 's'}
                    {perHour ? ` · ${formatMoney(perHour)} an hour of listening` : ''}
                </Text>
                {spend.services.length === 0 ? (
                    <Text style={styles.empty}>
                        Nothing spent in this stretch. The assistant, the punctuation repair and a cloud
                        transcription are the only things Podink ever pays for, each on a key of your own.
                    </Text>
                ) : (
                    <View style={styles.spendList}>
                        {spend.services.map(s => (
                            <ShareRow
                                key={s.service}
                                label={serviceLabel(s.service)}
                                sub={`${s.runs} run${s.runs === 1 ? '' : 's'}`}
                                value={formatMoney(s.cost)}
                                fraction={spend.total ? s.cost / spend.total : 0}
                                tint={colors.purple}
                                estimated={s.estimated >= s.cost - 1e-9}
                            />
                        ))}
                    </View>
                )}
            </View>

            {/* Every request */}
            {runs.length > 0 && (
                <>
                    <Text style={styles.sectionLabel}>EVERY REQUEST</Text>
                    <View style={styles.card}>
                        {runs.slice(0, 12).map((r, i) => (
                            <View key={`${r.at}-${i}`} style={[styles.runRow, i > 0 && styles.runBorder]}>
                                <View style={styles.runBody}>
                                    <Text style={styles.runTitle} numberOfLines={1}>
                                        {r.episodeTitle || 'An episode that has since gone'}
                                    </Text>
                                    <Text style={styles.runSub} numberOfLines={1}>
                                        {serviceLabel(r.service)} · {r.model || r.provider} · {shortDate(r.at)}
                                        {r.estimated ? ' · estimated' : ''}
                                    </Text>
                                </View>
                                <Text style={[styles.runCost, r.estimated && styles.faded]}>{formatMoney(r.cost)}</Text>
                            </View>
                        ))}
                        {runs.length > 12 && (
                            <Text style={styles.more}>and {runs.length - 12} earlier requests</Text>
                        )}
                    </View>
                </>
            )}

            <View style={styles.footnote}>
                <View style={styles.legendRow}>
                    <View style={[styles.swatch, { backgroundColor: colors.accent }]} />
                    <Text style={styles.footnoteText}>measured</Text>
                    <View style={[styles.swatch, styles.swatchFaint, { marginLeft: 14 }]} />
                    <Text style={styles.footnoteText}>estimated</Text>
                </View>
                <Text style={styles.footnoteText}>
                    Listening has been counted second by second since {longDate(stats.since)}. Before that
                    it is worked out from the library — an episode heard to the end counts its length, one
                    still going its position, on the day it was last played — and the assistant's earlier
                    runs are priced from the model that wrote them and the length of the episode. Cloud
                    transcriptions carry the price OpenRouter charged.
                </Text>
            </View>
        </ScrollView>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { paddingTop: 12 },
    loading: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },

    segments: { marginHorizontal: 16, marginBottom: 16 },

    sectionLabel: {
        ...type.caption,
        fontWeight: '700',
        color: colors.textMuted,
        letterSpacing: 0.7,
        paddingHorizontal: 32,
        marginTop: 22,
        marginBottom: 10,
    },

    card: {
        marginHorizontal: 16,
        padding: 16,
        backgroundColor: colors.surface,
        borderRadius: radii.l,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    cardLabel: {
        ...type.caption,
        fontWeight: '700',
        color: colors.textMuted,
        letterSpacing: 0.7,
        marginBottom: 6,
    },
    bigRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
    big: { fontSize: 34, fontWeight: '700', letterSpacing: -1, color: colors.textPrimary },
    bigNote: { ...type.label, color: colors.textFaint, marginLeft: 10 },
    cardHint: { ...type.body, color: colors.textSecondary, marginTop: 4 },

    chartHead: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginTop: 20,
        marginBottom: 8,
    },
    chartTitle: { ...type.caption, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.7 },
    chartPeak: { ...type.caption, color: colors.textFaint, letterSpacing: 0.3 },

    chartRow: { flexDirection: 'row', alignItems: 'flex-end', height: CHART_HEIGHT },
    tickRow: { flexDirection: 'row', alignItems: 'flex-start' },
    column: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 1 },
    bar: { width: '100%', maxWidth: 22, borderRadius: 3, overflow: 'hidden' },
    // A day with nothing in it still gets a baseline, so the row of bars
    // reads as a calendar rather than as gaps.
    barEmpty: { width: '100%', maxWidth: 22, height: 2, borderRadius: 1, backgroundColor: colors.surfaceHigh },
    tick: { ...type.caption, fontWeight: '500', color: colors.textFaint, marginTop: 6 },

    shareRow: { marginBottom: 14 },
    shareHead: { flexDirection: 'row', alignItems: 'center' },
    shareLabel: { ...type.bodyStrong, color: colors.textPrimary, flex: 1, marginRight: 10 },
    shareValue: { ...type.bodyStrong, color: colors.textSecondary },
    shareSub: { ...type.caption, fontWeight: '500', color: colors.textFaint, marginTop: 4 },
    track: {
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.surfaceHigh,
        marginTop: 7,
        overflow: 'hidden',
    },
    trackFill: { height: '100%', borderRadius: 3 },
    faded: { color: colors.textFaint },
    more: { ...type.body, color: colors.textMuted, marginTop: 2 },
    empty: { ...type.body, color: colors.textMuted, marginTop: 10, lineHeight: 19 },
    spendList: { marginTop: 16 },

    runRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
    runBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
    runBody: { flex: 1, marginRight: 12 },
    runTitle: { ...type.bodyStrong, color: colors.textPrimary },
    runSub: { ...type.caption, fontWeight: '500', color: colors.textFaint, marginTop: 3 },
    runCost: { ...type.bodyStrong, color: colors.textSecondary },

    footnote: { paddingHorizontal: 32, marginTop: 22 },
    legendRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
    swatch: { width: 10, height: 10, borderRadius: 2, marginRight: 6 },
    swatchFaint: { backgroundColor: withAlpha(colors.accent, 0.35) },
    footnoteText: { ...type.caption, fontWeight: '500', color: colors.textFaint, lineHeight: 17 },
});

export default StatsScreen;
