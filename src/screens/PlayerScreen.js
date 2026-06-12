import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View, StyleSheet, Text, Image,
    ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import PlayerControls from '../components/PlayerControls';
import TranscriptHighlighter from '../components/TranscriptHighlighter';
import { showAlert } from '../components/AppAlert';
import { loadEpisodeTrack } from '../services/trackPlayer';
import { onLibraryChange } from '../services/libraryEvents';
import {
    enqueueTranscription, getAbortingId, getActiveId,
    getQueueIds, onQueueChange, onTranscriptProgress,
} from '../services/whisperService';
import { getEpisodeById, getTranscriptsForEpisode, savePlayPosition } from '../database/queries';
import { extractColor } from '../services/colorExtractor';
import { colors, radii, withAlpha } from '../theme';

// Minimum gap between transcript re-fetches while live transcription streams
// 'transcript-progress' events — keeps chunk rebuilds >= 1.5s apart.
const LIVE_REFETCH_MIN_MS = 1500;

const PlayerScreen = ({ route, navigation }) => {
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
    const [colorInfo, setColorInfo] = useState(null);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [transcribing, setTranscribing] = useState(false);
    const [isQueued, setIsQueued] = useState(false);
    const [transcribeProgress, setTranscribeProgress] = useState(0);
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

        (async () => {
            try {
                setAudioStatus('Preparing audio…');
                const fresh = await getEpisodeById(epId);
                const row = fresh || episodeParam;
                if (alive) setEp(row);

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
                    } else if (row.play_position > 0) {
                        await TrackPlayer.seekTo(row.play_position);
                    }
                }

                if (alive) setAudioStatus('');
                if (!alreadyLoaded) await TrackPlayer.play();
                if (alive) {
                    playerReadyRef.current = true;
                    setPlayerReady(true);
                }
            } catch (e) {
                console.error('Playback setup failed', e);
                if (alive) {
                    setAudioStatus('');
                    playerReadyRef.current = true;
                    setPlayerReady(true);
                }
            }
        })();

        return () => { alive = false; };
    }, [epId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Flush one final play position on unmount; periodic saves are owned by
    // playbackService (PlaybackProgressUpdated) — no interval here.
    useEffect(() => () => {
        (async () => {
            try {
                const [progress, track] = await Promise.all([
                    TrackPlayer.getProgress(),
                    TrackPlayer.getActiveTrack(),
                ]);
                if (track?.id === epId && progress.position > 0) {
                    await savePlayPosition(epId, Math.floor(progress.position));
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
            }
        });
        return () => {
            unsub();
            if (st.timer) clearTimeout(st.timer);
        };
    }, [epId, refetchTranscript]);

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
            await enqueueTranscription(
                epId,
                row.local_audio_path,
                () => {},
                () => setTranscribing(true),
                row.duration || 0,
            );
            refetchTranscript();
            getEpisodeById(epId).then(r => { if (r) setEp(r); }).catch(() => {});
        } catch (e) {
            const msg = e?.message || String(e);
            if (msg !== 'Cancelled' && msg !== 'Already queued' && msg !== 'Queue reset') {
                const isAudioError = /audio file|unrecognized header/i.test(msg);
                showAlert(
                    isAudioError ? 'Invalid Audio File' : 'Transcription Failed',
                    isAudioError
                        ? 'This audio file appears to be corrupted or missing. Try deleting and re-downloading the episode.'
                        : 'Could not transcribe this episode. Make sure the AI model is downloaded in Settings.',
                );
            }
        } finally {
            syncQueue();
        }
    }, [epId, refetchTranscript, syncQueue]);

    // ── Controls wiring ───────────────────────────────────────────────────────
    const handleReplaySentence = useCallback(() => {
        transcriptRef.current?.replaySentence();
    }, []);

    const hasTranscript = !!ep?.has_transcript || segments.length > 0;
    const canTranscribe = !!ep?.local_audio_path;
    // Artwork-derived accent only when bright enough to read on the dark player.
    const accent = colorInfo && !colorInfo.isDark ? colorInfo.bgColor : colors.accent;
    const headerBg = colorInfo?.bgColor ?? colors.surfaceElevated;

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
                        <Icon name='headphones' size={20} color={withAlpha(colors.textPrimary, 0.25)} />
                    </View>
                )}

                <View style={styles.meta}>
                    <Text style={styles.podcastName} numberOfLines={1}>
                        {ep.podcast_title}
                    </Text>
                    <Text style={styles.episodeTitle} numberOfLines={2}>
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
                    transcribing={transcribing}
                    isQueued={isQueued}
                    transcribeProgress={transcribeProgress}
                    playbackRate={playbackRate}
                    episodeId={epId}
                    episodeTitle={ep.title}
                />

                {audioStatus !== '' && (
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

const styles = StyleSheet.create({
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
        width: 52,
        height: 52,
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
        fontSize: 11,
        fontWeight: '700',
        color: withAlpha(colors.textPrimary, 0.6),
        textTransform: 'uppercase',
        letterSpacing: 0.7,
        textShadowColor: 'rgba(0,0,0,0.35)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    episodeTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: colors.textPrimary,
        lineHeight: 19,
        letterSpacing: -0.1,
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
