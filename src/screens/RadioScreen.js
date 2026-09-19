import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Image, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { showAlert } from '../components/AppAlert';
import { getEpisodeById } from '../database/queries';
import { useMinuteClock } from '../hooks/useMinuteClock';
import { STATIONS } from '../services/radioStations';
import { fetchGuide, formatClock, hasGuide, minutesLeft, stationLocalTime, zoneDistanceMinutes } from '../services/radioSchedule';
import { currentProgramme, FOLLOW_DELAY_SEC, startSession, useRadioSession } from '../services/radioService';
import { radii, type, useStyles, useTheme, withAlpha } from '../theme';

const GUIDE_POLL_MS = 60 * 1000;

/**
 * "Live Radio" tab: the station list, each station with the programme on air
 * — its time span, title and description — so a listener can pick by what is
 * being said rather than by the station's name.
 *
 * Tapping a station plays it at once — the stream itself, no recorder and no
 * delay — and opens the Player, where the station's clock, the guide and the
 * Transcription button live (user, 2026-09-19: "when I click to station
 * start to listen directly without recording and delay"). Tapping the
 * programme on air unfolds what comes next, under it, in the row. The
 * station page with its two buttons, the step between list and Player
 * since 4.0.0, is gone.
 *
 * Every station's guide is read when the tab comes in front and then once a
 * minute while it stays there and the app is active; radioSchedule caches
 * each read for a minute, so a playing session shares the same answers
 * instead of asking again.
 *
 * Each row also carries the station's own wall clock ("14:32 in Sydney ·
 * already Tuesday"), re-rendered on every minute boundary while the tab is in
 * front — the same tick keeps the "min left" figures honest.
 *
 * The stations are listed by how close their clock is to the listener's own:
 * from Spain the British and Irish stations come first (an hour away), then
 * Canada and the United States, then Australia and New Zealand, whose day is
 * already ending or over. Stations the same distance away keep their curated
 * order. The distance is measured with today's offsets, so it follows daylight
 * saving on both sides.
 */
const RadioScreen = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const session = useRadioSession();
    const isFocused = useIsFocused();
    const [guides, setGuides] = useState({}); // stationId -> guide
    const [busyId, setBusyId] = useState(null); // station being tuned in
    const busyRef = useRef(false);
    const [openId, setOpenId] = useState(null); // station whose coming-up list is unfolded

    useEffect(() => {
        if (!isFocused) return undefined;
        let alive = true;
        const load = () => {
            if (AppState.currentState !== 'active') return;
            for (const st of STATIONS) {
                if (!hasGuide(st)) continue;
                fetchGuide(st).then(g => {
                    if (!alive) return;
                    // The cache hands back the same object inside its TTL: no re-render then.
                    setGuides(prev => (prev[st.id] === g ? prev : { ...prev, [st.id]: g }));
                });
            }
        };
        load();
        const t = setInterval(load, GUIDE_POLL_MS);
        const sub = AppState.addEventListener('change', (next) => { if (next === 'active') load(); });
        return () => { alive = false; clearInterval(t); sub.remove(); };
    }, [isFocused]);

    // The stations' local clocks: re-render on each minute boundary while in front.
    const nowMs = useMinuteClock(isFocused);

    // Nearest clock first; a stable sort keeps the curated order within a zone.
    // `sortTz` lets a station sort with another zone's group (Vaughan Radio,
    // from Madrid, sits with the British stations after the BBC ones).
    const stations = useMemo(() => STATIONS
        .map((st, i) => ({ st, i, d: (st.sortTz || st.tz) ? zoneDistanceMinutes(st.sortTz || st.tz, new Date(nowMs)) : Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.d - b.d || a.i - b.i)
        .map(x => x.st), [nowMs]);

    const openPlayer = useCallback(async (episodeId) => {
        const episode = await getEpisodeById(episodeId);
        if (episode) navigation.navigate('Player', { episode });
    }, [navigation]);

    // A tap on a station: the one playing just opens its Player; another
    // starts playing (the stream itself, at once) and opens the Player.
    const tune = useCallback(async (station) => {
        if (busyRef.current) return;
        if (session?.stationId === station.id) { openPlayer(session.episodeId); return; }
        busyRef.current = true;
        setBusyId(station.id);
        try {
            const s = await startSession(station.id, 'live');
            if (s) await openPlayer(s.episodeId);
        } catch (e) {
            showAlert('Could not start the radio', e?.message || 'Please try again.');
        } finally {
            busyRef.current = false;
            setBusyId(null);
        }
    }, [session, openPlayer]);

    const renderItem = useCallback(({ item }) => {
        const active = session?.stationId === item.id;
        const busy = busyId === item.id;
        // The session's own guide read is fresher for the station playing, and
        // it knows the stream's ICY title when the station has no guide.
        const guide = active ? (session.guide || guides[item.id]) : guides[item.id];
        const now = active ? currentProgramme(session) : (guide?.now || null);
        const next = guide?.next || [];
        const open = openId === item.id && next.length > 0;
        const timed = !!now && now.start > 0 && now.end > now.start;
        const left = timed && now.end > nowMs ? minutesLeft(now, nowMs) : 0;

        // A guide with nothing on right now says nothing at all: the row is
        // just the station (user: "eliminate in ABC News 'nothing listed'").
        let empty = null;
        if (!now && hasGuide(item)) {
            if (!guide) empty = 'Loading what’s on…';
            else if (guide.source === 'error') empty = 'Programme guide unavailable';
        }

        // The station's wall clock; the weekday only when it differs from ours.
        const local = item.tz ? stationLocalTime(item.tz, new Date(nowMs)) : null;
        const localDay = local && local.dayShift !== 0
            ? (local.dayShift > 0 ? `already ${local.weekday}` : `still ${local.weekday}`)
            : '';
        const localLabel = local ? `${local.clock} in ${item.city}${localDay ? ` · ${localDay}` : ''}` : '';

        const a11y = [
            item.name,
            active ? 'playing' : 'tap to play',
            local ? `local time ${localLabel}` : '',
            now ? `on air: ${now.title}` : '',
            now?.description || '',
        ].filter(Boolean).join(', ');
        return (
            <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => tune(item)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={a11y}
            >
                <View style={styles.top}>
                    <View style={[styles.logoTile, active && { borderColor: withAlpha(colors.accent, 0.6) }]}>
                        {item.logo
                            ? (
                                <View style={styles.logoBox}>
                                    <Image source={item.logo} style={styles.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
                                </View>
                            )
                            : <Text style={styles.flagFallback}>{item.flag}</Text>}
                    </View>
                    <View style={styles.info}>
                        <View style={styles.titleRow}>
                            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                            {active && (
                                <View style={styles.livePill}>
                                    <View style={styles.liveDot} />
                                    <Text style={styles.liveText}>{session.mode === 'transcript' ? 'LIVE · TEXT' : 'LIVE'}</Text>
                                </View>
                            )}
                        </View>
                        {!!local && (
                            <View style={styles.clockRow}>
                                <Icon name="clock" size={12} color={colors.textMuted} />
                                <Text style={styles.clockText} numberOfLines={1}>
                                    <Text style={styles.clockValue}>{local.clock}</Text>
                                    {` in ${item.city}`}
                                    {!!localDay && <Text style={styles.clockDay}>{` · ${localDay}`}</Text>}
                                </Text>
                            </View>
                        )}
                        <Text style={styles.blurb} numberOfLines={2}>{item.blurb}</Text>
                    </View>
                    {/* A tap plays: the glyph says so. The station playing
                        opens its Player instead. */}
                    <View style={styles.glyph}>
                        {busy
                            ? <ActivityIndicator size="small" color={colors.accent} />
                            : active
                                ? <Icon name="chevron-right" size={20} color={colors.textFaint} />
                                : <Icon name="play-circle" size={24} color={colors.accent} />}
                    </View>
                </View>
                {now ? (
                    // The programme on air. A tap on it unfolds what comes
                    // next (and folds it away again) without starting the
                    // station: the inner press wins over the row's. With
                    // nothing to unfold it is disabled, so the tap falls
                    // through to the row and plays the station.
                    <Pressable
                        style={({ pressed }) => [styles.onAir, pressed && { opacity: 0.7 }]}
                        onPress={() => setOpenId(prev => (prev === item.id ? null : item.id))}
                        disabled={next.length === 0}
                        accessibilityRole={next.length > 0 ? 'button' : undefined}
                        accessibilityLabel={next.length > 0 ? (open ? 'Hide what comes next' : 'Show what comes next') : undefined}
                    >
                        <View style={styles.onAirHead}>
                            <View style={styles.onAirDot} />
                            <Text style={styles.onAirTime} numberOfLines={1}>
                                {timed ? `${formatClock(now.start)} – ${formatClock(now.end)}` : 'ON AIR'}
                            </Text>
                            {left > 0 && <Text style={styles.onAirLeft} numberOfLines={1}>{left} min left</Text>}
                        </View>
                        <Text style={styles.programmeTitle} numberOfLines={2}>{now.title}</Text>
                        {!!now.subtitle && <Text style={styles.programmeSubtitle} numberOfLines={1}>{now.subtitle}</Text>}
                        {!!now.description && (
                            <Text style={styles.programmeDesc} numberOfLines={open ? 6 : 3}>{now.description}</Text>
                        )}
                        {next.length > 0 && (
                            <View style={styles.foldRow}>
                                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} color={colors.accent} />
                                <Text style={styles.foldText}>{open ? 'Hide what comes next' : 'Coming up'}</Text>
                            </View>
                        )}
                        {open && (
                            <View style={styles.nextList}>
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
                                                <Text style={styles.nextDesc} numberOfLines={3}>{p.description}</Text>
                                            )}
                                        </View>
                                    </View>
                                ))}
                            </View>
                        )}
                    </Pressable>
                ) : (
                    !!empty && <Text style={styles.empty} numberOfLines={1}>{empty}</Text>
                )}
            </TouchableOpacity>
        );
    }, [session, guides, nowMs, busyId, openId, styles, colors, tune]);

    return (
        <View style={styles.container}>
            <FlatList
                data={stations}
                keyExtractor={(s) => s.id}
                renderItem={renderItem}
                extraData={{ session, guides, nowMs, busyId, openId }}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                ListHeaderComponent={(
                    <Text style={styles.intro}>
                        {`English-language talk radio, live. Tap a station and it plays at once. In the player, Transcription writes the words on screen as the station plays, about ${FOLLOW_DELAY_SEC} seconds behind the air — rewind, replay, look words up. Tap the programme on air to see what comes next.`}
                    </Text>
                )}
                contentContainerStyle={{ paddingBottom: 120 }}
            />
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    intro: { ...type.body, color: colors.textMuted, lineHeight: 19, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 14 },
    row: {
        paddingHorizontal: 20,
        paddingVertical: 14,
        backgroundColor: colors.bg,
        gap: 8,
    },
    // Logo beside name, clock and blurb; the programme on air — time, title,
    // description — takes the whole width under them. The tile stretches to
    // the text block, so its top edge sits on the name and its bottom on the
    // blurb's last line; the blurb keeps two lines' height even when it has
    // one, so every station's tile is the same size.
    top: { flexDirection: 'row', alignItems: 'stretch', gap: 14 },
    glyph: { alignSelf: 'flex-start', width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    // Logos are wordmarks of very different shapes (a wide RTÉ, a round ABC):
    // a wide white tile with `contain` fits them all at a legible size. The
    // image sits in a box laid over the tile rather than in its flow, so the
    // tile's height comes from the text beside it and never from the image.
    logoTile: {
        width: 96,
        minHeight: 60,
        borderRadius: radii.s,
        backgroundColor: '#FFFFFF',
        borderWidth: 0.5,
        borderColor: colors.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    // A bundled image defaults to its own pixel size, so it needs an explicit
    // size: the full extent of an inset box laid over the tile.
    logoBox: { position: 'absolute', top: 8, left: 8, right: 8, bottom: 8 },
    logo: { width: '100%', height: '100%' },
    flagFallback: { fontSize: 28, lineHeight: 34 },
    info: { flex: 1, gap: 3, justifyContent: 'flex-start' },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    name: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
    // The station's own clock under its name: "14:32 in Sydney · already Tuesday".
    clockRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    clockText: { ...type.body, fontSize: 13, lineHeight: 17, color: colors.textMuted },
    clockValue: { ...type.bodyStrong, fontSize: 13, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
    clockDay: { ...type.body, fontSize: 13, color: colors.accent },
    blurb: { ...type.body, color: colors.textMuted, lineHeight: 18, minHeight: 36 },
    // The programme on air, across the row: time span in the accent, title,
    // subtitle, then the description; "Coming up" unfolds the next ones.
    onAir: { marginTop: 2, gap: 2 },
    onAirHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 1 },
    onAirDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger },
    onAirTime: { ...type.caption, color: colors.accent, fontVariant: ['tabular-nums'], letterSpacing: 0.3 },
    onAirLeft: { ...type.caption, color: colors.textMuted, letterSpacing: 0, marginLeft: 'auto', flexShrink: 1 },
    programmeTitle: { ...type.title, color: colors.textPrimary, lineHeight: 20 },
    programmeSubtitle: { ...type.bodyStrong, color: colors.textSecondary, lineHeight: 18 },
    programmeDesc: { ...type.body, fontSize: 13.5, color: colors.textSecondary, lineHeight: 19, marginTop: 1 },
    foldRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    foldText: { ...type.caption, color: colors.accent, letterSpacing: 0.3 },
    nextList: { marginTop: 4 },
    nextRow: { flexDirection: 'row', gap: 12, paddingVertical: 8 },
    nextRowBorder: { borderTopWidth: 0.5, borderTopColor: colors.hairline },
    nextWhen: { width: 48, paddingTop: 1, gap: 2 },
    nextTime: { ...type.bodyStrong, fontSize: 13, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    nextLength: { ...type.caption, color: colors.textMuted, letterSpacing: 0 },
    nextBody: { flex: 1, gap: 2 },
    nextTitle: { ...type.bodyStrong, color: colors.textPrimary, lineHeight: 19 },
    nextSubtitle: { ...type.body, fontSize: 13, color: colors.textSecondary, lineHeight: 17 },
    nextDesc: { ...type.body, fontSize: 13, color: colors.textMuted, lineHeight: 18 },
    empty: { ...type.body, color: colors.textFaint, lineHeight: 18, marginTop: 2, fontStyle: 'italic' },
    livePill: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.pill,
        backgroundColor: withAlpha(colors.danger, 0.12),
    },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger },
    liveText: { ...type.caption, color: colors.danger },
    separator: { height: 0.5, backgroundColor: withAlpha(colors.textPrimary, 0.06), marginHorizontal: 20 },
});

export default RadioScreen;
