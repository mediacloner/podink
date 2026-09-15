import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { STATIONS } from '../services/radioStations';
import { fetchGuide, formatClock, hasGuide, minutesLeft, stationLocalTime, zoneDistanceMinutes } from '../services/radioSchedule';
import { currentProgramme, useRadioSession } from '../services/radioService';
import { radii, type, useStyles, useTheme, withAlpha } from '../theme';

const GUIDE_POLL_MS = 60 * 1000;

/**
 * "Live Radio" tab: the station list, each station with the programme on air
 * — its time span, title and description — so a listener can pick by what is
 * being said rather than by the station's name. Tapping a station opens its
 * screen (the full guide with the next two, Listen / Listen with transcript).
 *
 * Every station's guide is read when the tab comes in front and then once a
 * minute while it stays there and the app is active; radioSchedule caches
 * each read for a minute, so the station screen and a playing session share
 * the same answers instead of asking again.
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
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        if (!isFocused) return undefined;
        let t = null;
        const arm = () => {
            t = setTimeout(() => { setNowMs(Date.now()); arm(); }, 60000 - (Date.now() % 60000) + 50);
        };
        setNowMs(Date.now());
        arm();
        return () => clearTimeout(t);
    }, [isFocused]);

    // Nearest clock first; a stable sort keeps the curated order within a zone.
    // `sortTz` lets a station sort with another zone's group (Vaughan Radio,
    // from Madrid, sits with the British stations after the BBC ones).
    const stations = useMemo(() => STATIONS
        .map((st, i) => ({ st, i, d: (st.sortTz || st.tz) ? zoneDistanceMinutes(st.sortTz || st.tz, new Date(nowMs)) : Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.d - b.d || a.i - b.i)
        .map(x => x.st), [nowMs]);

    const renderItem = useCallback(({ item }) => {
        const active = session?.stationId === item.id;
        // The session's own guide read is fresher for the station playing, and
        // it knows the stream's ICY title when the station has no guide.
        const guide = active ? (session.guide || guides[item.id]) : guides[item.id];
        const now = active ? currentProgramme(session) : (guide?.now || null);
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
            local ? `local time ${localLabel}` : '',
            now ? `on air: ${now.title}` : '',
            now?.description || '',
        ].filter(Boolean).join(', ');
        return (
            <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('RadioStation', { stationId: item.id })}
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
                    <Icon name="chevron-right" size={18} color={colors.textFaint} style={styles.chevron} />
                </View>
                {now ? (
                    <View style={styles.onAir}>
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
                            <Text style={styles.programmeDesc} numberOfLines={3}>{now.description}</Text>
                        )}
                    </View>
                ) : (
                    !!empty && <Text style={styles.empty} numberOfLines={1}>{empty}</Text>
                )}
            </TouchableOpacity>
        );
    }, [session, guides, nowMs, styles, colors, navigation]);

    return (
        <View style={styles.container}>
            <FlatList
                data={stations}
                keyExtractor={(s) => s.id}
                renderItem={renderItem}
                extraData={{ session, guides, nowMs }}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                ListHeaderComponent={(
                    <Text style={styles.intro}>
                        English-language talk radio, live. Listen straight away — pause, skip back and
                        catch up as you like — or with a transcript, about 40 seconds behind the air so
                        the words are on screen before you hear them. Rewind, replay, look words up.
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
    chevron: { alignSelf: 'flex-start', marginTop: 1 },
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
    // subtitle, then the description.
    onAir: { marginTop: 2, gap: 2 },
    onAirHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 1 },
    onAirDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger },
    onAirTime: { ...type.caption, color: colors.accent, fontVariant: ['tabular-nums'], letterSpacing: 0.3 },
    onAirLeft: { ...type.caption, color: colors.textMuted, letterSpacing: 0, marginLeft: 'auto', flexShrink: 1 },
    programmeTitle: { ...type.title, color: colors.textPrimary, lineHeight: 20 },
    programmeSubtitle: { ...type.bodyStrong, color: colors.textSecondary, lineHeight: 18 },
    programmeDesc: { ...type.body, fontSize: 13.5, color: colors.textSecondary, lineHeight: 19, marginTop: 1 },
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
