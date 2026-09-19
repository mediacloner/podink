/**
 * radioService — one live-radio listening session at a time (4.0.0).
 *
 * Two ways to listen to a station:
 *
 *   'live'        the station's own stream, played as it comes: no recorder,
 *                 no delay and no past to seek into — play, pause, stop. The
 *                 programme guide is shown instead of a transcript. Tapping a
 *                 station in the list starts this way.
 *
 *   'transcript'  the native LiveRadio recorder rewrites the stream as a local
 *                 HLS event playlist (segments of exact, frame-counted length)
 *                 and hands every ~24 s of audio to the on-device speech
 *                 engine. Text is saved into the session's Episode row like any
 *                 podcast transcript, so the Player, the word cards and the
 *                 vocabulary all work unchanged. Playback starts once the first
 *                 window has text and FOLLOW_DELAY_SEC (40 s) is buffered, and
 *                 the user can rewind / skip through everything recorded, or
 *                 jump to "live" (FOLLOW_DELAY_SEC behind the air).
 *
 *                 A live session becomes a transcript session in place
 *                 (switchToTranscript — the Player's Transcription button):
 *                 the stream keeps playing while the recorder gathers its
 *                 first FOLLOW_DELAY_SEC and the engine reads the first
 *                 window, then playback moves to the recording — about that
 *                 far back, with the words on screen. Same session, same row.
 *
 * (From 2026-09-07 to 2026-09-19 'live' was recorded too — playback 20 s
 * behind the air so the listener could pause, rewind and catch up. Dropped
 * on the user's ask for a station that plays at once, with no recorder and
 * no delay, and a transcript that starts from the player when wanted.)
 *
 * A session is an Episode row of a `radio://<station>` Podcasts row (kind
 * 'radio'); it is deleted, files and all, when the session ends, and any
 * leftovers are swept at launch. Saved vocabulary keeps its copy of the words.
 */
import { useEffect, useState } from 'react';
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import TrackPlayer, { Event, State } from 'react-native-track-player';
import { Directory, File, Paths } from 'expo-file-system';
import {
    deleteAllRadioEpisodes, deleteEpisodeRow, finalizeTranscript, getEpisodeById,
    insertRadioEpisode, saveRadioStation, saveTranscriptsIncremental, updateRadioEpisodeLocalPath,
    updateRadioEpisodeProgramme,
} from '../database/queries';
import {
    dequeueTranscription, enqueueTranscription, ensureEngine, getActiveId, getConfiguredModelKey,
    getNativeRecognizer, holdQueue, keepTranscriptionServiceAlive, releaseQueue, stopTranscriptionService,
} from './whisperService';
import { isSherpaModelDownloaded } from './downloadService';
import { ensurePlayerAlive, loadEpisodeTrack, notifyUserStop, onTrackLoad, onUserStop } from './trackPlayer';
import { setRemoteSeekLimit } from './playbackService';
import { notifyLibraryChange } from './libraryEvents';
import { USER_AGENT } from '../api/userAgent';
import { getStation, stationFeedUrl, stationTitle } from './radioStations';
import { fetchGuide, hasGuide } from './radioSchedule';
import { log } from './logService';

const LiveRadio = Platform.OS === 'android' ? NativeModules.LiveRadio : null;

// Recorder geometry. 6 s segments keep the playlist responsive; 4 of them
// make a ~24 s window — under the engine's 29 s single-window limit, so each
// is decoded in one pass with per-word timestamps.
const SEGMENT_SEC = 6;
const WINDOW_SEGMENTS = 4;
// How far behind the broadcast playback follows, in recorded seconds. Text
// arrives one ~24 s window at a time (plus its decode), so following any
// closer than a window + decode leaves nothing to read ahead just before the
// next window lands; 40 s keeps roughly 15–35 s of upcoming words on screen.
// (Was ~27 s — the moment the first window landed — until the user reported
// the text running out ahead of the playhead.)
export const FOLLOW_DELAY_SEC = 40;
// The text frontier is the end of the last transcribed window; the player is
// never sent closer to it than this, so a word is on screen.
const LIVE_LEAD_SEC = 1.5;
// Within this many seconds of the follow position the Player shows "LIVE".
export const LIVE_EDGE_SEC = 6;
const PROGRAMME_POLL_MS = 60 * 1000;
// A session left paused this long ends on its own (user, 2026-09-10: "I like
// 30 minutes of pause"). Until then a pause is just a pause — the recorder
// keeps the stream so you resume where you stopped and can catch up with
// LIVE. Past it, the segments on disk and (with a transcript) the speech
// engine decoding every 24 s are working for a listener who has moved on.
export const PAUSED_STOP_MS = 30 * 60 * 1000;
export const PAUSED_STOP_MIN = PAUSED_STOP_MS / 60000;
const RADIO_DIR = 'radio';

export const isRadioEpisode = (episode) => episode?.podcast_kind === 'radio' || String(episode?.id || '').startsWith('radio:');
export const isRadioAvailable = () => !!LiveRadio;

// ─── Session state ───────────────────────────────────────────────────────────

let _session = null;
let _starting = null; // in-flight startSession promise (double-tap guard)
const _listeners = new Set();
export const onRadioSessionChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };
const _notify = () => { const snap = _session ? { ..._session } : null; [..._listeners].forEach(fn => { try { fn(snap); } catch (_) {} }); };
export const getRadioSession = () => _session;

/** React view of the session (re-renders on every change). */
export const useRadioSession = () => {
    const [s, setS] = useState(_session);
    useEffect(() => onRadioSessionChange(setS), []);
    return s;
};

const setStatus = (status, statusMessage = '') => {
    if (!_session) return;
    _session.status = status;
    _session.statusMessage = statusMessage;
    _notify();
};

// ─── Model gate ──────────────────────────────────────────────────────────────

/** Whether "Listen with transcript" can run right now (speech model on device). */
export const isTranscriptionReady = async () => {
    if (!LiveRadio) return false;
    try { return await isSherpaModelDownloaded(await getConfiguredModelKey()); } catch (_) { return false; }
};

// ─── Programme guide ─────────────────────────────────────────────────────────

const refreshProgramme = async (force = false) => {
    const s = _session;
    if (!s) return;
    const station = getStation(s.stationId);
    const guide = await fetchGuide(station, { force });
    if (_session !== s) return;
    s.guide = guide;
    const now = currentProgramme(s);
    const title = now?.title || 'Live';
    if (title !== s.programmeTitle) {
        s.programmeTitle = title;
        try { await updateRadioEpisodeProgramme(s.episodeId, title, now?.description || ''); } catch (_) {}
        try {
            const track = await TrackPlayer.getActiveTrack();
            if (track?.id === s.episodeId) await TrackPlayer.updateNowPlayingMetadata({ title, artist: s.stationTitle });
        } catch (_) {}
        notifyLibraryChange({ type: 'radio-programme', episodeId: s.episodeId });
    }
    _notify();
};

// ─── Paused-session timeout ──────────────────────────────────────────────────
// Armed when the player reports Paused / Stopped for this session's track,
// disarmed by Playing. The timer is the usual path; the elapsed-time check
// also runs on every state change and programme poll, so a timer that a
// background-throttled JS clock fires late still ends the session promptly.
const pausedFor = (s) => (s.pausedAt ? Date.now() - s.pausedAt : 0);

const checkPausedStop = (s) => {
    if (_session !== s || !s.pausedAt || s.stopping) return false;
    if (pausedFor(s) < PAUSED_STOP_MS) return false;
    log('RADIO', 'Paused too long — session ends', { id: s.id, pausedMin: Math.round(pausedFor(s) / 60000) });
    stopSession();
    return true;
};

const armPausedStop = (s) => {
    if (s.pausedAt) return;
    s.pausedAt = Date.now();
    s.pausedTimer = setTimeout(() => { s.pausedTimer = null; checkPausedStop(s); }, PAUSED_STOP_MS + 500);
    _notify();
};

const disarmPausedStop = (s) => {
    if (!s.pausedAt) return;
    s.pausedAt = null;
    if (s.pausedTimer) { clearTimeout(s.pausedTimer); s.pausedTimer = null; }
    _notify();
};

/** The programme on air: the guide's, else the stream's ICY title. */
export const currentProgramme = (s = _session) => {
    if (!s) return null;
    if (s.guide?.now) return s.guide.now;
    if (s.icyTitle) return { title: s.icyTitle, subtitle: '', description: '', start: 0, end: 0 };
    return null;
};

const setIcyTitle = (title) => {
    const s = _session;
    if (!s || !title || title === s.icyTitle) return;
    s.icyTitle = title;
    log('RADIO', 'ICY title', { title });
    if (!hasGuide(getStation(s.stationId))) refreshProgramme();
    else _notify();
};

// ─── Transcription of recorder windows ───────────────────────────────────────

const wordsFromTokens = (tokens, timestamps, offsetMs) => {
    const starts = [];
    for (let i = 0; i < tokens.length; i++) {
        const raw = tokens[i] || '';
        if (!raw || raw.startsWith('<|')) continue;
        if (!starts.length || raw.startsWith(' ') || raw.startsWith('▁')) starts.push(i);
    }
    const out = [];
    for (let wi = 0; wi < starts.length; wi++) {
        const s = starts[wi];
        const e = wi + 1 < starts.length ? starts[wi + 1] : tokens.length;
        let txt = '';
        for (let j = s; j < e; j++) {
            const raw = tokens[j] || '';
            if (!raw.startsWith('<|')) txt += raw;
        }
        txt = txt.replace(/▁/g, ' ').trim();
        if (!txt) continue;
        const startMs = offsetMs + timestamps[s] * 1000;
        const endMs = e < timestamps.length
            ? offsetMs + timestamps[e] * 1000
            : offsetMs + (timestamps[timestamps.length - 1] + 0.3) * 1000;
        out.push({ start: Math.round(startMs), end: Math.round(endMs), text: txt });
    }
    return out;
};

const proportionalSegments = (text, offsetMs, durMs) => {
    if (!text || !text.trim()) return [];
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
    let at = 0;
    const out = [];
    for (const sentence of sentences) {
        const t = sentence.trim();
        const start = Math.round(offsetMs + (at / total) * durMs);
        at += sentence.length;
        const end = Math.round(offsetMs + (at / total) * durMs);
        if (t) out.push({ start, end: Math.max(end, start + 1), text: t });
    }
    return out;
};

/** Player segments from one window's recognition result, shifted to the
 *  window's place in the recording. */
const segmentsFromResult = (result, offsetMs, durMs) => {
    let segs;
    if (Array.isArray(result.segments) && result.segments.length) {
        segs = result.segments.map(s => ({
            start: Math.round(offsetMs + s.startMs), end: Math.round(offsetMs + s.endMs), text: String(s.text || '').trim(),
        }));
    } else if (Array.isArray(result.tokens) && Array.isArray(result.timestamps) && result.timestamps.length) {
        segs = wordsFromTokens(result.tokens, result.timestamps, offsetMs);
    } else {
        const realDur = result.samplesLength && result.sampleRate ? (result.samplesLength / result.sampleRate) * 1000 : durMs;
        segs = proportionalSegments(result.text, offsetMs, realDur || durMs);
    }
    return segs.filter(s => s.text.length > 0);
};

let _windowChain = Promise.resolve();

const transcribeWindow = async (s, w) => {
    const native = getNativeRecognizer();
    if (!native) throw new Error('Windowed recognition is not available on this build');
    await ensureEngine(true);
    if (_session !== s) return;
    keepTranscriptionServiceAlive('Live radio', `Transcribing ${s.stationName}…`);
    const jobId = `radio:${s.id}:${w.index}`;
    const t0 = Date.now();
    const result = await native.recognizeFromFileWithOptions(w.path, { startMs: 0, jobId, emitWindowEvents: false });
    if (_session !== s) return;
    if (!result?.success) throw new Error(result?.error || 'The speech engine returned no result');
    const offsetMs = Math.round(w.startSec * 1000);
    const segs = segmentsFromResult(result, offsetMs, Math.round(w.durationSec * 1000));
    if (segs.length) await saveTranscriptsIncremental(s.episodeId, segs);
    if (!s.hasText) {
        s.hasText = true;
        await finalizeTranscript(s.episodeId);
    }
    s.frontierSec = w.startSec + w.durationSec;
    s.windowsDone += 1;
    s.lastDecodeMs = Date.now() - t0;
    log('RADIO', 'Window transcribed', { index: w.index, words: segs.length, ms: s.lastDecodeMs, frontierSec: Math.round(s.frontierSec) });
    notifyLibraryChange({ type: 'transcript-progress', episodeId: s.episodeId, percent: 99 });
    _notify();
};

const onWindow = (w) => {
    const s = _session;
    if (!s || w.sessionId !== s.id) return;
    s.windowsSeen += 1;
    if (s.mode !== 'transcript') {
        // A window from a recorder already told to stop (the switch to a
        // transcript was undone): nothing wants it.
        try { new File(`file://${w.path}`).delete(); } catch (_) {}
        return;
    }
    _windowChain = _windowChain
        .then(() => transcribeWindow(s, w))
        .catch((e) => {
            if (_session !== s) return;
            s.transcriptError = e?.message || String(e);
            log('RADIO', 'Window transcription failed', { index: w.index, error: s.transcriptError });
            _notify();
        })
        .then(() => {
            try { new File(`file://${w.path}`).delete(); } catch (_) {}
            // The first window — text or failure — plus enough buffered audio
            // is what playback waits for; a broken engine must not leave the
            // user staring at "Buffering".
            if (_session === s) {
                s.firstWindowDone = true;
                maybeStartFollowing(s);
            }
        });
};

/**
 * Start playback of the recording from the top once FOLLOW_DELAY_SEC is on
 * disk and the first window has been transcribed, so the text stays ahead of
 * the playhead from the first second. A timer covers the gap when the
 * recorder is between segment events. (For a session switched from the live
 * stream this is the moment the sound moves from the stream to the
 * recording — about FOLLOW_DELAY_SEC back.)
 */
const maybeStartFollowing = (s) => {
    if (_session !== s || s.status !== 'buffering') return;
    if (!s.firstWindowDone) return;
    const need = FOLLOW_DELAY_SEC;
    // Seconds on disk, not airSec: the seconds since the last segment are not
    // in the playlist yet, and the whole head start must be there before the
    // player looks for its first segment.
    if (s.totalSec >= need) {
        if (s.startTimer) { clearTimeout(s.startTimer); s.startTimer = null; }
        startPlayback(s, 0);
        return;
    }
    // Segment events are what normally bring us back here; the timer covers
    // one that is missed, and re-checks rather than starting short.
    if (!s.startTimer) {
        s.startTimer = setTimeout(() => {
            s.startTimer = null;
            maybeStartFollowing(s);
        }, Math.max(500, (need - s.totalSec) * 1000 + 300));
    }
};

// ─── Playback ────────────────────────────────────────────────────────────────

const startPlayback = async (s, positionSec) => {
    try {
        setStatus('loading');
        const row = await getEpisodeById(s.episodeId);
        if (!row || _session !== s) return;
        await loadEpisodeTrack(row, false);
        if (_session !== s) return;
        // What the player holds now: the recording (seekable, LIVE pill) or
        // the stream itself. The Player's controls follow this, not the row.
        s.recordingLoaded = !!row.local_audio_path;
        if (positionSec != null) {
            try { await TrackPlayer.seekTo(Math.max(0, positionSec)); } catch (_) {}
        }
        await TrackPlayer.play();
        if (_session !== s) return;
        // The delay behind the broadcast at which playback started. Following
        // live keeps this delay; the Player's LIVE pill measures how far the
        // user is behind it.
        if (s.recordingLoaded && s.followDelaySec == null) {
            s.followDelaySec = Math.max(FOLLOW_DELAY_SEC, airSec(s) - (positionSec || 0));
        }
        setStatus('playing');
    } catch (e) {
        log('RADIO', 'Playback start failed', { error: e?.message || String(e) });
        if (_session === s) setStatus('error', `Playback failed: ${e?.message || e}`);
    }
};

/**
 * Called by the Player when it opens on the session's row: makes sure the
 * session is playing. While the recorder is still buffering the first window,
 * resolves once playback has started (or the session ends).
 */
export const attachPlayer = async () => {
    const s = _session;
    if (!s) return false;
    if (s.status === 'buffering' || s.status === 'loading' || s.status === 'starting') {
        await new Promise((resolve) => {
            const unsub = onRadioSessionChange((snap) => {
                if (!snap || snap.id !== s.id || snap.status === 'playing' || snap.status === 'error' || snap.status === 'ended') {
                    unsub();
                    resolve();
                }
            });
        });
        return _session === s;
    }
    try {
        const track = await TrackPlayer.getActiveTrack();
        if (track?.id !== s.episodeId) {
            await startPlayback(s, s.recordingLoaded ? livePositionSec(s) : null);
        }
    } catch (_) {}
    return _session === s;
};

/** Seconds of broadcast recorded so far, interpolated between segment
 *  events (one every ~6 s) so the number moves smoothly. */
export const airSec = (s = _session) => {
    if (!s) return 0;
    const since = s.lastSegmentAt ? (Date.now() - s.lastSegmentAt) / 1000 : 0;
    return s.totalSec + Math.min(Math.max(since, 0), SEGMENT_SEC);
};

/** The newest moment the player may be sent to: the newest moment that has
 *  text, minus a lead so a word is on screen. */
export const edgeSec = (s = _session) => (s ? Math.max(0, s.frontierSec - LIVE_LEAD_SEC) : 0);

/**
 * "Live" for a recorded session: the position that keeps the delay playback
 * started with — never past the edge. Before playback has started it is the
 * edge itself.
 */
export const livePositionSec = (s = _session) => {
    if (!s) return 0;
    const edge = edgeSec(s);
    if (s.followDelaySec == null) return edge;
    return Math.max(0, Math.min(airSec(s) - s.followDelaySec, edge));
};

/** Snapshot for the Player's controls (called on every progress tick). */
export const readLiveState = () => {
    const s = _session;
    if (!s) return null;
    return { followSec: livePositionSec(s), airSec: airSec(s), edgeSec: edgeSec(s), status: s.status };
};

/** Jump to live (the recording); on the stream itself just play. */
export const goLive = async () => {
    const s = _session;
    if (!s) return;
    if (!s.recordingLoaded) { try { await TrackPlayer.play(); } catch (_) {} return; }
    try {
        const track = await TrackPlayer.getActiveTrack();
        if (track?.id !== s.episodeId) { await startPlayback(s, livePositionSec(s)); return; }
        await TrackPlayer.seekTo(livePositionSec(s));
        await TrackPlayer.play();
    } catch (_) {}
};

// ─── Player error recovery (transcript sessions) ─────────────────────────────

let _recoveries = [];
const onPlaybackError = async (e) => {
    const s = _session;
    if (!s || !s.recordingLoaded) return;
    try {
        const track = await TrackPlayer.getActiveTrack();
        if (track?.id !== s.episodeId) return;
    } catch (_) { return; }
    const now = Date.now();
    _recoveries = _recoveries.filter(t => now - t < 60_000);
    if (_recoveries.length >= 3) {
        setStatus('error', `Playback failed: ${e?.message || 'the recording could not be played'}`);
        return;
    }
    _recoveries.push(now);
    log('RADIO', 'Playback error — re-attaching the recording', { message: e?.message, code: e?.code, at: s.lastPositionSec });
    await startPlayback(s, Math.min(s.lastPositionSec || 0, livePositionSec(s)));
};

// ─── The recorder (transcript sessions) ──────────────────────────────────────

let _subs = [];
const clearSubs = () => { for (const sub of _subs) { try { sub.remove ? sub.remove() : sub(); } catch (_) {} } _subs = []; };

/**
 * The engine gets the decoder to itself: the episode queue is held; the job
 * that was running is cancelled (its partial rows and resume marker stay)
 * and put straight back at the front of the held queue, so it shows as
 * queued while the radio plays and is the first to resume — from where it
 * stopped — when the session ends.
 */
const holdEpisodeQueue = async () => {
    holdQueue();
    const activeId = getActiveId();
    if (!activeId) return;
    let row = null;
    try { row = await getEpisodeById(activeId); } catch (_) {}
    dequeueTranscription(activeId);
    if (row?.local_audio_path) {
        enqueueTranscription(activeId, row.local_audio_path, null, null, row.duration || 0, { front: true }).catch(() => {});
    }
    log('RADIO', 'Paused the episode transcription', { activeId, requeued: !!row?.local_audio_path });
};

/**
 * The native recorder for a transcript session: its event listeners (kept
 * on the session too, so an undone switch can drop them alone), then the
 * recorder itself. Rejects when the recorder cannot start.
 */
const startRecorder = async (s, station, stream) => {
    const subs = [
        DeviceEventEmitter.addListener('LiveRadioSegment', (ev) => {
            if (_session !== s || ev?.sessionId !== s.id) return;
            s.totalSec = ev.totalSec || 0;
            s.lastSegmentAt = Date.now();
            s.recorderError = null;
            maybeStartFollowing(s);
            _notify();
        }),
        DeviceEventEmitter.addListener('LiveRadioWindow', onWindow),
        DeviceEventEmitter.addListener('LiveRadioMetadata', (ev) => {
            if (_session === s && ev?.sessionId === s.id) setIcyTitle(String(ev.title || '').trim());
        }),
        DeviceEventEmitter.addListener('LiveRadioError', (ev) => {
            if (_session !== s || ev?.sessionId !== s.id) return;
            log('RADIO', ev.fatal ? 'Recorder failed' : 'Recorder hiccup', { message: ev.message });
            if (!ev.fatal) { s.recorderError = ev.message || 'Reconnecting…'; _notify(); return; }
            const why = ev.message || 'The stream could not be recorded';
            // While the stream is still what plays (a switch whose recording
            // never started playing) the stream is a fine second best.
            if (!s.recordingLoaded) revertToStream(s, why);
            else setStatus('error', why);
        }),
        DeviceEventEmitter.addListener('LiveRadioStopped', (ev) => {
            if (_session !== s || ev?.sessionId !== s.id || s.stopping) return;
            if (s.status !== 'error') setStatus('ended', 'The stream ended');
        }),
    ];
    s.recorderSubs = subs;
    _subs.push(...subs);
    await LiveRadio.start({
        sessionId: s.id, url: stream.url, kind: stream.kind, dir: s.dirUri,
        segmentSec: SEGMENT_SEC, windowSegments: WINDOW_SEGMENTS, userAgent: USER_AGENT,
    });
    keepTranscriptionServiceAlive('Live radio', `Recording ${station.name}…`);
};

/**
 * A switch to a transcript undone before its recording was ever played (the
 * recorder would not start, or failed while buffering): the stream never
 * stopped, so the session is a live one again and `transcriptError` says
 * what happened. The recorder, its listeners, the held queue and the row's
 * playlist all go.
 */
const revertToStream = async (s, why) => {
    if (_session !== s) return;
    log('RADIO', 'Back to the stream — the transcript could not start', { why });
    for (const sub of s.recorderSubs) { try { sub.remove(); } catch (_) {} }
    _subs = _subs.filter(sub => !s.recorderSubs.includes(sub));
    s.recorderSubs = [];
    if (s.startTimer) { clearTimeout(s.startTimer); s.startTimer = null; }
    if (LiveRadio) { try { await LiveRadio.stop(s.id); } catch (_) {} }
    if (_session !== s) return;
    s.mode = 'live';
    s.buffered = false;
    s.playlistUri = null;
    s.recordingLoaded = false;
    s.followDelaySec = null;
    s.recorderError = null;
    s.transcriptError = why;
    setRemoteSeekLimit(null);
    releaseQueue();
    stopTranscriptionService();
    try { await updateRadioEpisodeLocalPath(s.episodeId, null); } catch (_) {}
    if (_session !== s) return;
    notifyLibraryChange({ type: 'radio-programme', episodeId: s.episodeId });
    setStatus('playing');
};

let _switching = null;

/**
 * Turn the live session into a transcript session, in place. The stream
 * keeps playing while the recorder gathers FOLLOW_DELAY_SEC and the engine
 * reads the first window; then playback moves to the recording — about that
 * far back — with the words on screen. Rejects with e.code
 * 'MODEL_NOT_DOWNLOADED' / 'UNSUPPORTED' like startSession; when the
 * recorder will not start the session goes back to the stream and the
 * rejection says why.
 */
export const switchToTranscript = () => {
    if (_switching) return _switching;
    _switching = _switchToTranscript().finally(() => { _switching = null; });
    return _switching;
};

const _switchToTranscript = async () => {
    const s = _session;
    if (!s) throw new Error('No station is playing');
    if (s.mode === 'transcript') return s;
    if (!LiveRadio) {
        const err = new Error('Live radio transcription needs the Android build');
        err.code = 'UNSUPPORTED';
        throw err;
    }
    if (!(await isTranscriptionReady())) {
        const err = new Error('The speech model is not downloaded');
        err.code = 'MODEL_NOT_DOWNLOADED';
        throw err;
    }
    if (_session !== s) throw new Error('The station stopped');
    const station = getStation(s.stationId);
    const stream = station.streams[0];
    s.mode = 'transcript';
    s.buffered = true;
    s.playlistUri = new File(new Directory(s.dirUri), 'live.m3u8').uri;
    s.transcriptError = null;
    s.recorderError = null;
    s.totalSec = 0;
    s.lastSegmentAt = 0;
    s.followDelaySec = null;
    s.recordingLoaded = false;
    s.frontierSec = 0;
    s.windowsSeen = 0;
    s.windowsDone = 0;
    s.hasText = false;
    s.firstWindowDone = false;
    log('RADIO', 'Switching to transcript', { id: s.id });
    try {
        await updateRadioEpisodeLocalPath(s.episodeId, s.playlistUri);
        if (_session !== s) return s;
        await holdEpisodeQueue();
        setRemoteSeekLimit(() => (_session === s ? edgeSec(s) : null));
        setStatus('buffering');
        await ensureEngine(true);
        if (_session !== s) return s;
        await startRecorder(s, station, stream);
        // The Player re-reads the row (its playlist path) on this.
        notifyLibraryChange({ type: 'radio-programme', episodeId: s.episodeId });
        return s;
    } catch (e) {
        const why = e?.message || String(e);
        log('RADIO', 'Switch to transcript failed', { error: why });
        if (_session === s) await revertToStream(s, why);
        throw e;
    }
};

// ─── Start / stop ────────────────────────────────────────────────────────────

/**
 * Start listening. mode 'live' | 'transcript'. Ends any running session
 * first. Rejects with e.code 'MODEL_NOT_DOWNLOADED' when a transcript was
 * asked for without a speech model on the device.
 */
export const startSession = (stationId, mode) => {
    if (_starting) return _starting;
    _starting = _startSession(stationId, mode).finally(() => { _starting = null; });
    return _starting;
};

const _startSession = async (stationId, mode) => {
    const station = getStation(stationId);
    if (!station) throw new Error(`Unknown station ${stationId}`);
    const stream = station.streams[0];
    if (mode === 'transcript') {
        if (!LiveRadio) {
            const err = new Error('Live radio transcription needs the Android build');
            err.code = 'UNSUPPORTED';
            throw err;
        }
        if (!(await isTranscriptionReady())) {
            const err = new Error('The speech model is not downloaded');
            err.code = 'MODEL_NOT_DOWNLOADED';
            throw err;
        }
    }
    if (_session) await stopSession();
    await ensurePlayerAlive();

    const startedAt = Date.now();
    const id = `${stationId}-${startedAt}`;
    const episodeId = `radio:${stationId}:${startedAt}`;
    const feedUrl = stationFeedUrl(stationId);
    const dir = new Directory(Paths.document, RADIO_DIR, id);
    // A transcript session plays the recorder's local playlist (`buffered`);
    // a live one plays the stream itself.
    const buffered = mode === 'transcript';
    const playlistUri = buffered ? new File(dir, 'live.m3u8').uri : null;

    const s = {
        id, stationId, stationName: station.name, stationTitle: stationTitle(station), mode, episodeId, feedUrl,
        startedAt, dirUri: dir.uri, playlistUri, buffered, streamUrl: stream.url,
        status: 'starting', statusMessage: '',
        guide: null, programmeTitle: null, icyTitle: null,
        totalSec: 0, lastSegmentAt: 0, followDelaySec: null, recordingLoaded: false, recorderSubs: [],
        frontierSec: 0, windowsSeen: 0, windowsDone: 0, hasText: false, firstWindowDone: false, startTimer: null,
        transcriptError: null, recorderError: null, lastDecodeMs: 0, lastPositionSec: 0,
        pausedAt: null, pausedTimer: null,
    };
    _session = s;
    _notify();
    log('RADIO', 'Session start', { stationId, mode, buffered, stream: stream.url });

    try {
        await saveRadioStation({ feed_url: feedUrl, title: s.stationTitle, description: station.blurb });
        // A first guide read names the row; a slow guide must not delay the audio.
        const guide = await Promise.race([
            fetchGuide(station).catch(() => null),
            new Promise(resolve => setTimeout(() => resolve(null), 4000)),
        ]);
        s.guide = guide;
        s.programmeTitle = guide?.now?.title || 'Live';
        await insertRadioEpisode({
            id: episodeId, title: s.programmeTitle, description: guide?.now?.description || '',
            podcast_title: s.stationTitle, podcast_feed_url: feedUrl, audio_url: stream.url, local_audio_path: playlistUri,
        });

        // Session-wide listeners.
        _subs.push(onTrackLoad((episode) => {
            if (_session === s && episode?.id !== s.episodeId) stopSession({ keepPlayer: true });
        }));
        _subs.push(onUserStop(() => { if (_session === s) stopSession({ keepPlayer: true }); }));
        _subs.push(TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, (e) => {
            if (_session === s && e?.position > 0) s.lastPositionSec = e.position;
        }));
        _subs.push(TrackPlayer.addEventListener(Event.PlaybackError, onPlaybackError));
        // Pause / resume of this session's track: see the paused-session
        // timeout above. Only this track counts — the Stopped that a reset
        // emits while the station is still loading has no track yet, and a
        // different episode replacing the station is onTrackLoad's business.
        _subs.push(TrackPlayer.addEventListener(Event.PlaybackState, async ({ state }) => {
            if (_session !== s) return;
            // A stall while following is what the listener hears as a cut;
            // record where it happened against what the player had loaded.
            if (state === State.Buffering && s.status === 'playing') {
                try {
                    const p = await TrackPlayer.getProgress();
                    log('RADIO', 'Player buffering', { position: Math.round(p.position), buffered: Math.round(p.buffered), recorded: Math.round(s.totalSec) });
                } catch (_) {}
            }
            if (state === State.Paused || state === State.Stopped) {
                let track = null;
                try { track = await TrackPlayer.getActiveTrack(); } catch (_) {}
                if (_session === s && track?.id === s.episodeId) armPausedStop(s);
            } else if (state === State.Playing || state === State.Buffering || state === State.Loading) {
                disarmPausedStop(s);
            }
            checkPausedStop(s);
        }));
        const onMeta = (e) => {
            const title = e?.metadata?.title ?? e?.title;
            if (_session === s && s.mode === 'live' && typeof title === 'string') setIcyTitle(title.trim());
        };
        _subs.push(TrackPlayer.addEventListener(Event.MetadataCommonReceived, onMeta));
        _subs.push(TrackPlayer.addEventListener(Event.PlaybackMetadataReceived, onMeta));
        s.programmeTimer = setInterval(() => { if (!checkPausedStop(s)) refreshProgramme(); }, PROGRAMME_POLL_MS);
        if (!guide) refreshProgramme();

        if (!buffered) {
            // The stream itself: playing at once, nothing to seek.
            await startPlayback(s, null);
            return s;
        }

        await holdEpisodeQueue();
        // The notification's skip-forward and seek bar stop at the edge, like
        // the Player's own controls.
        setRemoteSeekLimit(() => (_session === s ? edgeSec(s) : null));
        setStatus('buffering');
        await ensureEngine(true);
        if (_session !== s) return s;
        await startRecorder(s, station, stream);
        return s;
    } catch (e) {
        log('RADIO', 'Session start failed', { error: e?.message || String(e) });
        if (_session === s) await stopSession();
        throw e;
    }
};

/**
 * End the session: recorder, player (unless the caller is loading something
 * else), rows, files. Broadcasts 'unsubscribe' for the row so an open Player
 * leaves. The paused episode transcription resumes.
 */
export const stopSession = async ({ keepPlayer = false } = {}) => {
    const s = _session;
    if (!s || s.stopping) return;
    s.stopping = true;
    _session = null;
    _notify();
    log('RADIO', 'Session stop', { id: s.id, totalSec: Math.round(s.totalSec), windows: s.windowsDone });
    if (s.programmeTimer) clearInterval(s.programmeTimer);
    if (s.startTimer) clearTimeout(s.startTimer);
    if (s.pausedTimer) clearTimeout(s.pausedTimer);
    clearSubs();

    if (s.buffered && LiveRadio) {
        try { await LiveRadio.stop(s.id); } catch (_) {}
    }
    if (!keepPlayer) {
        try {
            const track = await TrackPlayer.getActiveTrack();
            if (track?.id === s.episodeId) {
                await TrackPlayer.reset();
                notifyUserStop();
            }
        } catch (_) {}
    }
    try { await deleteEpisodeRow(s.episodeId); } catch (_) {}
    try { new Directory(s.dirUri).delete(); } catch (_) {}
    notifyLibraryChange({ type: 'unsubscribe', feedUrl: s.feedUrl, episodeIds: [s.episodeId] });

    setRemoteSeekLimit(null);
    // The held queue runs again — the job the session interrupted first.
    if (s.mode === 'transcript') releaseQueue();
    stopTranscriptionService();
};

/** Launch hygiene: no session survives a restart — rows and files go. */
export const sweepRadioSessions = async () => {
    try { await deleteAllRadioEpisodes(); } catch (_) {}
    try {
        const dir = new Directory(Paths.document, RADIO_DIR);
        if (dir.exists) dir.delete();
    } catch (_) {}
};
