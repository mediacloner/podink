/**
 * Putting the punctuation back.
 *
 * Parakeet punctuates as it goes, and mostly well, but every so often it
 * loses the thread: a minute of speech arrives as one sentence, the capitals
 * go with it, and the reader shows a wall of words nobody can follow along
 * with. (The Constantine episode has six such runs, one of them thirty
 * seconds of lowercase.) This asks the assistant's model to repair them.
 *
 * The words are not the model's to change. It may add or move a full stop, a
 * comma, a question mark or a capital — nothing else — and its answer is
 * accepted only when the letters and digits it returns, in order and with
 * everything else stripped away, are exactly the ones that went in. A model
 * that corrects a name, drops a filler or tidies a false start fails that
 * test and the region is left as the recogniser wrote it. Fixing the words
 * themselves is the assistant's own job (services/aiService.js), where every
 * correction is checked against the transcript one at a time.
 *
 * Only what needs it is sent: a sentence longer than 35 words or 15 seconds,
 * or one over 25 words without a single comma. Across eight episodes that is
 * about a sixth of an hour's words — a fraction of a cent.
 *
 * It runs as the first step of the assistant's own run (aiService.analyzeEpisode),
 * before the summary and chapters, so every later reading sees the repaired
 * sentences — after each transcription when that switch is on, and whenever
 * the listener asks for the summary in the Player.
 *
 * The repaired wording goes to Transcripts.text_fixed, which
 * getTranscriptsForEpisode reads in preference; Transcripts.text keeps the
 * recogniser's own, so the search index and any later re-run still see it.
 */
import { getEpisodeById, getTranscriptsForEpisode, recordApiSpend, saveRepunctuation } from '../database/queries';
import { splitSentences } from './sentenceBoundary';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

const LONG_WORDS = 35;          // a sentence past this has lost a full stop
const LONG_MS = 15000;          // …or this long, when the speaker is slow
const UNBROKEN_WORDS = 25;      // …or this long with no comma at all
const PARALLEL = 4;             // regions asked at once
const REGION_MAX_WORDS = 400;   // one request's worth

// A full stop the recogniser put in the middle of a thought — "a
// well-educated man who is. steadily getting thicker" — shows as a stop
// followed by a lowercase word. The reader already reads across it, but the
// dot stays in the text (user: "there are a sentence with a dot in the
// middle"). Abbreviations and initialisms end in a dot legitimately.
const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'mt', 'ft', 'gen', 'sgt', 'capt', 'lt', 'col', 'rev', 'hon',
    'jr', 'sr', 'vs', 'no', 'etc', 'approx', 'dept', 'est', 'vol', 'fig', 'ch', 'pp', 'ed', 'op',
]);
const isMidStop = (word, next) => {
    if (!next || !/^["'“‘(]*\p{Ll}/u.test(next)) return false;
    const m = /^["'“‘(]*(.+?)[.!?]["'”’)]*$/u.exec(word);
    if (!m) return false;
    const core = m[1];
    if (/^(?:\p{L}\.)+\p{L}?$/u.test(core) || /\d$/.test(core)) return false;   // e.g., U.S., 3.
    return core.length >= 2 && !ABBREVIATIONS.has(core.toLowerCase().replace(/\.$/, ''));
};
const INSTRUCTIONS = `You restore the punctuation of an automatic transcript of an English podcast. The recogniser sometimes runs a minute of speech into a single sentence, loses the capital letters with it, or ends a sentence in the middle of one.

Return the same words, in the same order, punctuated and capitalised as a careful editor would: full stops and question marks where the sentences end, commas where the speaker breaks, a capital at the start of each sentence and on names. Split a long run into the sentences it is really made of, and join what was cut in the middle of a thought.

Never change a word. Do not add or remove one, do not reorder, do not correct a spelling, a name or a mishearing, and do not tidy away a false start, a repetition or a filler — someone is reading this while they listen, and they must find exactly what they hear. Only punctuation, capitalisation and where the sentences begin and end may change.`;

const SCHEMA = {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string' } },
};

const LETTER = /[\p{L}\p{N}]/u;
const letters = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The rows grouped into sentences, each keeping the rows it came from. */
const sentencesFromRows = (rows) => {
    const items = [];
    rows.forEach((r, row) => {
        for (const text of String(r.text || '').trim().split(/\s+/)) if (text) items.push({ text, row });
    });
    return splitSentences(items).map((ws) => ({
        from: ws[0].row,
        to: ws[ws.length - 1].row,
        words: ws.length,
        text: ws.map(w => w.text).join(' '),
        ms: (rows[ws[ws.length - 1].row]?.end_time || 0) - (rows[ws[0].row]?.start_time || 0),
        midStops: ws.reduce((n, w, i) => n + (i + 1 < ws.length && isMidStop(w.text, ws[i + 1].text) ? 1 : 0), 0),
    }));
};

/** A sentence the recogniser plainly ran together — or cut in the middle. */
const isLoose = (s) => s.words > LONG_WORDS
    || (s.words > 12 && s.ms > LONG_MS)
    || (s.words > UNBROKEN_WORDS && !/[,;:—–]/.test(s.text.slice(0, -1)))
    || s.midStops > 0;

/**
 * Row ranges worth sending, each with the sentence either side of it for
 * context. Exported for the tests.
 */
export const findLooseRegions = (rows) => {
    const sentences = sentencesFromRows(rows);
    const regions = [];
    let open = null;
    sentences.forEach((s, i) => {
        if (!isLoose(s)) return;
        // never behind a region already closed, or two requests would repair
        // the same rows and the second would overwrite the first
        const floor = open ? open.lastSentence + 1 : 0;
        const first = Math.max(0, floor, i - 1);
        if (first > i) return;
        const last = Math.min(sentences.length - 1, i + 1);
        const words = sentences.slice(first, last + 1).reduce((n, x) => n + x.words, 0);
        if (open && first <= open.lastSentence + 1 && open.words + words <= REGION_MAX_WORDS) {
            open.lastSentence = last;
            open.to = sentences[last].to;
            open.words += words;
            open.loose += 1;
            return;
        }
        open = {
            from: sentences[first].from, to: sentences[last].to,
            firstSentence: first, lastSentence: last, words, loose: 1,
        };
        regions.push(open);
    });
    return regions;
};

/**
 * The repaired text cut back into one string per row. The letters of `out`
 * are known to match the rows', so the split follows them: each row takes as
 * many letters as it had, plus the punctuation that trails it.
 */
const splitAcrossRows = (rows, from, to, out) => {
    const texts = [];
    let p = 0;
    for (let i = from; i <= to; i++) {
        const need = letters(rows[i].text).length;
        const start = p;
        let got = 0;
        while (p < out.length && got < need) {
            if (LETTER.test(out[p])) got += 1;
            p += 1;
        }
        while (p < out.length && !LETTER.test(out[p]) && !/\s/.test(out[p])) p += 1;
        texts.push(out.slice(start, p).trim());
        while (p < out.length && /\s/.test(out[p])) p += 1;
    }
    if (p < out.length && texts.length) texts[texts.length - 1] += out.slice(p).trimEnd();
    return texts;
};

/**
 * Repairs one episode's loose regions. Resolves
 * { regions, repaired, rejected, rows, cost } — `rejected` counts the
 * regions whose answer changed a word and was thrown away. Rejects only when
 * the episode or its transcript is gone.
 *
 * `request`, `model` and `price(usage)` are the assistant's (analyzeEpisode
 * passes its own), so this module needs nothing from aiService.
 */
export const repunctuateEpisode = async (episodeId, { request, model, price }) => {
    const t0 = Date.now();
    const ep = await getEpisodeById(episodeId);
    if (!ep) throw Object.assign(new Error('This episode is gone.'), { kind: 'notranscript' });
    const rows = await getTranscriptsForEpisode(episodeId);
    if (!rows.length) throw Object.assign(new Error('This episode has no transcript yet.'), { kind: 'notranscript' });
    const regions = findLooseRegions(rows);
    if (!regions.length) return { regions: 0, repaired: 0, rejected: 0, rows: 0, cost: 0 };

    const head = `Podcast: ${ep.podcast_title || ''}\nEpisode: ${ep.title || ''}`;
    const usage = { input: 0, output: 0, cached: 0 };
    const updates = [];
    let rejected = 0;
    // A few regions at a time: the summary waits on this, and one request
    // after another made an hour with twenty loose stretches take minutes.
    const repair = async (i) => {
        const { from, to } = regions[i];
        const before = rows.slice(from, to + 1).map(r => String(r.text || '').trim()).filter(Boolean).join(' ');
        try {
            const r = await request({
                instructions: INSTRUCTIONS, schemaName: 'repunctuated_text', schema: SCHEMA,
                input: `${head}\n\nText:\n${before}`,
                maxOutputTokens: Math.min(6000, regions[i].words * 4 + 400),
            });
            usage.input += r.usage?.input || 0;
            usage.output += r.usage?.output || 0;
            usage.cached += r.usage?.cached || 0;
            const after = String(r.json?.text || '').trim();
            if (!after || letters(after) !== letters(before)) { rejected += 1; return; }
            const texts = splitAcrossRows(rows, from, to, after);
            texts.forEach((text, k) => {
                const row = rows[from + k];
                if (text && text !== String(row.text || '').trim()) updates.push({ id: row.id, text });
            });
        } catch (e) {
            log('SERVICE', 'Repunctuation region failed', { id: episodeId, region: i, error: e?.message || String(e) });
            rejected += 1;
        }
    };
    let next = 0;
    const worker = async () => { while (next < regions.length) await repair(next++); };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, regions.length) }, worker));

    if (updates.length) await saveRepunctuation(episodeId, updates);
    const cost = price(usage);
    await recordApiSpend({
        provider: 'openai', service: 'punctuation', model,
        episodeId, episodeTitle: ep.title, source: ep.podcast_title,
        tokensIn: usage.input, tokensCached: usage.cached, tokensOut: usage.output, cost,
    });
    log('SERVICE', 'Repunctuation finished', {
        id: episodeId, title: ep.title, model, regions: regions.length,
        repaired: regions.length - rejected, rejected, rows: updates.length,
        tokensIn: usage.input, tokensOut: usage.output, cost: `$${cost.toFixed(4)}`, ms: Date.now() - t0,
    });
    if (updates.length) {
        try { notifyLibraryChange({ type: 'transcript-repunctuated', episodeId, rows: updates.length }); } catch (_) {}
    }
    return { regions: regions.length, repaired: regions.length - rejected, rejected, rows: updates.length, cost, usage };
};
