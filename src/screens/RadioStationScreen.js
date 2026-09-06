import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { showAlert } from '../components/AppAlert';
import ProgrammeGuide from '../components/ProgrammeGuide';
import { getEpisodeById } from '../database/queries';
import { getStation } from '../services/radioStations';
import { fetchGuide, stationLocalTime } from '../services/radioSchedule';
import {
    currentProgramme, FOLLOW_DELAY_SEC, isRadioAvailable, startSession, stopSession, useRadioSession,
} from '../services/radioService';
import { radii, type, useStyles, useTheme, withAlpha } from '../theme';

const GUIDE_POLL_MS = 60 * 1000;

const formatSec = (s) => {
    const n = Math.max(0, Math.round(s || 0));
    const m = Math.floor(n / 60);
    return m > 0 ? `${m}:${String(n % 60).padStart(2, '0')}` : `${n} s`;
};

/**
 * One station: what is on air and coming up, and the two ways to listen.
 * "Listen live" plays the stream as it comes. "Listen with transcript" records
 * it and transcribes it on-device so the text follows the audio (about half a
 * minute behind the air) with every Player feature — rewind, replay a
 * sentence, word cards — and a Live button to catch up.
 */
const RadioStationScreen = ({ route, navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const station = getStation(route.params?.stationId);
    const session = useRadioSession();
    const isFocused = useIsFocused();
    const mine = !!session && session.stationId === station?.id;
    const [guide, setGuide] = useState(null);
    const [busy, setBusy] = useState(null); // 'live' | 'transcript' | 'stop'
    const busyRef = useRef(false);

    useEffect(() => {
        navigation.setOptions({ title: station ? station.name : 'Live Radio' });
    }, [navigation, station]);

    // Guide: on open, then once a minute while the screen is in front.
    useEffect(() => {
        if (!station || !isFocused) return undefined;
        let alive = true;
        const load = (force) => fetchGuide(station, { force }).then(g => { if (alive) setGuide(g); });
        load(false);
        const t = setInterval(() => load(false), GUIDE_POLL_MS);
        return () => { alive = false; clearInterval(t); };
    }, [station, isFocused]);

    // The session's own guide read is fresher when we are the station playing.
    useEffect(() => { if (mine && session.guide) setGuide(session.guide); }, [mine, session?.guide]);

    // The station's local clock: re-render on each minute boundary while in front.
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

    const openPlayer = useCallback(async (episodeId) => {
        const episode = await getEpisodeById(episodeId);
        if (episode) navigation.navigate('Player', { episode });
    }, [navigation]);

    const listen = useCallback(async (mode) => {
        if (!station || busyRef.current) return;
        busyRef.current = true;
        setBusy(mode);
        try {
            const s = await startSession(station.id, mode);
            if (s) await openPlayer(s.episodeId);
        } catch (e) {
            if (e?.code === 'MODEL_NOT_DOWNLOADED') {
                showAlert(
                    'Speech model needed',
                    'Transcribing live radio runs on the device and needs the speech model. Download it in Settings → Transcription, then come back.',
                    [
                        { text: 'Not now', style: 'cancel' },
                        { text: 'Open Settings', onPress: () => navigation.navigate('Settings') },
                    ],
                );
            } else {
                showAlert('Could not start the radio', e?.message || 'Please try again.');
            }
        } finally {
            busyRef.current = false;
            setBusy(null);
        }
    }, [station, navigation, openPlayer]);

    const stop = useCallback(async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy('stop');
        try { await stopSession(); } finally { busyRef.current = false; setBusy(null); }
    }, []);

    if (!station) {
        return <View style={styles.container}><Text style={styles.detail}>Unknown station.</Text></View>;
    }

    const programme = mine ? currentProgramme(session) : (guide?.now || null);
    const canTranscribe = isRadioAvailable();
    const local = station.tz ? stationLocalTime(station.tz, new Date(nowMs)) : null;
    const localDay = local
        ? (local.dayShift > 0 ? `already ${local.weekday}` : local.dayShift < 0 ? `still ${local.weekday}` : local.weekday)
        : '';

    let statusLine = null;
    if (mine) {
        switch (session.status) {
            case 'starting': statusLine = 'Starting…'; break;
            case 'buffering':
                statusLine = session.totalSec > 0
                    ? `Buffering ${FOLLOW_DELAY_SEC} s so the text stays ahead of the sound — ${formatSec(Math.min(FOLLOW_DELAY_SEC, session.totalSec))} so far.`
                    : 'Connecting to the stream…';
                break;
            case 'loading': statusLine = 'Starting playback…'; break;
            case 'playing':
                statusLine = session.mode === 'transcript'
                    ? `Playing with transcript — ${formatSec(session.totalSec)} recorded, text up to ${formatSec(session.frontierSec)}.`
                    : 'Playing live.';
                break;
            case 'ended': statusLine = session.statusMessage || 'The stream ended.'; break;
            case 'error': statusLine = session.statusMessage || 'Something went wrong.'; break;
            default: statusLine = '';
        }
    }

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            <View style={styles.head}>
                <View style={styles.logoTile}>
                    {station.logo
                        ? <Image source={station.logo} style={styles.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
                        : <Text style={styles.flagFallback}>{station.flag}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{station.name}</Text>
                    <Text style={styles.blurb}>{station.blurb}</Text>
                </View>
            </View>
            {!!station.detail && <Text style={styles.detail}>{station.detail}</Text>}
            {!!local && (
                <View style={styles.clockRow} accessibilityLabel={`Local time in ${station.city}: ${local.clock}, ${localDay}`}>
                    <Icon name="clock" size={14} color={colors.textMuted} />
                    <Text style={styles.clockText}>
                        {`Local time in ${station.city}: `}
                        <Text style={styles.clockValue}>{local.clock}</Text>
                        {` · ${localDay}`}
                    </Text>
                </View>
            )}

            {mine ? (
                <View style={styles.sessionCard}>
                    <View style={styles.sessionHead}>
                        <View style={styles.liveDot} />
                        <Text style={styles.sessionTitle}>
                            {session.mode === 'transcript' ? 'Listening with transcript' : 'Listening live'}
                        </Text>
                        {(session.status === 'buffering' || session.status === 'loading' || session.status === 'starting') && (
                            <ActivityIndicator size="small" color={colors.accent} style={{ marginLeft: 'auto' }} />
                        )}
                    </View>
                    {!!statusLine && <Text style={styles.sessionStatus}>{statusLine}</Text>}
                    {!!session.recorderError && session.status !== 'error' && (
                        <Text style={styles.sessionWarn}>Stream hiccup: {session.recorderError}</Text>
                    )}
                    {!!session.transcriptError && (
                        <Text style={styles.sessionWarn}>Transcription: {session.transcriptError}</Text>
                    )}
                    <View style={styles.actions}>
                        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => openPlayer(session.episodeId)} activeOpacity={0.8}>
                            <Icon name="chevron-up" size={16} color={colors.onAccent} />
                            <Text style={[styles.btnText, { color: colors.onAccent }]}>Open player</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={stop} disabled={busy === 'stop'} activeOpacity={0.8}>
                            {busy === 'stop'
                                ? <ActivityIndicator size="small" color={colors.danger} />
                                : <Icon name="square" size={15} color={colors.danger} />}
                            <Text style={[styles.btnText, { color: colors.danger }]}>Stop</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            ) : (
                <View style={styles.actions}>
                    <TouchableOpacity
                        style={[styles.btn, styles.btnPrimary]}
                        onPress={() => listen('live')}
                        disabled={!!busy}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel="Listen live without transcript"
                    >
                        {busy === 'live'
                            ? <ActivityIndicator size="small" color={colors.onAccent} />
                            : <Icon name="radio" size={16} color={colors.onAccent} />}
                        <Text style={[styles.btnText, { color: colors.onAccent }]}>Listen live</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.btn, styles.btnAccent, !canTranscribe && styles.btnDisabled]}
                        onPress={() => listen('transcript')}
                        disabled={!!busy || !canTranscribe}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel="Listen with transcript"
                    >
                        {busy === 'transcript'
                            ? <ActivityIndicator size="small" color={colors.accent} />
                            : <Icon name="type" size={16} color={colors.accent} />}
                        <Text style={[styles.btnText, { color: colors.accent }]}>With transcript</Text>
                    </TouchableOpacity>
                </View>
            )}
            {!mine && (
                <Text style={styles.hint}>
                    With transcript, the stream is recorded and transcribed on the device as it plays,
                    about {FOLLOW_DELAY_SEC} seconds behind the air so the words are on screen before you hear them.
                    You can rewind, replay a sentence, look words up, and jump back to live at any time.
                </Text>
            )}

            <ProgrammeGuide guide={mine ? (session.guide || guide) : guide} icyTitle={mine ? session.icyTitle : null} />
            {!programme && !guide && <ActivityIndicator size="small" color={colors.accent} style={{ marginTop: 8 }} />}
        </ScrollView>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { paddingBottom: 120 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingTop: 10 },
    logoTile: {
        width: 112, height: 72, borderRadius: radii.m, padding: 10,
        backgroundColor: '#FFFFFF', borderWidth: 0.5, borderColor: colors.hairline,
        alignItems: 'center', justifyContent: 'center',
    },
    logo: { width: '100%', height: '100%' },
    flagFallback: { fontSize: 32, lineHeight: 40 },
    name: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, color: colors.textPrimary },
    blurb: { ...type.body, fontSize: 14, color: colors.textSecondary, lineHeight: 19, marginTop: 3 },
    detail: { ...type.body, fontSize: 14, lineHeight: 21, color: colors.textMuted, paddingHorizontal: 20, paddingTop: 14 },
    clockRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingTop: 8 },
    clockText: { ...type.body, fontSize: 14, lineHeight: 20, color: colors.textMuted },
    clockValue: { ...type.bodyStrong, fontSize: 14, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
    actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 18 },
    btn: {
        flex: 1, minHeight: 48, borderRadius: radii.m,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingHorizontal: 12,
    },
    btnPrimary: { backgroundColor: colors.accent },
    btnAccent: { backgroundColor: withAlpha(colors.accent, 0.12), borderWidth: 0.5, borderColor: withAlpha(colors.accent, 0.35) },
    btnGhost: { backgroundColor: withAlpha(colors.danger, 0.10), borderWidth: 0.5, borderColor: withAlpha(colors.danger, 0.3) },
    btnDisabled: { opacity: 0.4 },
    btnText: { ...type.title, fontSize: 15 },
    hint: { ...type.body, color: colors.textMuted, lineHeight: 18, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6 },
    sessionCard: {
        marginHorizontal: 20, marginTop: 18, padding: 16, gap: 8,
        backgroundColor: colors.surfaceElevated, borderRadius: radii.m,
        borderWidth: 0.5, borderColor: withAlpha(colors.accent, 0.35),
    },
    sessionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
    sessionTitle: { ...type.title, color: colors.textPrimary },
    sessionStatus: { ...type.body, color: colors.textSecondary, lineHeight: 18 },
    sessionWarn: { ...type.body, color: colors.warning, lineHeight: 18 },
});

export default RadioStationScreen;
