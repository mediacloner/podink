/**
 * The phrases an episode uses (5.5.0): phrasal verbs and idioms, found by
 * the same model pass that lists what the episode names (entityIndex.js),
 * because that pass has already read the whole transcript and a second
 * reading would double the cost for nothing.
 *
 * Tapping a word used to guess its phrase from the few words around it
 * (dictionaryLookup.contextPhrases), which finds "pick up" but not "picked
 * the kids up", and never knows an idiom from a literal run of words. The
 * model knows both. Each phrase comes back as the words the transcript has
 * ("picked it up") and the dictionary form ("pick up"); a tap on any marked
 * word of it asks the dictionary for that form and nothing else. An idiom
 * also comes with what it means, why its words mean that, and what the
 * speaker uses it for there — which is what its own card shows.
 *
 * As with the names, the words must be in the transcript: a phrase the
 * model merely believes was said is dropped.
 */
import { countPhrase } from './nameText';
import { OBJECTS } from './dictionaryLookup';

export const PHRASE_KINDS = ['phrasal', 'idiom'];

const MAX_PHRASAL = 40;
const MAX_IDIOMS = 15;

export const PHRASE_INSTRUCTIONS = `Separately, under "phrases", list the phrasal verbs and idioms the speakers use — a listener learning English will tap them.

- kind "phrasal": a verb with its particle or particles that together mean something — "pick up", "give in", "look forward to", "put up with". Include the ones an object splits: "picked it up", "turned the offer down", "sort the whole thing out".
- kind "idiom": a fixed expression whose meaning is not the sum of its words — "the elephant in the room", "bite the bullet", "on the fence", "a long shot". Not a plain collocation ("make a decision") and not a literal use ("broke the ice on the pond").

For each one give:
- "surface": the words exactly as the transcript has them, copied character for character, from the verb to its last particle, or the whole idiom — at most eight words. List each different wording once.
- "base": the dictionary form: the verb in its base form and generic pronouns — "pick up", "turn down", "keep your fingers crossed", "take something on board".
- "kind": phrasal or idiom.
- "meaning": for an idiom, what it means, in one plain sentence. For a phrasal verb, "".
- "origin": for an idiom, why these words have come to mean this — the picture, the practice or the story behind them — in one or two plain sentences. For a phrasal verb, "".
- "here": for an idiom, what the speaker is saying with it in this passage, in one sentence that refers to what they are talking about. For a phrasal verb, "".
- "context": the transcript line it appears in, copied as written.

At most ${MAX_PHRASAL} phrasal verbs and ${MAX_IDIOMS} idioms for this text, the least obvious first. Return an empty list when there are none.`;

export const PHRASE_SCHEMA = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        required: ['surface', 'base', 'kind', 'meaning', 'origin', 'here', 'context'],
        properties: {
            surface: { type: 'string' },
            base: { type: 'string' },
            kind: { type: 'string', enum: PHRASE_KINDS },
            meaning: { type: 'string' },
            origin: { type: 'string' },
            here: { type: 'string' },
            context: { type: 'string' },
        },
    },
};

const trim = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const normTok = (t) => String(t || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, '').replace(/^'+|'+$/g, '');
const tokensOf = (s) => String(s || '').split(/\s+/).map(normTok).filter(Boolean);

/** Where the quoted line is, or where the phrase is first said. */
const firstMsOf = (rows, surface, context) => {
    const words = String(context || '').split(/\s+/).filter(Boolean);
    for (const n of [8, 6, 4]) {
        if (words.length < n) continue;
        const line = countPhrase(rows, words.slice(0, n).join(' '));
        if (line.count) return line.firstMs;
    }
    return countPhrase(rows, surface).firstMs;
};

/** The phrases the transcript can vouch for, deduplicated, idioms first. */
export const acceptPhrases = (raw, rows) => {
    const kept = [];
    const seen = new Set();
    for (const p of raw || []) {
        if (!PHRASE_KINDS.includes(p?.kind)) continue;
        const surface = trim(p.surface, 120);
        const base = trim(p.base, 120).toLowerCase() || surface.toLowerCase();
        const st = tokensOf(surface);
        const bt = tokensOf(base);
        if (st.length < 2 || st.length > 10 || bt.length < 2) continue;
        if (p.kind === 'phrasal') {
            // A phrasal verb ends on its particle, and that particle is in
            // what was said: "picked it up" → "pick up".
            if (bt.length > 4 || !st.includes(bt[bt.length - 1])) continue;
        } else if (!trim(p.meaning, 10)) continue;   // an idiom card needs its meaning
        // A phrasal verb is kept once per wording, so each is marked; an
        // idiom once in all, since it has one card ("still on the table" and
        // "on the table" are the same idiom).
        const key = p.kind === 'idiom' ? `idiom|${bt.join(' ')}` : `phrasal|${st.join(' ')}`;
        if (seen.has(key)) continue;
        const hit = countPhrase(rows, surface);
        if (!hit.count) continue;                    // not in the text: dropped
        seen.add(key);
        kept.push({
            kind: p.kind, surface, base,
            meaning: p.kind === 'idiom' ? trim(p.meaning, 400) : '',
            origin: p.kind === 'idiom' ? trim(p.origin, 600) : '',
            here: p.kind === 'idiom' ? trim(p.here, 400) : '',
            context: trim(p.context, 400),
            count: hit.count,
            firstMs: firstMsOf(rows, surface, p.context),
        });
    }
    return [...kept.filter(p => p.kind === 'idiom'), ...kept.filter(p => p.kind === 'phrasal')];
};

// A word that ends a sentence: a phrase does not run on past it.
const endsSentence = (text) => /[.!?…]["”’)\]]*\s*$/.test(String(text || ''));

/**
 * Which transcript words belong to which phrase: an Int32Array indexed by
 * the words' globalIndex, holding the EpisodePhrases id — negative for an
 * idiom, so a word knows how to look without asking — and 0 for none.
 *
 * An idiom is marked whole. A phrasal verb is marked on the verb, its
 * particles and a pronoun between them ("picked it up") — not on a longer
 * object ("picked the kids up"), whose words keep their own lookups. Each
 * phrase is looked for as it was heard and in its dictionary form, so
 * "pick up" said elsewhere in the hour is marked too. Idioms go first: "pick
 * up the pieces" is the idiom, not the phrasal verb inside it.
 */
export const buildPhraseMarks = (chunks, phrases) => {
    let total = 0;
    for (const ch of chunks || []) for (const w of ch.words) if (w.globalIndex + 1 > total) total = w.globalIndex + 1;
    const marks = new Int32Array(total);
    if (!total || !phrases?.length) return marks;

    const toks = new Array(total).fill('');
    const stops = new Uint8Array(total);
    for (const ch of chunks) {
        for (const w of ch.words) {
            toks[w.globalIndex] = normTok(w.text);
            stops[w.globalIndex] = endsSentence(w.text) ? 1 : 0;
        }
    }

    const ordered = [...phrases.filter(p => p.kind === 'idiom'), ...phrases.filter(p => p.kind !== 'idiom')];
    for (const p of ordered) {
        const id = Number(p.id) || 0;
        if (!id) continue;
        const mark = p.kind === 'idiom' ? -id : id;
        const tail = new Set(tokensOf(p.base).slice(1));
        const variants = [tokensOf(p.surface)];
        const baseToks = tokensOf(p.base);
        if (baseToks.join(' ') !== variants[0].join(' ')) variants.push(baseToks);
        for (const v of variants) {
            const L = v.length;
            if (L < 2) continue;
            for (let i = 0; i + L <= total; i++) {
                let ok = true;
                for (let k = 0; ok && k < L; k++) {
                    if (toks[i + k] !== v[k] || marks[i + k]) ok = false;
                    else if (k < L - 1 && stops[i + k]) ok = false;
                }
                if (!ok) continue;
                for (let k = 0; k < L; k++) {
                    const t = toks[i + k];
                    if (p.kind === 'idiom' || k === 0 || tail.has(t) || OBJECTS.has(t)) marks[i + k] = mark;
                }
                i += L - 1;
            }
        }
    }
    return marks;
};

/** The EpisodePhrases id a mark stands for, and whether it is an idiom. */
export const phraseIdOf = (mark) => Math.abs(Number(mark) || 0);
export const isIdiomMark = (mark) => Number(mark) < 0;
