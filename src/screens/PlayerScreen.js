import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View, StyleSheet, Text, Image,
    ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { State } from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import PlayerControls from '../components/PlayerControls';
import TranscriptHighlighter from '../components/TranscriptHighlighter';
import { loadEpisodeTrack, ensurePlayerAlive, onPlayerRecovered } from '../services/trackPlayer';
import { isPlaybackComplete, persistProgress } from '../services/playbackService';
import { onLibraryChange } from '../services/libraryEvents';
import {
    getAbortingId, getActiveId, getQueueIds, onQueueChange, onTranscriptProgress,
} from '../services/whisperService';
import {
    downloadEpisode, reportDownloadError, reportTranscriptionError, transcribeEpisode,
} from '../services/episodeService';
import { getEpisodeById, getTranscriptsForEpisode } from '../database/queries';
import { extractColor, softenForHeader } from '../services/colorExtractor';
import { useTheme, useStyles, radii, withAlpha } from '../theme';

// Minimum gap between transcript re-fetches while live transcription streams
// 'transcript-progress' events — keeps chunk rebuilds >= 1.5s apart.
const LIVE_REFETCH_MIN_MS = 1500;

const PlayerScreen = ({ route, navigation }) => {
    const { colors, isDark } = useTheme();
    const styles = useStyles(makeStyles);
    useKeepAwake();
    const episodeParam = route.params.episode;
    const epId = episodeParam.id;
    const insets = useSafeAreaInsets();

    // ep is the authoritative episode row: starts as the route snapshot, then
    // replaced by a fresh DB read (route params go stale for play_position,
    // has_transcript and local_audio_path).
    const [ep, setEp] = useState(episodeParam);
    const epRef = useRef(ep);
    epRef.current = ep;

    const [segments, setSegments] = useState([]);
    const [transcriptLoading, setTranscriptLoading] = useState(false);
    const [audioStatus, setAudioStatus] = useState('');
    const [audioError, setAudioError] = useState(false);
    const [colorInfo, setColorInfo] = useState(null);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [transcribing, setTranscribing] = useState(false);
    const [isQueued, setIsQueued] = useState(false);
    const [transcribeProgress, setTranscribeProgress] = useState(0);
    // "Download & transcribe" from the no-transcript card of a streamed
    // episode. Keyed by id so a download started for one episode never shows
    // as in flight on another after navigating.
    const [downloadingId, setDownloadingId] = useState(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const downloadingIdRef = useRef(null);
    const [playerReady, setPlayerReady] = useState(false);
    // Synchronous mirror of playerReady: when epId changes, the setup effect
    // flips this ref false in the same commit, so the seek-consuming effect
    // below can't act on a stale playerReady=true closure and send the new
    // episode's seek target to the previous episode's track.
    const playerReadyRef = useRef(false);

    const transcriptRef = useRef(null);
    // Populated by the seekToMs param effect below — it runs after this
    // effect's synchronous part but before the async body reads it.
    const pendingSeekRef = useRef(null);

    // Loads this episode's audio and starts playback. Extracted from the setup
    // effect so a failed attempt can be retried from the UI and a rebuilt
    // player can re-attach its track without leaving the screen. Concurrent
    // runs are fenced by a token — only the newest may touch state.
    const loadRunRef = useRef(0);
    const audioLoadingRef = useRef(false);

    const startAudio = useCallback(async () => {
        const run = ++loadRunRef.current;
        const isCurrent = () => loadRunRef.current === run;
        audioLoadingRef.current = true;
        try {
            setAudioError(false);
            setAudioStatus('Preparing audio…');

            // The media service may have been destroyed while the app sat in
            // the background; without this every command below is a silent
            // no-op against a dead player.
            await ensurePlayerAlive();

            const fresh = await getEpisodeById(epId);
            const row = fresh || episodeParam;
            if (isCurrent()) setEp(row);

            const currentTrack = await TrackPlayer.getActiveTrack();
            const alreadyLoaded = currentTrack?.id === epId;

            if (!alreadyLoaded) {
                await loadEpisodeTrack(row, false);
                // An explicit seek target (e.g. from Vocabulary) wins over
                // the resume position.
                const seekMs = pendingSeekRef.current;
                if (seekMs != null) {
                    pendingSeekRef.current = null;
                    await TrackPlayer.seekTo(Math.max(0, seekMs) / 1000);
                } else if (row.play_position > 0 && !isPlaybackComplete(row.play_position, row.duration)) {
                    // A finished episode restarts from the top instead of
                    // resuming into the last few seconds of the outro.
                    // (Completion now persists play_position = 0; the
                    // isPlaybackComplete guard covers rows finished before
                    // that behavior existed.)
                    await TrackPlayer.seekTo(row.play_position);
                }
            } else {
                // Replaying the episode that just finished: it is still
                // the active track, sitting in State.Ended, and play()
                // alone can't leave that state — restart from the top.
                const { state } = await TrackPlayer.getPlaybackState();
                if (state === State.Ended) {
                    await TrackPlayer.seekTo(0);
                    await TrackPlayer.play();
                }
            }

            if (isCurrent()) setAudioStatus('');
            if (!alreadyLoaded) await TrackPlayer.play();
            if (isCurrent()) {
                playerReadyRef.current = true;
                setPlayerReady(true);
            }
        } catch (e) {
            console.error('Playback setup failed', e);
            if (isCurrent()) {
                setAudioStatus('');
                // Surfaced instead of swallowed: this used to leave an inert
                // play button with nothing explaining why it did nothing.
                setAudioError(true);
                playerReadyRef.current = true;
                setPlayerReady(true);
            }
        } finally {
            if (isCurrent()) audioLoadingRef.current = false;
        }
    }, [epId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Playback setup (keyed by episode id — re-navigation with the same
    //    episode must not restart audio) ───────────────────────────────────────
    useEffect(() => {
        let alive = true;
        pendingSeekRef.current = null; // a stale target must never hit a new episode
        playerReadyRef.current = false;
        setSegments([]);
        setEp(episodeParam);
        setPlayerReady(false);
        setTranscribeProgress(0);

        if (episodeParam.image_url) {
            extractColor(episodeParam.image_url).then(info => {
                if (alive && info) setColorInfo(info);
            });
        } else {
            setColorInfo(null);
        }

        startAudio();

        return () => {
            alive = false;
            loadRunRef.current++; // fence the in-flight load against this unmount
        };
    }, [epId, startAudio]); // eslint-disable-line react-hooks/exhaustive-deps

    // A rebuilt player comes back with an empty queue, so re-attach this
    // episode's track. Skipped when our own load triggered the rebuild — that
    // call attaches the track itself once ensurePlayerAlive() returns.
    useEffect(() => onPlayerRecovered(() => {
        if (audioLoadingRef.current) return;
        startAudio();
    }), [startAudio]);

    // Flush one final play position on unmount; periodic saves are owned by
    // playbackService (PlaybackProgressUpdated) — no interval here.
    useEffect(() => () => {
        (async () => {
            try {
                const [progress, track] = await Promise.all([
                    TrackPlayer.getProgress(),
                    TrackPlayer.getActiveTrack(),
                ]);
                if (track?.id === epId) {
                    await persistProgress(epId, progress.position, progress.duration);
                }
            } catch (_) {}
        })();
    }, [epId]);

    // ── seekToMs param (initial value is consumed by setup above; this handles
    //    later navigations to the already-mounted screen) ─────────────────────
    useEffect(() => {
        const ms = route.params?.seekToMs;
        if (ms == null) return;
        pendingSeekRef.current = ms;
        // Clear so an identical target sent again still retriggers this effect.
        navigation.setParams({ seekToMs: undefined });
    }, [route.params?.seekToMs, navigation]);

    useEffect(() => {
        // playerReadyRef guards against the stale-closure commit where epId
        // just changed but the playerReady=false state hasn't re-rendered yet.
        if (!playerReady || !playerReadyRef.current) return;
        const ms = pendingSeekRef.current;
        if (ms == null) return;
        pendingSeekRef.current = null;
        if (transcriptRef.current) {
            transcriptRef.current.seekToMs(ms); // also re-engages follow mode
        } else {
            TrackPlayer.seekTo(Math.max(0, ms) / 1000).catch(() => {});
        }
    }, [playerReady, route.params?.seekToMs]);

    // ── Transcript fetch + live streaming ─────────────────────────────────────
    const refetchTranscript = useCallback(async () => {
        try {
            const rows = await getTranscriptsForEpisode(epId);
            setSegments(rows);
        } catch (_) {}
    }, [epId]);

    useEffect(() => {
        let alive = true;
        setTranscriptLoading(true);
        getTranscriptsForEpisode(epId)
            .then(rows => { if (alive) setSegments(rows); })
            .catch(() => {})
            .finally(() => { if (alive) setTranscriptLoading(false); });
        return () => { alive = false; };
    }, [epId]);

    useEffect(() => {
        const st = { timer: null, last: 0 };
        const fetchNow = () => {
            st.last = Date.now();
            refetchTranscript();
        };
        const schedule = (immediate) => {
            if (immediate) {
                if (st.timer) { clearTimeout(st.timer); st.timer = null; }
                fetchNow();
                return;
            }
            if (st.timer) return;
            const wait = Math.max(0, LIVE_REFETCH_MIN_MS - (Date.now() - st.last));
            st.timer = setTimeout(() => { st.timer = null; fetchNow(); }, wait);
        };
        const unsub = onLibraryChange((payload) => {
            if (!payload || payload.episodeId !== epId) return;
            if (payload.type === 'transcript-progress') {
                schedule(false);
            } else if (payload.type === 'transcript-complete') {
                schedule(true);
                getEpisodeById(epId).then(row => { if (row) setEp(row); }).catch(() => {});
            } else if (payload.type === 'transcript-error') {
                setTranscribing(false);
            } else if (payload.type === 'episode-delete') {
                // The finished-episode prompt (or the Library) removed this
                // episode's download and transcript and reset the player —
                // there is nothing left to show or play here.
                if (navigation.canGoBack()) navigation.goBack();
            }
        });
        return () => {
            unsub();
            if (st.timer) clearTimeout(st.timer);
        };
    }, [epId, refetchTranscript, navigation]);

    // ── Transcription queue state for this episode ────────────────────────────
    const syncQueue = useCallback(() => {
        const active = getActiveId() === epId && getAbortingId() !== epId;
        const queued = getQueueIds().includes(epId) && !active;
        setTranscribing(active || queued);
        setIsQueued(queued);
    }, [epId]);

    useEffect(() => {
        syncQueue();
        const unsubQueue = onQueueChange(syncQueue);
        const unsubProgress = onTranscriptProgress(({ episodeId, percent }) => {
            if (episodeId === epId) setTranscribeProgress(percent || 0);
        });
        return () => { unsubQueue(); unsubProgress(); };
    }, [syncQueue, epId]);

    const handleTranscribe = useCallback(async () => {
        const row = epRef.current;
        if (!row?.local_audio_path) return;
        setTranscribeProgress(0);
        setTranscribing(true);
        try {
            await transcribeEpisode(row, { onStart: () => setTranscribing(true) });
            refetchTranscript();
            getEpisodeById(epId).then(r => { if (r) setEp(r); }).catch(() => {});
        } catch (e) {
            reportTranscriptionError(e);
        } finally {
            syncQueue();
        }
    }, [epId, refetchTranscript, syncQueue]);

    // Streamed episode (no file on disk): download it from here and the
    // transcription queues itself (episodeService), so the card goes
    // Downloading → Queued → Transcribing → text without leaving the Player.
    // Playback keeps streaming; the local file is used from the next load.
    // The queue-change subscription above picks up the new job.
    const handleDownload = useCallback(async () => {
        const row = epRef.current;
        if (!row?.audio_url || downloadingIdRef.current) return;
        const id = row.id;
        downloadingIdRef.current = id;
        setDownloadProgress(0);
        setDownloadingId(id);
        try {
            await downloadEpisode(row, {
                onProgress: (p) => {
                    const pct = Math.round(p);
                    setDownloadProgress(prev => (prev === pct ? prev : pct));
                },
            });
            const fresh = await getEpisodeById(id);
            if (fresh && epRef.current?.id === id) setEp(fresh);
        } catch (e) {
            reportDownloadError(e);
        } finally {
            downloadingIdRef.current = null;
            setDownloadingId(prev => (prev === id ? null : prev));
        }
    }, []);

    // ── Controls wiring ───────────────────────────────────────────────────────
    const handleReplaySentence = useCallback(() => {
        transcriptRef.current?.replaySentence();
    }, []);

    const hasTranscript = !!ep?.has_transcript || segments.length > 0;
    const canTranscribe = !!ep?.local_audio_path;
    // Artwork-derived accent only when it contrasts with the page: bright tints
    // on the dark player, dark tints on the paper one.
    const accent = colorInfo && colorInfo.isDark !== isDark ? colorInfo.bgColor : colors.accent;
    // The header gets a softened version of the cover colour (hue kept,
    // saturation capped, lightness pinned to a theme band) — the raw colour
    // was fine as an accent but far too loud as a full-width surface.
    const headerTint = colorInfo ? softenForHeader(colorInfo.bgColor, isDark) : null;
    const headerBg = headerTint?.hex ?? colors.surfaceElevated;
    // Header text must read against the artwork tint, not the theme. The dark
    // theme keeps its always-white text; paper flips to cream on dark tints.
    // The drop-shadow exists only to lift text off a dark tint, so it is
    // *added* there rather than removed elsewhere: on Android a
    // `textShadowColor: 'transparent'` override still drew the default dark
    // shadow, which is what smudged the Paper header.
    const headerIsDark = headerTint ? headerTint.isDark : isDark;
    const headerFg = !isDark && headerIsDark ? colors.onAccent : colors.textPrimary;
    const headerTextStyle = [
        { color: headerFg },
        headerIsDark && styles.headerTextShadow,
    ];
    const downloading = downloadingId === epId;

    return (
        <View style={styles.root}>

            {/* ── Header — artwork-tinted single colour, compact row ────── */}
            <View
                style={[
                    styles.header,
                    { backgroundColor: headerBg, paddingTop: insets.top + 8 },
                ]}
            >
                {ep.image_url ? (
                    <Image source={{ uri: ep.image_url }} style={styles.artwork} />
                ) : (
                    <View style={[styles.artwork, styles.artworkPlaceholder]}>
                        <Icon name='headphones' size={20} color={withAlpha(headerFg, 0.25)} />
                    </View>
                )}

                <View style={styles.meta}>
                    <Text style={[styles.podcastName, headerTextStyle, { color: withAlpha(headerFg, 0.6) }]} numberOfLines={1}>
                        {ep.podcast_title}
                    </Text>
                    <Text style={[styles.episodeTitle, headerTextStyle]} numberOfLines={2}>
                        {ep.title}
                    </Text>
                </View>
            </View>

            {/* ── Transcript ────────────────────────────────────────────── */}
            <View style={styles.transcriptArea}>
                <TranscriptHighlighter
                    ref={transcriptRef}
                    segments={segments}
                    fadeTo={colors.bgPlayer}
                    loading={transcriptLoading && hasTranscript}
                    hasTranscript={hasTranscript}
                    canTranscribe={canTranscribe}
                    onTranscribe={handleTranscribe}
                    onDownload={handleDownload}
                    downloading={downloading}
                    downloadProgress={downloadProgress}
                    transcribing={transcribing}
                    isQueued={isQueued}
                    transcribeProgress={transcribeProgress}
                    playbackRate={playbackRate}
                    episodeId={epId}
                    episodeTitle={ep.title}
                />

                {audioError ? (
                    <TouchableOpacity
                        style={styles.loadingBadge}
                        onPress={startAudio}
                        accessibilityRole='button'
                        accessibilityLabel='Audio failed to load, tap to retry'
                    >
                        <Icon name='alert-circle' size={14} color={colors.danger} />
                        <Text style={styles.loadingText}>Audio unavailable — tap to retry</Text>
                    </TouchableOpacity>
                ) : audioStatus !== '' && (
                    <View style={styles.loadingBadge}>
                        <ActivityIndicator size='small' color={colors.accent} />
                        <Text style={styles.loadingText}>{audioStatus}</Text>
                    </View>
                )}
            </View>

            {/* ── Controls ──────────────────────────────────────────────── */}
            <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom + 8, 24) }]}>
                <TouchableOpacity
                    onPress={() => navigation.goBack()}
                    style={styles.dismissBtn}
                    hitSlop={{ top: 10, bottom: 10, left: 40, right: 40 }}
                >
                    <Icon name='chevron-down' size={28} color={withAlpha(colors.textPrimary, 0.5)} />
                </TouchableOpacity>
                <PlayerControls
                    accent={accent}
                    onReplaySentence={handleReplaySentence}
                    onRateChange={setPlaybackRate}
                />
            </View>

        </View>
    );
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (colors) => StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: colors.bgPlayer,
    },

    // ── Header ────────────────────────────────────────────────
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 26,
        paddingRight: 18,
        paddingBottom: 14,
        gap: 12,
        shadowColor: 'black',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 6,
    },
    artwork: {
        width: 56,
        height: 56,
        borderRadius: 10,
        backgroundColor: withAlpha(colors.textPrimary, 0.1),
    },
    artworkPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    meta: {
        flex: 1,
        gap: 3,
    },
    podcastName: {
        fontSize: 12,
        fontWeight: '700',
        color: withAlpha(colors.textPrimary, 0.6),
        textTransform: 'uppercase',
        letterSpacing: 0.7,
    },
    episodeTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.textPrimary,
        lineHeight: 21,
        letterSpacing: -0.2,
    },
    // Only on dark header tints (see headerTextStyle).
    headerTextShadow: {
        textShadowColor: 'rgba(0,0,0,0.35)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },

    // ── Transcript ────────────────────────────────────────────
    transcriptArea: {
        flex: 1,
        backgroundColor: colors.bgPlayer,
    },
    loadingBadge: {
        position: 'absolute',
        bottom: 16,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: withAlpha(colors.bgPlayer, 0.92),
        paddingHorizontal: 16,
        paddingVertical: 9,
        borderRadius: radii.pill,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    loadingText: {
        fontSize: 13,
        color: colors.textSecondary,
    },

    // ── Controls ──────────────────────────────────────────────
    controls: {
        paddingTop: 8,
        backgroundColor: colors.bgPlayer,
        borderTopWidth: 0.5,
        borderTopColor: colors.hairlineFaint,
    },
    dismissBtn: {
        alignSelf: 'center',
        paddingVertical: 4,
        marginBottom: 0,
    },
});

export default PlayerScreen;
