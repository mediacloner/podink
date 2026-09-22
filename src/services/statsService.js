/**
 * What was really listened to, and what the paid passes cost (5.1.0,
 * screens/StatsScreen.js).
 *
 * The meter. Everything else in the app records *where* a listener is in an
 * episode — play_position, last_played_at — which says nothing about how much
 * of it went past their ears: a resumed episode, a skipped advert, twenty
 * minutes of the same five minutes replayed all leave the same trace. So the
 * player's own progress ticks are counted here instead. A tick adds the audio
 * that actually advanced since the last one (a jump forward is a seek, not
 * listening; a gap longer than a few seconds is the app having been away) and
 * the real time it took, which at 1.15× is the shorter of the two. The
 * running total is written to ListeningLog every half minute and whenever the
 * audio stops, so a process killed mid-episode loses seconds, not the session.
 *
 * Live radio is counted under the station rather than the session: a session
 * id changes every time the station is opened and its row is deleted at the
 * next launch, so 'radio:<station>' is the only key that can be added up over
 * a week.
 *
 * The ledger. Every paid request the app makes writes a row of its own
 * (queries.recordApiSpend) — the assistant, the punctuation pass, a cloud
 * transcription, a comparison — with the tokens or the audio seconds it was
 * billed for. This module only reads them back.
 *
 * Before the ledgers existed there is only what the library remembers: an
 * episode heard to the end counts its length, one in progress its position,
 * both on the day they were last played, and an assistant run is priced from
 * the model that wrote it and the length of the episode. Those figures are
 * marked `estimated` all the way to the screen, which says so. The boundary
 * (StatsMeta.since) keeps the two from ever counting the same listening
 * twice.
 */
import {
    addListeningTime, getApiSpend, getEpisodeById, getEstimatedAssistantRuns,
    getEstimatedListeningHistory, getFinishedByDay, getListeningLog, getStatsSince,
} from '../database/queries';
import { estimateEpisodeDollars } from './aiService';

// ─── Days ────────────────────────────────────────────────────────────────────
// Everything is filed under the device's own day, the way the listener lived
// it; SQL does the same with 'localtime'.

export const dayKey = (ts = Date.now()) => {
    const d = new Date(ts);
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
};

/** The last `n` days as keys, oldest first, ending today. */
export const lastDays = (n) => {
    const out = [];
    const d = new Date();
    d.setHours(12, 0, 0, 0);            // midday: immune to daylight saving
    for (let i = n - 1; i >= 0; i--) {
        const t = new Date(d);
        t.setDate(d.getDate() - i);
        out.push(dayKey(t.getTime()));
    }
    return out;
};

export const monthKey = (day) => String(day || '').slice(0, 7);

/** The last `n` months as keys, oldest first, ending this month. */
export const lastMonths = (n) => {
    const out = [];
    const d = new Date();
    d.setDate(15);
    for (let i = n - 1; i >= 0; i--) {
        const t = new Date(d);
        t.setMonth(d.getMonth() - i);
        out.push(dayKey(t.getTime()).slice(0, 7));
    }
    return out;
};

// ─── The meter ───────────────────────────────────────────────────────────────

// A tick a second is what the player is asked for (trackPlayer.js), but a
// backgrounded process gets them when Android feels like it, and listening
// with the screen off is still listening — so a gap of up to a quarter of a
// minute is taken at face value as long as the audio moved with it.
const MAX_TICK_SEC = 15;
const MAX_SPEED = 4;         // a bigger jump in the position is a skip, not speed
const FLUSH_AFTER_SEC = 30;  // how much may be lost if the process is killed

let spell = null;            // the stretch being counted, or null

const radioStationOf = (track) => {
    if (track?.stationId) return String(track.stationId);
    const id = String(track?.id || '');
    return id.startsWith('radio:') ? id.split(':')[1] || null : null;
};

/** The episode's kind and titles, once per spell — a radio track carries its
 *  own, and a track whose row has gone (a deleted episode still playing)
 *  keeps what the player knows. */
const resolveSpell = async (trackId) => {
    try {
        const ep = await getEpisodeById(trackId);
        if (!ep || !spell || spell.trackId !== trackId) return;
        spell.kind = ep.podcast_kind || 'rss';
        spell.feedUrl = ep.podcast_feed_url || null;
        spell.title = ep.title || spell.title;
        spell.source = ep.podcast_title || spell.source;
    } catch (_) {}
};

const startSpell = (track, position, now) => {
    const station = radioStationOf(track);
    spell = {
        trackId: String(track.id),
        itemId: station ? `radio:${station}` : String(track.id),
        day: dayKey(now),
        kind: station ? 'radio' : 'rss',
        title: track.title || null,
        source: track.artist || null,
        feedUrl: station ? `radio://${station}` : null,
        pos: Number(position) || 0,
        ts: now,
        audio: 0,
        real: 0,
    };
    if (!station) resolveSpell(spell.trackId);
};

const write = async (s, seconds, realSeconds, at) => {
    if (seconds <= 0 && realSeconds <= 0) return;
    try {
        await addListeningTime({
            day: s.day, itemId: s.itemId, kind: s.kind, title: s.title, source: s.source,
            feedUrl: s.feedUrl, seconds, realSeconds, at,
        });
    } catch (_) {}
};

/** Writes what has been counted so far. `keep` leaves the spell open (the
 *  half-minute flush); without it the spell ends, so the next tick starts a
 *  fresh one and the pause in between is counted as nothing. */
export const flushListening = (keep = false) => {
    const s = spell;
    if (!s) return Promise.resolve();
    const { audio, real } = s;
    s.audio = 0;
    s.real = 0;
    if (!keep) spell = null;
    return write(s, audio, real, Date.now());
};

/**
 * One progress tick from the player (services/playbackService.js), which
 * fires about every second while — and only while — audio is actually
 * playing. `track` is the active track, `position` its position in seconds.
 */
export const noteProgress = (track, position) => {
    if (!track?.id) return;
    const now = Date.now();
    const pos = Number(position) || 0;
    if (!spell || spell.trackId !== String(track.id) || spell.day !== dayKey(now)) {
        // A new episode, or midnight passed mid-episode: the finished stretch
        // belongs to the day it was heard in.
        flushListening();
        startSpell(track, pos, now);
        return;
    }
    const wall = (now - spell.ts) / 1000;
    const heard = pos - spell.pos;
    spell.ts = now;
    spell.pos = pos;
    // What the tick is allowed to be worth. A position that went backwards or
    // stood still is a rewind or a stall; one that jumped further than playing
    // could have carried it is a skip; a long gap since the last tick is the
    // app having been away. None of them is listening, and none of them can be
    // told apart well enough to count a fraction of, so the tick counts as
    // nothing — at most a second lost at each skip.
    if (wall <= 0 || wall > MAX_TICK_SEC || heard <= 0 || heard > wall * MAX_SPEED) return;
    spell.real += wall;
    spell.audio += heard;
    if (spell.real >= FLUSH_AFTER_SEC) flushListening(true);
};

// ─── Reading it back ─────────────────────────────────────────────────────────

/** Everything the statistics screen needs, measured and estimated together —
 *  a few hundred rows at most, so the screen slices and adds them up itself. */
export const loadStats = async () => {
    const since = (await getStatsSince()) || Date.now();
    const [log, spendRows, finished, pastListening, pastRuns] = await Promise.all([
        getListeningLog(),
        getApiSpend(),
        getFinishedByDay(),
        getEstimatedListeningHistory(since),
        getEstimatedAssistantRuns(since),
    ]);

    const listening = [
        ...log.map(r => ({
            day: r.day,
            kind: r.kind || 'rss',
            title: r.title || '',
            source: r.source || r.title || 'Unknown',
            seconds: Number(r.seconds) || 0,
            realSeconds: Number(r.real_seconds) || 0,
            estimated: false,
        })),
        ...pastListening.map(r => ({
            day: r.day,
            kind: r.kind || 'rss',
            title: '',
            source: r.source || 'Unknown',
            seconds: Number(r.seconds) || 0,
            realSeconds: Number(r.seconds) || 0,
            estimated: true,
        })),
    ].filter(r => r.day && r.seconds > 0);

    const spend = [
        ...spendRows.map(r => ({
            at: Number(r.at) || 0,
            day: r.day,
            provider: r.provider,
            service: r.service,
            model: r.model || '',
            episodeTitle: r.episode_title || '',
            source: r.source || '',
            tokensIn: Number(r.tokens_in) || 0,
            tokensOut: Number(r.tokens_out) || 0,
            audioSeconds: r.audio_seconds == null ? null : Number(r.audio_seconds),
            cost: Number(r.cost_usd) || 0,
            estimated: false,
        })),
        ...pastRuns.map(r => ({
            at: Number(r.at) || 0,
            day: r.day,
            provider: 'openai',
            service: 'assistant',
            model: r.model || '',
            episodeTitle: r.episode_title || '',
            source: r.source || '',
            tokensIn: 0,
            tokensOut: 0,
            audioSeconds: null,
            cost: estimateEpisodeDollars(r.model, Number(r.duration) || 0),
            estimated: true,
        })),
    ].filter(r => r.day).sort((a, b) => b.at - a.at);

    return {
        since,
        listening,
        spend,
        finished: finished.filter(r => r.day).map(r => ({ day: r.day, episodes: Number(r.episodes) || 0 })),
    };
};

// ─── Adding it up ────────────────────────────────────────────────────────────

const inRange = (day, from) => !from || day >= from;

/** Listening totals over the days from `from` (a day key) onward. */
export const listeningTotals = (rows, from) => {
    let seconds = 0, real = 0, estimated = 0;
    const days = new Set();
    for (const r of rows) {
        if (!inRange(r.day, from)) continue;
        seconds += r.seconds;
        real += r.realSeconds;
        if (r.estimated) estimated += r.seconds;
        days.add(r.day);
    }
    return { seconds, real, estimated, days: days.size };
};

/** Seconds per bucket, for the chart: `keys` are the day (or month) keys to
 *  draw, in order, and each carries how much of it is an estimate. */
export const bucketed = (rows, keys, byMonth = false) => {
    const index = new Map(keys.map(k => [k, { key: k, seconds: 0, estimated: 0 }]));
    for (const r of rows) {
        const bucket = index.get(byMonth ? monthKey(r.day) : r.day);
        if (!bucket) continue;
        bucket.seconds += r.seconds;
        if (r.estimated) bucket.estimated += r.seconds;
    }
    return keys.map(k => index.get(k));
};

/** Where the listening went: one line per podcast, collection or station,
 *  longest first. */
export const listeningBySource = (rows, from) => {
    const index = new Map();
    for (const r of rows) {
        if (!inRange(r.day, from)) continue;
        const key = `${r.kind}:${r.source}`;
        const cur = index.get(key) || { key, source: r.source, kind: r.kind, seconds: 0, estimated: true };
        cur.seconds += r.seconds;
        if (!r.estimated) cur.estimated = false;
        index.set(key, cur);
    }
    return [...index.values()].sort((a, b) => b.seconds - a.seconds);
};

/** Episodes heard to the end in the range. */
export const finishedCount = (rows, from) => rows.reduce(
    (n, r) => (inRange(r.day, from) ? n + r.episodes : n), 0
);

/** What the paid passes came to, by what they were for. */
export const spendByService = (rows, from) => {
    const index = new Map();
    let total = 0, estimated = 0;
    for (const r of rows) {
        if (!inRange(r.day, from)) continue;
        const cur = index.get(r.service) || { service: r.service, cost: 0, runs: 0, estimated: 0 };
        cur.cost += r.cost;
        cur.runs += 1;
        if (r.estimated) cur.estimated += r.cost;
        index.set(r.service, cur);
        total += r.cost;
        if (r.estimated) estimated += r.cost;
    }
    return { total, estimated, services: [...index.values()].sort((a, b) => b.cost - a.cost) };
};

// ─── Saying it ───────────────────────────────────────────────────────────────

/** "6 h 12 m", "48 m", "40 s" — never a bare number of seconds for anything
 *  that took longer than a minute. */
export const formatSpan = (seconds) => {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s} s`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s - h * 3600) / 60);
    if (!h) return `${m} m`;
    return m ? `${h} h ${m} m` : `${h} h`;
};

/** Money, as a figure rather than a phrase: cents where there are cents to
 *  show, tenths of a cent where the whole run cost less than one. */
export const formatMoney = (dollars) => {
    const d = Math.max(0, Number(dollars) || 0);
    if (d === 0) return '$0';
    if (d < 0.01) return `${(d * 100).toFixed(1)}¢`;
    if (d < 1) return `${Math.round(d * 100)}¢`;
    return `$${d.toFixed(2)}`;
};

export const SERVICE_LABELS = {
    assistant:     'Episode assistant',
    punctuation:   'Punctuation repair',
    transcription: 'Cloud transcription',
    comparison:    'Transcript comparison',
    translation:   'Translation',
};

export const serviceLabel = (service) => SERVICE_LABELS[service] || service;
