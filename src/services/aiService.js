/**
 * The episode assistant (4.6.0): a summary, chapters and transcript
 * corrections written by a language model at OpenAI from the transcript the
 * phone made. The transcript itself stays on-device work; this is the one
 * place the app sends an episode's text out, with the listener's own key
 * (Settings → Episode assistant), by their choice — a button in the
 * Player's chapter sheet, or the "after every transcription" switch.
 *
 * What it writes (queries.replaceEpisodeAnalysis):
 *   - Episodes.summary — three or four sentences;
 *   - EpisodeChapters — sections with a start time snapped to a sentence the
 *     transcript has, a title and a one-line blurb; the Player's chapter
 *     sheet lists them and tapping one seeks there;
 *   - EpisodeFixes — "heard → correct" pairs the model is sure of (a
 *     misheard name, a title, a homophone), applied when the transcript is
 *     read, after the names pass (nameIndex.getCorrectedTranscript). The
 *     model reads the text with the names already corrected, so its heard
 *     spellings are matched on that. A fix whose heard text is not in the
 *     transcript is dropped; a medium-confidence fix of an ordinary word is
 *     kept but not applied (the sheet shows it greyed) — a wrong correction
 *     reads worse than a recogniser slip.
 *
 * Cost: at the budget tier an hour of audio is well under a cent, at the
 * mid tier a few cents (AI_MODELS); every run is logged with its tokens and
 * the estimate. One request per pass covers about three hours of speech;
 * longer audio is split at sentence lines and the part summaries merged.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestJson } from '../api/openai';
import { getEpisodeById, isRadioFeedUrl, replaceEpisodeAnalysis } from '../database/queries';
import { getNameCorrectedTranscript, indexEpisodeNames } from './nameIndex';
import { countPhrase, normalizePhrase } from './nameText';
import { showNotesPlainText } from './showNotes';
import { formatClock, sentencesWithTimes } from './sentenceBoundary';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

// ─── Settings (AsyncStorage, shared with SettingsScreen) ─────────────────────

export const OPENAI_KEY_KEY = '@openai_api_key';
export const AI_MODEL_KEY = '@ai_model';
export const AI_AUTO_KEY = '@ai_auto_analyze';      // '1' | '0'; absent = off
export const AI_FIX_KEY = '@ai_fix_transcript';     // '1' | '0'; absent = on

// Prices per million tokens (OpenAI's page, 2026-09-11) — for the log line
// and the "about a cent" hint, not for billing.
export const AI_MODELS = [
    { id: 'gpt-5.6-luna', label: 'Luna', tier: 'Budget', inPerM: 0.20, outPerM: 1.20, recommended: true },
    { id: 'gpt-5.6-terra', label: 'Terra', tier: 'Mid-range', inPerM: 2.00, outPerM: 12.00 },
];
export const DEFAULT_AI_MODEL = AI_MODELS[0].id;

export const getOpenAIKey = async () => {
    try { return ((await AsyncStorage.getItem(OPENAI_KEY_KEY)) || '').trim(); } catch (_) { return ''; }
};
export const getAIModel = async () => {
    try {
        const v = await AsyncStorage.getItem(AI_MODEL_KEY);
        return AI_MODELS.some(m => m.id === v) ? v : DEFAULT_AI_MODEL;
    } catch (_) { return DEFAULT_AI_MODEL; }
};
export const isAutoAnalyzeOn = async () => {
    try { return (await AsyncStorage.getItem(AI_AUTO_KEY)) === '1'; } catch (_) { return false; }
};
export const isFixTranscriptOn = async () => {
    try { return (await AsyncStorage.getItem(AI_FIX_KEY)) !== '0'; } catch (_) { return true; }
};
export const modelInfo = (id) => AI_MODELS.find(m => m.id === id) || AI_MODELS[0];

// ─── Cost ────────────────────────────────────────────────────────────────────

const dollars = (model, usage) => {
    const m = modelInfo(model);
    return ((usage.input - (usage.cached || 0)) * m.inPerM + (usage.cached || 0) * m.inPerM * 0.1 + usage.output * m.outPerM) / 1e6;
};
export const formatDollars = (d) => {
    if (d < 0.005) return 'under a cent';
    if (d < 0.095) return `about ${Math.max(1, Math.round(d * 100))} cent${Math.round(d * 100) === 1 ? '' : 's'}`;
    return `about $${d.toFixed(2)}`;
};
/** What a run on an episode of this length should cost, as a phrase. */
export const estimateEpisodeCost = (model, durationSec, { fixes = true } = {}) => {
    const minutes = Math.max(1, (durationSec || 3600) / 60);
    const inputTokens = minutes * 150 * 1.35 + 600;         // ~150 words a minute, ~1.35 tokens a word
    const passes = fixes ? 2 : 1;
    const outputTokens = 1200 + (fixes ? 1500 : 0);
    return formatDollars(dollars(model, { input: inputTokens * passes, output: outputTokens, cached: 0 }));
};

// ─── Prompts ─────────────────────────────────────────────────────────────────

const CHAPTERS_INSTRUCTIONS = `You write the table of contents and a short summary of a podcast episode from an automatic transcript made on a phone. The transcript has one sentence per line, each led by the time it starts, as [mm:ss] or [h:mm:ss]. The recogniser misspells names; the episode notes, when given, spell them right — use the notes only for spelling and to recognise the segments the show announces, never as a source of what was said.

Chapters: divide the episode into its natural sections — a story, a guest, a topic, a book discussed, an advertising break. Between three and twelve for an hour of audio; a section shorter than about two minutes belongs with its neighbour. The first chapter starts at the first line. Each chapter's "start" is a time copied from the transcript line where that section begins. The title is at most eight words, written like a listener's table of contents — what the section is about, not a tease; an advertising break is titled "Advertisement". The blurb is one plain sentence saying what happens in the section.

Summary: three or four sentences in plain English saying what the episode is about and what it covers, for someone deciding whether to listen. No preamble, no opinions, no "in this episode".

When told the text is one part of a longer episode, do the same for that part only.`;

const MERGE_INSTRUCTIONS = `You are given the summaries of the parts of one podcast episode, in order. Write one summary of the whole episode in three or four plain English sentences, for someone deciding whether to listen. No preamble, no opinions.`;

const FIXES_INSTRUCTIONS = `You proofread an automatic speech-recognition transcript of an English podcast. One sentence per line, each led by the time it starts. Find the places where the recogniser wrote the wrong words: a misheard name of a person, a book, film or programme title, a place, a homophone (gilt/guilt, cider/sider), a word split or joined wrongly — only where the right wording is certain from the surrounding sentences or from the episode notes, which spell the people and titles right.

Rules. Copy "heard" exactly as it appears in the transcript — same spelling, same casing, one to five words; a correction whose heard text is not in the transcript is discarded. Put the right wording in "correct". Do not fix grammar, repetitions, fillers, dialect, slang or anything the speaker actually said; do not rewrite or improve sentences; do not touch punctuation or capitalisation alone. When unsure, leave it out: a wrong correction is worse than a recogniser error. "context" is the transcript line the mistake is in, copied as written. "kind" is name, title, place or word. "confidence" is high when the notes or the sentences leave no doubt, medium otherwise. Return an empty list when the transcript needs nothing.`;

const CHAPTERS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'chapters'],
    properties: {
        summary: { type: 'string' },
        chapters: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'title', 'blurb'],
                properties: {
                    start: { type: 'string', description: 'Time copied from the transcript line where the chapter begins, mm:ss or h:mm:ss' },
                    title: { type: 'string' },
                    blurb: { type: 'string' },
                },
            },
        },
    },
};

const SUMMARY_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['summary'],
    properties: { summary: { type: 'string' } },
};

const FIXES_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['corrections'],
    properties: {
        corrections: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['heard', 'correct', 'kind', 'context', 'confidence'],
                properties: {
                    heard: { type: 'string' },
                    correct: { type: 'string' },
                    kind: { type: 'string', enum: ['name', 'title', 'place', 'word'] },
                    context: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'medium'] },
                },
            },
        },
    },
};

// ─── Transcript → request text ───────────────────────────────────────────────

const MAX_PART_CHARS = 110000;    // ≈ 28k tokens — one request for anything up to ~3 hours
const NOTES_MAX_CHARS = 3000;

const describeEpisode = (ep, durationMs, notes) => [
    `Podcast: ${ep.podcast_title || ''}`,
    `Episode: ${ep.title || ''}`,
    durationMs > 0 ? `Length: ${formatClock(durationMs)}` : null,
    notes ? `Episode notes (for spelling and the announced segments only):\n${notes}` : null,
].filter(Boolean).join('\n');

// Lines cut into parts of roughly equal length, never mid-line.
const splitParts = (lines) => {
    const total = lines.reduce((n, l) => n + l.length + 1, 0);
    const n = Math.max(1, Math.ceil(total / MAX_PART_CHARS));
    if (n === 1) return [lines];
    const per = Math.ceil(lines.length / n);
    const parts = [];
    for (let i = 0; i < lines.length; i += per) parts.push(lines.slice(i, i + per));
    return parts;
};

const partLabel = (i, n, lines) => (n > 1
    ? `This is part ${i + 1} of ${n} of the episode, from ${lines[0].slice(1, lines[0].indexOf(']'))} to ${lines[lines.length - 1].slice(1, lines[lines.length - 1].indexOf(']'))}.\n`
    : '');

// ─── Answers → rows ──────────────────────────────────────────────────────────

const parseClock = (s) => {
    const m = String(s || '').trim().match(/^\[?(?:(\d+):)?(\d{1,2}):(\d{2})\]?$/);
    if (!m) return null;
    return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
};

const SNAP_MS = 20000;         // a start this close to a sentence start takes it
const MIN_CHAPTER_MS = 60000;  // closer than this to the previous one → merged

const snapChapters = (raw, sentences, durationMs) => {
    const starts = sentences.map(s => s.startMs);
    const out = [];
    for (const c of raw || []) {
        const t = parseClock(c.start);
        if (t == null) continue;
        let best = -1, bestD = Infinity;
        for (let i = 0; i < starts.length; i++) {
            const d = Math.abs(starts[i] - t);
            if (d < bestD) { bestD = d; best = i; }
            if (starts[i] > t + SNAP_MS) break;
        }
        const startMs = best >= 0 && bestD <= SNAP_MS ? starts[best] : t;
        if (durationMs > 0 && startMs > durationMs) continue;
        const title = String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        if (!title) continue;
        out.push({ startMs, title, blurb: String(c.blurb || '').replace(/\s+/g, ' ').trim().slice(0, 300) });
    }
    out.sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const c of out) {
        const prev = merged[merged.length - 1];
        if (prev && c.startMs - prev.startMs < MIN_CHAPTER_MS) continue;
        merged.push(c);
    }
    if (merged.length) merged[0].startMs = starts.length ? starts[0] : 0;   // a table of contents starts at the top
    const end = durationMs > 0 ? durationMs : (sentences[sentences.length - 1]?.endMs ?? null);
    merged.forEach((c, i) => { c.endMs = i + 1 < merged.length ? merged[i + 1].startMs : end; });
    return merged;
};

const ENDS_POSSESSIVE = /['’]s[^\p{L}\p{N}]*$/iu;
const MAX_HEARD_WORDS = 6;
const MAX_CORRECT_WORDS = 8;

const acceptFixes = (raw, rows) => {
    const fixes = [], dropped = [];
    const seen = new Set();
    for (const f of raw || []) {
        const heard = normalizePhrase(f.heard);
        // The heard token's own possessive comes back when the fix is
        // applied, so "Rushy's → Rushdie's" is stored as Rushy → Rushdie;
        // a possessive elsewhere ("Midnight's Children") stays.
        let correct = normalizePhrase(f.correct, { keepPossessive: true });
        if (ENDS_POSSESSIVE.test(String(f.heard || '').trim()) && ENDS_POSSESSIVE.test(correct)) {
            correct = correct.replace(ENDS_POSSESSIVE, '');
        }
        if (!heard || !correct) continue;
        if (heard.split(' ').length > MAX_HEARD_WORDS || correct.split(' ').length > MAX_CORRECT_WORDS) { dropped.push(`${heard} (too long)`); continue; }
        if (heard.toLowerCase() === correct.toLowerCase()) continue;
        const key = heard.toLowerCase();
        if (seen.has(key)) continue;
        const { count, firstMs } = countPhrase(rows, heard);
        if (!count) { dropped.push(`${heard} (not in the text)`); continue; }
        seen.add(key);
        const kind = ['name', 'title', 'place', 'word'].includes(f.kind) ? f.kind : 'word';
        const confidence = f.confidence === 'medium' ? 'medium' : 'high';
        fixes.push({
            heard, correct, kind, confidence, count, firstMs,
            context: String(f.context || '').trim().slice(0, 400),
            applied: !(kind === 'word' && confidence === 'medium'),
        });
    }
    return { fixes, dropped };
};

// ─── The pass ────────────────────────────────────────────────────────────────

const _running = new Map();   // episodeId → Promise

const tagged = (kind, message) => Object.assign(new Error(message), { kind });

/**
 * Summary, chapters and (when the switch is on) fixes for one episode,
 * written to the database. Resolves { summary, chapters, fixes, cost } or
 * null when the episode was already analysed and not `force`. Rejects with
 * a message fit for the sheet (`kind` says why: 'nokey', 'notranscript',
 * or the api/openai kinds). Two callers share one run.
 */
export const analyzeEpisode = (episodeId, { force = false } = {}) => {
    const active = _running.get(episodeId);
    if (active) return active;
    const p = (async () => {
        const t0 = Date.now();
        const apiKey = await getOpenAIKey();
        if (!apiKey) throw tagged('nokey', 'Add your OpenAI API key in Settings → Episode assistant first.');
        const ep = await getEpisodeById(episodeId);
        if (!ep) throw tagged('notranscript', 'This episode is gone.');
        if (isRadioFeedUrl(ep.podcast_feed_url)) throw tagged('notranscript', 'Radio sessions are not summarised.');
        if (ep.ai_indexed_at && !force) return null;

        // The names pass first, so the text the model reads has them right.
        await indexEpisodeNames(episodeId).catch(() => null);
        const rows = await getNameCorrectedTranscript(episodeId);
        if (!rows.length) throw tagged('notranscript', 'This episode has no transcript yet.');
        const sentences = sentencesWithTimes(rows);
        const lines = sentences.map(s => `[${formatClock(s.startMs)}] ${s.text}`);
        const durationMs = ep.duration > 0 ? ep.duration * 1000 : (sentences[sentences.length - 1]?.endMs || 0);
        const notes = showNotesPlainText(ep.description || '').trim().slice(0, NOTES_MAX_CHARS);
        const model = await getAIModel();
        const wantFixes = await isFixTranscriptOn();
        const head = describeEpisode(ep, durationMs, notes);
        const parts = splitParts(lines);
        const usage = { input: 0, output: 0, cached: 0 };
        const add = (u) => { usage.input += u.input; usage.output += u.output; usage.cached += u.cached; };

        // Chapters + summary, per part.
        const rawChapters = [];
        const partSummaries = [];
        for (let i = 0; i < parts.length; i++) {
            const r = await requestJson({
                apiKey, model, instructions: CHAPTERS_INSTRUCTIONS, schemaName: 'episode_chapters', schema: CHAPTERS_SCHEMA,
                input: `${head}\n\n${partLabel(i, parts.length, parts[i])}Transcript:\n${parts[i].join('\n')}`,
                maxOutputTokens: 5000,
            });
            add(r.usage);
            rawChapters.push(...(r.json?.chapters || []));
            if (r.json?.summary) partSummaries.push(String(r.json.summary).trim());
        }
        let summary = partSummaries.join('\n\n');
        if (partSummaries.length > 1) {
            const r = await requestJson({
                apiKey, model, instructions: MERGE_INSTRUCTIONS, schemaName: 'episode_summary', schema: SUMMARY_SCHEMA,
                input: `${head}\n\n${partSummaries.map((s, i) => `Part ${i + 1}: ${s}`).join('\n\n')}`,
                maxOutputTokens: 1000,
            });
            add(r.usage);
            summary = String(r.json?.summary || summary).trim();
        }
        const chapters = snapChapters(rawChapters, sentences, durationMs);

        // Fixes, per part.
        let fixes = [], dropped = [];
        if (wantFixes) {
            const raw = [];
            for (let i = 0; i < parts.length; i++) {
                const r = await requestJson({
                    apiKey, model, instructions: FIXES_INSTRUCTIONS, schemaName: 'transcript_corrections', schema: FIXES_SCHEMA,
                    input: `${head}\n\n${partLabel(i, parts.length, parts[i])}Transcript:\n${parts[i].join('\n')}`,
                    maxOutputTokens: 8000,
                });
                add(r.usage);
                raw.push(...(r.json?.corrections || []));
            }
            ({ fixes, dropped } = acceptFixes(raw, rows));
        }

        await replaceEpisodeAnalysis(episodeId, { summary, chapters, fixes, model });
        const cost = dollars(model, usage);
        log('SYSTEM', 'Episode assistant finished', {
            id: episodeId, title: ep.title, model, parts: parts.length, sentences: sentences.length,
            chapters: chapters.length, fixes: fixes.length, notApplied: fixes.filter(f => !f.applied).length,
            dropped: dropped.slice(0, 20), tokensIn: usage.input, tokensCached: usage.cached, tokensOut: usage.output,
            cost: `$${cost.toFixed(4)}`, ms: Date.now() - t0,
            chapterList: chapters.map(c => `${formatClock(c.startMs)} ${c.title}`),
            fixList: fixes.map(f => `${f.heard} → ${f.correct} (${f.kind}, ${f.confidence}${f.applied ? '' : ', not applied'}) ×${f.count}`).slice(0, 60),
        });
        try { notifyLibraryChange({ type: 'analysis-indexed', episodeId, chapters: chapters.length, fixes: fixes.length }); } catch (_) {}
        return { summary, chapters, fixes, cost, model, usage };
    })().catch((e) => {
        log('SYSTEM', 'Episode assistant failed', { id: episodeId, kind: e?.kind, error: e?.message || String(e) });
        throw e;
    }).finally(() => { _running.delete(episodeId); });
    _running.set(episodeId, p);
    return p;
};

export const isAnalyzing = (episodeId) => _running.has(episodeId);

/** After a transcription, when the listener asked for it in Settings. */
export const analyzeIfAuto = async (episodeId) => {
    if (!(await isAutoAnalyzeOn())) return null;
    if (!(await getOpenAIKey())) return null;
    try {
        return await analyzeEpisode(episodeId, { force: true });
    } catch (_) {
        return null;   // logged by analyzeEpisode; the sheet offers a retry
    }
};
