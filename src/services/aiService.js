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
import { getEpisodeById, isRadioFeedUrl, recordApiSpend, replaceEpisodeAnalysis } from '../database/queries';
import { getNameCorrectedTranscript, indexEpisodeNames } from './nameIndex';
import { indexEpisodeBooks } from './bookIndex';
import { repunctuateEpisode } from './repunctuate';
import { countPhrase, fold, normalizePhrase } from './nameText';
import { showNotesPlainText } from './showNotes';
import { formatClock, sentencesWithTimes } from './sentenceBoundary';
import { langEnglishName } from '../components/transcript/translate';
import { readingRequest } from './transcriptReading';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

// ─── Settings (AsyncStorage, shared with SettingsScreen) ─────────────────────

export const OPENAI_KEY_KEY = '@openai_api_key';
export const AI_MODEL_KEY = '@ai_model';
export const AI_AUTO_KEY = '@ai_auto_analyze';      // '1' | '0'; absent = off
export const AI_FIX_KEY = '@ai_fix_transcript';     // '1' | '0'; absent = on
export const AI_AUTO_TAG_KEY = '@ai_auto_entities'; // '1' | '0'; absent = off

// Prices per million tokens (OpenAI's page, 2026-09-23) — for the log line
// and the "about a cent" hint, not for billing.
export const AI_MODELS = [
    { id: 'gpt-6-luna', label: 'Luna', tier: 'Budget', inPerM: 0.10, outPerM: 0.50, recommended: true },
    { id: 'gpt-6-sol', label: 'Sol', tier: 'Flagship', inPerM: 2.00, outPerM: 10.00 },
];
export const DEFAULT_AI_MODEL = AI_MODELS[0].id;
// Models the picker no longer offers. A run made on one is still priced at
// its own rate on the statistics page, and a saved choice moves on to the
// model that replaced it. (gpt-5.6-sol had been listed here at $2/$10;
// OpenAI charged $4/$20 for it.)
export const RETIRED_AI_MODELS = [
    { id: 'gpt-5.6-luna', label: 'Luna (5.6)', inPerM: 0.20, outPerM: 1.20, successor: 'gpt-6-luna' },
    { id: 'gpt-5.6-terra', label: 'Terra (5.6)', inPerM: 2.00, outPerM: 12.00 },
    { id: 'gpt-5.6-sol', label: 'Sol (5.6)', inPerM: 4.00, outPerM: 20.00, successor: 'gpt-6-sol' },
];
/** The model a saved choice means today: itself, its successor, or the default. */
export const resolveAIModel = (id) => {
    if (AI_MODELS.some(m => m.id === id)) return id;
    return RETIRED_AI_MODELS.find(m => m.id === id)?.successor || DEFAULT_AI_MODEL;
};

export const getOpenAIKey = async () => {
    try { return ((await AsyncStorage.getItem(OPENAI_KEY_KEY)) || '').trim(); } catch (_) { return ''; }
};
export const getAIModel = async () => {
    try {
        return resolveAIModel(await AsyncStorage.getItem(AI_MODEL_KEY));
    } catch (_) { return DEFAULT_AI_MODEL; }
};
export const isAutoAnalyzeOn = async () => {
    try { return (await AsyncStorage.getItem(AI_AUTO_KEY)) === '1'; } catch (_) { return false; }
};
export const isFixTranscriptOn = async () => {
    try { return (await AsyncStorage.getItem(AI_FIX_KEY)) !== '0'; } catch (_) { return true; }
};
/** Whether what an episode names is looked up as soon as its transcript is
 *  done (services/entityIndex.tagIfAuto), instead of when asked in the Player. */
export const isAutoTagOn = async () => {
    try { return (await AsyncStorage.getItem(AI_AUTO_TAG_KEY)) === '1'; } catch (_) { return false; }
};
export const modelInfo = (id) => AI_MODELS.find(m => m.id === id) || RETIRED_AI_MODELS.find(m => m.id === id) || AI_MODELS[0];

// Failures carry a `kind` so the caller can tell a missing key from a
// network problem and say something useful (api/openai.js uses the same set).
const tagged = (kind, message) => Object.assign(new Error(message), { kind });

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
/** What a run on an episode of this length should cost, in dollars. Also
 *  what the statistics screen prices a run made before the spend ledger
 *  existed at — the model that wrote it and the length of the episode are
 *  all that is left of it. */
export const estimateEpisodeDollars = (model, durationSec, { fixes = true, cached = false } = {}) => {
    const minutes = Math.max(1, (durationSec || 3600) / 60);
    const inputTokens = minutes * 150 * 1.35 + 600;         // ~150 words a minute, ~1.35 tokens a word
    const passes = fixes ? 2 : 1;
    const outputTokens = 1200 + (fixes ? 1500 : 0);
    // Since 5.6.0 the passes after the first read the transcript from
    // OpenAI's cache (services/transcriptReading.js); a run from before
    // then — what the statistics screen prices — read it every time.
    return dollars(model, { input: inputTokens * passes, output: outputTokens, cached: cached ? inputTokens * (passes - 1) : 0 });
};
/** The same figure as a phrase. */
export const estimateEpisodeCost = (model, durationSec, opts) => formatDollars(estimateEpisodeDollars(model, durationSec, opts));

// ─── Prompts ─────────────────────────────────────────────────────────────────

// Each is the last message of a request that starts with the episode
// (services/transcriptReading.js), so the text they read can be cached.
const CHAPTERS_INSTRUCTIONS = `Task: write the table of contents and a short summary of this episode, and list its advertisements. Fill "summary", "chapters" and "ads" only.

Chapters: divide the episode into its natural sections — a story, a guest, a topic, a book discussed, an advertising break. Between three and twelve for an hour of audio; a section shorter than about two minutes belongs with its neighbour. The first chapter starts at the first line. Each chapter's "start" is a time copied from the transcript line where that section begins. The title is at most eight words, written like a listener's table of contents — what the section is about, not a tease; an advertising break is titled "Advertisement". The blurb is one plain sentence saying what happens in the section.

Summary: three or four sentences in plain English saying what the episode is about and what it covers, for someone deciding whether to listen. No preamble, no opinions, no "in this episode".

Ads: every advertisement, however short, so the listener can skip it — a sponsor read (also when the host reads it in their own voice, woven into the talk), "this episode is brought to you by…", an inserted commercial, a trailer or promotion for another show. Not the show's own introduction, its theme music, or the hosts asking for reviews or subscriptions. "start" is the time of the line where the advertisement begins; "end" is the time of the first line after it, where the episode resumes. Consecutive advertisements in one break are one entry. "label" is the sponsor or the show promoted, in a few words ("Squarespace", "Trailer: The Rest Is History"). An empty list when there are none.

When told the text is one part of a longer episode, do the same for that part only.`;

const MERGE_INSTRUCTIONS = `You are given the summaries of the parts of one podcast episode, in order. Write one summary of the whole episode in three or four plain English sentences, for someone deciding whether to listen. No preamble, no opinions.`;

const FIXES_INSTRUCTIONS = `Task: proofread this transcript. Fill "corrections" only.

Find the places where the recogniser wrote the wrong words: a misheard name of a person, a book, film or programme title, a place, a homophone (gilt/guilt, cider/sider), a word split or joined wrongly — only where the right wording is certain from the surrounding sentences or from the episode notes, which spell the people and titles right.

Rules. Copy "heard" exactly as it appears in the transcript — same spelling, same casing, one to five words; a correction whose heard text is not in the transcript is discarded. Put the right wording in "correct". Do not fix grammar, repetitions, fillers, dialect, slang or anything the speaker actually said; do not rewrite or improve sentences; do not touch punctuation or capitalisation alone. When unsure, leave it out: a wrong correction is worse than a recogniser error. "context" is the transcript line the mistake is in, copied as written. "kind" is name, title, place or word. "confidence" is high when the notes or the sentences leave no doubt, medium otherwise. Return an empty list when the transcript needs nothing.`;

const SUMMARY_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['summary'],
    properties: { summary: { type: 'string' } },
};

// ─── Translation with the lines before it ────────────────────────────────────
// The card already hands Google the two sentences before the pressed one, but
// a sentence-level engine mostly translates them side by side: a pronoun, an
// ellipsis or a joke that only the previous line explains comes out wrong.
// This asks the model instead, with those lines named as context.

const translateInstructions = (target) => `You translate an English podcast transcript into ${target} for someone who is learning English by reading along with the audio.

You are given the lines spoken just before, for context only, and then the numbered paragraphs to translate. Return one translation per numbered paragraph, in the same order, the same number of them — never merge, split, reorder or drop one, and never translate the context lines.

Translate what was said, in natural ${target}: the meaning a listener takes, not a word-for-word mapping. Use the context to settle what a pronoun, an ellipsis, a short reply or a joke refers to. Speech is not prose — keep false starts, repetitions and interruptions rather than tidying them into a clean sentence. Leave people's names, programme, book and film titles as they are unless that language has its own established name for them. Return only the translations, with no notes or explanations.`;

const TRANSLATE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['translations'],
    properties: { translations: { type: 'array', items: { type: 'string' } } },
};

const CONTEXT_MAX_CHARS = 1200;

/**
 * Translates `paragraphs` (the pressed sentence, and the ones shown above it)
 * into `lang`, with `before` as context the model may read but not translate.
 * Resolves to an array of the same length, or rejects — the caller falls back
 * to the free engine. Never sends anything when the assistant has no key.
 */
export const translateParagraphs = async ({ paragraphs, lang, before = '', signal }) => {
    const parts = (paragraphs || []).map(p => String(p || '').trim()).filter(Boolean);
    if (!parts.length) return [];
    const apiKey = await getOpenAIKey();
    if (!apiKey) throw tagged('nokey', 'No OpenAI API key.');
    const model = await getAIModel();
    const ctx = String(before || '').trim().slice(-CONTEXT_MAX_CHARS);
    const numbered = parts.map((p, i) => `${i + 1}. ${p}`).join('\n');
    const input = [
        ctx ? `Spoken just before, for context only — do not translate:\n"${ctx}"` : null,
        `Translate these ${parts.length} paragraph${parts.length === 1 ? '' : 's'}:\n${numbered}`,
    ].filter(Boolean).join('\n\n');
    const t0 = Date.now();
    const { json, usage } = await requestJson({
        apiKey, model, instructions: translateInstructions(langEnglishName(lang)),
        schemaName: 'translations', schema: TRANSLATE_SCHEMA, input,
        maxOutputTokens: 1600, signal,
    });
    const out = Array.isArray(json?.translations) ? json.translations.map(t => String(t || '').trim()) : [];
    // Small beside a whole episode, but there are many of them — the
    // statistics screen is where a month of translating adds up.
    await recordApiSpend({
        provider: 'openai', service: 'translation', model,
        tokensIn: usage.input, tokensCached: usage.cached, tokensOut: usage.output,
        cost: dollars(model, usage),
    });
    log('SERVICE', 'Context translation', {
        lang, model, paragraphs: parts.length, returned: out.length,
        contextChars: ctx.length, tokensIn: usage.input, tokensOut: usage.output,
        cost: `$${dollars(model, usage).toFixed(5)}`, ms: Date.now() - t0,
    });
    // A count that does not line up would pair every paragraph with the wrong
    // translation; the caller's fallback is better than a shifted card.
    if (out.length !== parts.length || out.some(t => !t)) {
        throw tagged('malformed', 'The translation did not line up with the text.');
    }
    return out;
};

// ─── Transcript → request text ───────────────────────────────────────────────

const MAX_PART_CHARS = 110000;    // ≈ 28k tokens — one request for anything up to ~3 hours
const NOTES_MAX_CHARS = 3000;

/** The episode's own notes as plain text, cut to what one request carries. */
export const episodeNotes = (ep) =>
    showNotesPlainText(ep?.description || '').trim().slice(0, NOTES_MAX_CHARS);

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

/** Everything one reading of a transcript needs: the sentences it is cut
 *  into, the head that names the episode, the parts of the request, and
 *  each part as the text a request opens with — the same string for every
 *  pass, which is what lets the passes after the first read it cached. */
const preparePass = (ep, rows, notes) => {
    const sentences = sentencesWithTimes(rows);
    const lines = sentences.map(s => `[${formatClock(s.startMs)}] ${s.text}`);
    const durationMs = ep.duration > 0 ? ep.duration * 1000 : (sentences[sentences.length - 1]?.endMs || 0);
    const head = describeEpisode(ep, durationMs, notes);
    const parts = splitParts(lines);
    const texts = parts.map((p, i) => `${head}\n\n${partLabel(i, parts.length, p)}Transcript:\n${p.join('\n')}`);
    return { episodeId: ep.id, sentences, lines, durationMs, head, parts, texts };
};

/** The same preparation, for a pass that lives in its own service
 *  (services/entityIndex.js). */
export const episodeParts = (ep, rows, notes = '') => preparePass(ep, rows, notes);

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

const MIN_AD_MS = 5000;           // shorter is a mention, not a break
const MAX_AD_MS = 8 * 60 * 1000;  // longer is the model mistaking a segment for one

/** The sentence start nearest `t` within SNAP_MS, or `t` itself. */
const snapToSentence = (t, starts) => {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < starts.length; i++) {
        const d = Math.abs(starts[i] - t);
        if (d < bestD) { bestD = d; best = i; }
        if (starts[i] > t + SNAP_MS) break;
    }
    return best >= 0 && bestD <= SNAP_MS ? starts[best] : t;
};

/**
 * The ads as { startMs, endMs, label }: both ends on sentence starts, so a
 * skip lands where the episode resumes; overlapping or touching breaks
 * merged; anything too short or too long to be an ad dropped.
 */
const snapAds = (raw, sentences, durationMs) => {
    const starts = sentences.map(s => s.startMs);
    const end = durationMs > 0 ? durationMs : (sentences[sentences.length - 1]?.endMs ?? Infinity);
    const ads = [];
    for (const a of raw || []) {
        const s = parseClock(a.start);
        const e = parseClock(a.end);
        if (s == null || e == null) continue;
        const startMs = snapToSentence(s, starts);
        const endMs = Math.min(end, snapToSentence(e, starts));
        if (endMs - startMs < MIN_AD_MS || endMs - startMs > MAX_AD_MS) continue;
        const label = String(a.label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        ads.push({ startMs, endMs, label });
    }
    ads.sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const a of ads) {
        const prev = merged[merged.length - 1];
        if (prev && a.startMs <= prev.endMs + 1000) {
            prev.endMs = Math.max(prev.endMs, a.endMs);
            if (a.label && !prev.label.includes(a.label)) prev.label = prev.label ? `${prev.label}, ${a.label}` : a.label;
        } else merged.push({ ...a });
    }
    return merged;
};

const ENDS_POSSESSIVE = /['’]s[^\p{L}\p{N}]*$/iu;
const MAX_HEARD_WORDS = 6;
const MAX_CORRECT_WORDS = 8;
// A fix is a replacement of every occurrence, so one that would land this
// often is held back for the listener to see rather than written in. On an
// hour about Constantine, three of four models proposed "Constantine →
// Constantina" for the one place a daughter was named, and 98 emperors
// would have changed sex.
const MAX_FIX_COUNT = 12;

/** The words of a text, folded like the transcript; `fold` drops digits, so
 *  numbers ride along as they are ("in 212" is "in" and "212", and the
 *  notes not saying 212 is what keeps that fix). */
const foldWords = (text) => [...fold(text).split(' '), ...(String(text || '').match(/\d+/g) || [])].filter(Boolean);
/** The words the title and the notes spell out. */
const knownWords = (text) => new Set(foldWords(text));
/** A heard phrase made only of words the notes themselves use is spelled
 *  the way the notes spell things — a name the model wants to change in
 *  one sentence, not a mishearing to fix everywhere. */
const spelledInNotes = (heard, known) => {
    const words = foldWords(heard);
    return words.length > 0 && words.every(w => known.has(w));
};

/**
 * The model's proposals, checked against the transcript and the notes.
 * `known` is the episode title and notes: a heard phrase spelled entirely in
 * their words is dropped, a pair that corrects both ways is dropped, and a
 * fix that would apply more than MAX_FIX_COUNT times is kept but not applied.
 */
const acceptFixes = (raw, rows, { known = '' } = {}) => {
    const fixes = [], dropped = [];
    const seen = new Set();
    const notesWords = knownWords(known);
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
        if (spelledInNotes(heard, notesWords)) { dropped.push(`${heard} (spelled so in the notes)`); continue; }
        seen.add(key);
        const kind = ['name', 'title', 'place', 'word'].includes(f.kind) ? f.kind : 'word';
        const confidence = f.confidence === 'medium' ? 'medium' : 'high';
        fixes.push({
            heard, correct, kind, confidence, count, firstMs,
            context: String(f.context || '').trim().slice(0, 400),
            applied: !(kind === 'word' && confidence === 'medium') && count <= MAX_FIX_COUNT,
        });
    }
    // "Marie Celeste → Mary Celeste" and "Mary Celeste → Marie Celeste" in one
    // answer: the model is of two minds, and applying both is a coin toss.
    const correctOf = new Map(fixes.map(f => [f.heard.toLowerCase(), f.correct.toLowerCase()]));
    const kept = fixes.filter((f) => {
        if (correctOf.get(f.correct.toLowerCase()) !== f.heard.toLowerCase()) return true;
        dropped.push(`${f.heard} ↔ ${f.correct} (corrects both ways)`);
        return false;
    });
    return { fixes: kept, dropped };
};

// ─── The pass ────────────────────────────────────────────────────────────────

const _running = new Map();   // episodeId → Promise

/**
 * The summary and chapters for one transcript, by whoever `request` asks —
 * nothing is written to the database. `request` makes one structured call
 * ({ instructions, schemaName, schema, input, cacheKey, maxOutputTokens }) and resolves
 * { json, usage }, the shape api/openai.requestJson returns.
 *
 * Kept apart from analyzeEpisode so one reading can be made through another
 * request path, or without writing anything down.
 *
 * `prepared` is preparePass's answer when the caller already has it.
 */
export const chaptersAndSummary = async ({ ep, rows, notes = '', request, prepared }) => {
    const { episodeId, sentences, durationMs, head, parts, texts } = prepared || preparePass(ep, rows, notes);
    const usage = { input: 0, output: 0, cached: 0 };
    const add = (u) => {
        usage.input += u?.input || 0; usage.output += u?.output || 0; usage.cached += u?.cached || 0;
    };
    const rawChapters = [];
    const rawAds = [];
    const partSummaries = [];
    for (let i = 0; i < parts.length; i++) {
        const r = await request(readingRequest({
            text: texts[i], task: CHAPTERS_INSTRUCTIONS, episodeId, maxOutputTokens: 5000,
        }));
        add(r.usage);
        rawChapters.push(...(r.json?.chapters || []));
        rawAds.push(...(r.json?.ads || []));
        if (r.json?.summary) partSummaries.push(String(r.json.summary).trim());
    }
    let summary = partSummaries.join('\n\n');
    if (partSummaries.length > 1) {
        const r = await request({
            instructions: MERGE_INSTRUCTIONS, schemaName: 'episode_summary', schema: SUMMARY_SCHEMA,
            input: `${head}\n\n${partSummaries.map((s, i) => `Part ${i + 1}: ${s}`).join('\n\n')}`,
            maxOutputTokens: 1000,
        });
        add(r.usage);
        summary = String(r.json?.summary || summary).trim();
    }
    return {
        summary, chapters: snapChapters(rawChapters, sentences, durationMs),
        ads: snapAds(rawAds, sentences, durationMs),
        sentences, parts: parts.length, usage,
    };
};

/** The assistant's own request path, for a pass that runs outside
 *  analyzeEpisode: the listener's key, the model
 *  they chose, the shape chaptersAndSummary and requestJson both speak. */
export const assistantRequest = async () => {
    const apiKey = await getOpenAIKey();
    if (!apiKey) throw tagged('nokey', 'Add your OpenAI API key in Settings \u2192 Episode assistant first.');
    const model = await getAIModel();
    return { model, request: (req) => requestJson({ apiKey, model, ...req }) };
};

/** What a run cost, in dollars, from the tokens it used. */
export const costOf = (model, usage) => dollars(model, usage);

/**
 * Summary, chapters and (when the switch is on) fixes for one episode,
 * written to the database. Resolves { summary, chapters, fixes, cost } or
 * null when the episode was already analysed and not `force`. Rejects with
 * a message fit for the sheet (`kind` says why: 'nokey', 'notranscript',
 * or the api/openai kinds). Two callers share one run.
 *
 * `alongside(prepared, request)` is another pass over the same text
 * (entityIndex.askEntities, when the tag pass follows): it starts once the
 * chapters pass has put the transcript in OpenAI's cache and runs beside the
 * fixes, so both read it at a tenth of the price. Its answer comes back as
 * `alongside` — null when it failed, and the caller asks again on its own.
 */
export const analyzeEpisode = (episodeId, { force = false, scanBooks = true, alongside = null } = {}) => {
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

        const model = await getAIModel();
        const request = (req) => requestJson({ apiKey, model, ...req });

        // The punctuation first: the stretches the recogniser ran into one
        // sentence are put back into sentences (services/repunctuate.js), so
        // the chapters snap to real sentence starts and the listener reads
        // what the summary read. It never changes a word, and a failure only
        // leaves the recogniser's punctuation.
        await repunctuateEpisode(episodeId, { request, model, price: (u) => dollars(model, u) })
            .catch((e) => log('SYSTEM', 'Episode assistant: the punctuation pass failed', { id: episodeId, error: e?.message || String(e) }));

        // The names pass next, so the text the model reads has them right.
        await indexEpisodeNames(episodeId).catch(() => null);
        const rows = await getNameCorrectedTranscript(episodeId);
        if (!rows.length) throw tagged('notranscript', 'This episode has no transcript yet.');
        const notes = episodeNotes(ep);
        const wantFixes = await isFixTranscriptOn();
        const prepared = preparePass(ep, rows, notes);
        const { sentences, parts, texts } = prepared;
        const usage = { input: 0, output: 0, cached: 0 };
        const add = (u) => { usage.input += u.input; usage.output += u.output; usage.cached += u.cached; };

        // Chapters + summary, per part — first, because the request that
        // reads the text first is the one that caches it for the rest.
        const pass = await chaptersAndSummary({ ep, rows, notes, prepared, request });
        add(pass.usage);
        const { summary, chapters, ads } = pass;

        // Fixes, per part, and the pass alongside — side by side, both on
        // the cached text.
        const askFixes = async () => {
            if (!wantFixes) return { fixes: [], dropped: [] };
            const raw = [];
            for (let i = 0; i < parts.length; i++) {
                const r = await request(readingRequest({
                    text: texts[i], task: FIXES_INSTRUCTIONS, episodeId, maxOutputTokens: 8000,
                }));
                add(r.usage);
                raw.push(...(r.json?.corrections || []));
            }
            return acceptFixes(raw, rows, { known: `${ep.title || ''}\n${notes}` });
        };
        const askAlongside = () => (alongside
            ? Promise.resolve().then(() => alongside(prepared, request)).catch((e) => {
                log('SYSTEM', 'Episode assistant: the pass alongside failed', { id: episodeId, error: e?.message || String(e) });
                return null;
            })
            : Promise.resolve(null));
        const [{ fixes, dropped }, besides] = await Promise.all([askFixes(), askAlongside()]);

        await replaceEpisodeAnalysis(episodeId, { summary, chapters, ads, fixes, model });
        const cost = dollars(model, usage);
        // The statistics screen adds up what the assistant has cost
        // (schema v15); the log line below is for one run, this is for the month.
        await recordApiSpend({
            provider: 'openai', service: 'assistant', model, episodeId, episodeTitle: ep.title,
            source: ep.podcast_title, tokensIn: usage.input, tokensCached: usage.cached,
            tokensOut: usage.output, cost,
        });
        log('SYSTEM', 'Episode assistant finished', {
            id: episodeId, title: ep.title, model, parts: parts.length, sentences: sentences.length,
            chapters: chapters.length, ads: ads.length, fixes: fixes.length, notApplied: fixes.filter(f => !f.applied).length,
            dropped: dropped.slice(0, 20), tokensIn: usage.input, tokensCached: usage.cached, tokensOut: usage.output,
            cost: `$${cost.toFixed(4)}`, ms: Date.now() - t0,
            chapterList: chapters.map(c => `${formatClock(c.startMs)} ${c.title}`),
            adList: ads.map(a => `${formatClock(a.startMs)}–${formatClock(a.endMs)} ${a.label}`),
            fixList: fixes.map(f => `${f.heard} → ${f.correct} (${f.kind}, ${f.confidence}${f.applied ? '' : ', not applied'}) ×${f.count}`).slice(0, 60),
        });
        try { notifyLibraryChange({ type: 'analysis-indexed', episodeId, chapters: chapters.length, fixes: fixes.length }); } catch (_) {}

        // The books and people an episode names are read out of the corrected
        // transcript (bookIndex reads getCorrectedTranscript), and a misheard
        // author is exactly what a catalogue lookup cannot survive — so the
        // scan is run again now that the corrections are in. Also when the
        // episode was never scanned at all: the after-every-transcription
        // path leaves it to this, so the scan happens once, on the best text.
        // Not when the tag pass follows (whisperService → entityIndex.tagIfAuto):
        // it reads the corrected text too and brings the books itself.
        if (scanBooks && (fixes.length > 0 || !ep.books_indexed_at)) {
            indexEpisodeBooks(episodeId, { force: true, front: true }).catch(() => {});
        }
        return { summary, chapters, fixes, cost, model, usage, alongside: besides };
    })().catch((e) => {
        log('SYSTEM', 'Episode assistant failed', { id: episodeId, kind: e?.kind, error: e?.message || String(e) });
        throw e;
    }).finally(() => { _running.delete(episodeId); });
    _running.set(episodeId, p);
    return p;
};

export const isAnalyzing = (episodeId) => _running.has(episodeId);

/** After a transcription, when the listener asked for it in Settings. */
export const analyzeIfAuto = async (episodeId, { alongside = null } = {}) => {
    if (!(await isAutoAnalyzeOn())) return null;
    if (!(await getOpenAIKey())) return null;
    try {
        return await analyzeEpisode(episodeId, { force: true, scanBooks: !(await isAutoTagOn()), alongside });
    } catch (_) {
        return null;   // logged by analyzeEpisode; the sheet offers a retry
    }
};
