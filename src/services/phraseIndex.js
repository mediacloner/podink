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
import { OBJECTS, stemVariants } from './dictionaryLookup';
import { PHRASAL_VERBS } from '../data/phrasalVerbs';

export const PHRASE_KINDS = ['phrasal', 'idiom'];

const MAX_PHRASAL = 80;
const MAX_IDIOMS = 15;

export const PHRASE_INSTRUCTIONS = `Separately, under "phrases", list the phrasal verbs and idioms the speakers use — a listener learning English will tap them.

- kind "phrasal": a verb with its particle or particles that together mean something — "pick up", "give in", "look forward to", "put up with". Include the everyday ones too — "end up", "find out", "go on", "come back" — a learner needs those most. Include the ones an object splits: "picked it up", "turned the offer down", "sort the whole thing out".
- kind "idiom": a fixed expression whose meaning is not the sum of its words — "the elephant in the room", "bite the bullet", "on the fence", "a long shot". Not a plain collocation ("make a decision") and not a literal use ("broke the ice on the pond").

For each one give:
- "surface": the words exactly as the transcript has them, copied character for character, from the verb to its last particle, or the whole idiom — at most eight words. List a phrasal verb once, under one of its wordings — the app finds its other tenses itself — and again only for a wording an object splits ("turned the offer down").
- "base": the dictionary form: the verb in its base form and generic pronouns — "pick up", "turn down", "keep your fingers crossed", "take something on board".
- "kind": phrasal or idiom.
- "meaning": for an idiom, what it means, in one plain sentence. For a phrasal verb, "".
- "origin": for an idiom, why these words have come to mean this — the picture, the practice or the story behind them — in one or two plain sentences. For a phrasal verb, "".
- "here": for an idiom, what the speaker is saying with it in this passage, in one sentence that refers to what they are talking about. For a phrasal verb, "".
- "context": for an idiom, the transcript line it appears in, copied as written. For a phrasal verb, "".

At most ${MAX_PHRASAL} phrasal verbs and ${MAX_IDIOMS} idioms for this text; when there are more, keep the idioms and the phrasal verbs said most often. Return an empty list when there are none.`;

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
const capitalised = (text) => /^\s*[^\p{L}\p{N}]*\p{Lu}/u.test(String(text || ''));

// What may stand between a phrasal verb and its particle (user: "could be
// the phrasal verb is in past or in the midle have a name or pronoum"): a
// pronoun ("picked it up"), an indefinite one ("lay everything out"), or a
// name of up to three capitalised words ("prop Assad up"). Longer objects
// ("picked the kids up") are left to the tag pass, which reads the sense.
const INDEFINITE = new Set(['everything', 'something', 'anything', 'nothing', 'everyone', 'someone', 'anyone',
    'everybody', 'somebody', 'anybody', 'nobody', 'all', 'both', 'each', 'one', 'ones', 'this', 'that', 'these', 'those']);
/** Index just after the object that starts at j, or j when there is none. */
const objectEnd = (toks, caps, stops, j, particle) => {
    const t = toks[j];
    if (!t || t === particle || stops[j - 1]) return j;
    if ((OBJECTS.has(t) || INDEFINITE.has(t)) && !stops[j]) return j + 1;
    let k = j;
    while (k < j + 3 && caps[k] && toks[k] && toks[k] !== particle && !stops[k]) k++;
    return k;
};

/**
 * Which transcript words belong to which phrase: an Int32Array indexed by
 * the words' globalIndex, holding the EpisodePhrases id — negative for an
 * idiom, so a word knows how to look without asking — and 0 for none.
 *
 * An idiom is marked whole. A phrasal verb is marked on the verb, its
 * particles and a pronoun between them ("picked it up") — not on a longer
 * object ("picked the kids up"), whose words keep their own lookups. Each
 * phrase is looked for as it was heard and in its dictionary form, and a
 * phrasal verb with its verb in any tense and a pronoun object in between,
 * so "end up" also marks "ended up" and "ends up", and "pick up" "picked
 * it up", anywhere in the hour. Idioms go first: "pick up the pieces" is the
 * idiom, not the phrasal verb inside it.
 */
export const buildPhraseMarks = (chunks, phrases) => {
    let total = 0;
    for (const ch of chunks || []) for (const w of ch.words) if (w.globalIndex + 1 > total) total = w.globalIndex + 1;
    const marks = new Int32Array(total);
    if (!total || !phrases?.length) return marks;

    const toks = new Array(total).fill('');
    const stops = new Uint8Array(total);
    const caps = new Uint8Array(total);
    for (const ch of chunks) {
        for (const w of ch.words) {
            toks[w.globalIndex] = normTok(w.text);
            stops[w.globalIndex] = endsSentence(w.text) ? 1 : 0;
            caps[w.globalIndex] = capitalised(w.text) ? 1 : 0;
        }
    }

    // Does a transcript word stand for this base verb in some tense?
    const formMemo = new Map();
    const isFormOf = (tok, verb) => {
        if (tok === verb) return true;
        let forms = formMemo.get(tok);
        if (!forms) { forms = stemVariants(tok); formMemo.set(tok, forms); }
        return forms.includes(verb);
    };
    const free = (i) => i < total && !marks[i];

    const ordered = [...phrases.filter(p => p.kind === 'idiom'), ...phrases.filter(p => p.kind !== 'idiom')];
    for (const p of ordered) {
        const id = Number(p.id) || 0;
        if (!id) continue;
        const mark = p.kind === 'idiom' ? -id : id;
        const tail = new Set(tokensOf(p.base).slice(1));
        const variants = [tokensOf(p.surface)];
        const baseToks = tokensOf(p.base);
        if (baseToks.join(' ') !== variants[0].join(' ')) variants.push(baseToks);
        if (p.known) variants.length = 0;   // found by the list: only the checked pass below
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
        // Any tense of the verb, then its particles, with a short object
        // allowed straight after the verb (objectEnd).
        if (p.kind !== 'phrasal' || baseToks.length < 2) continue;
        const [verb, ...parts] = baseToks;
        for (let i = 0; i < total; i++) {
            if (!free(i) || stops[i] || !isFormOf(toks[i], verb)) continue;
            let j = objectEnd(toks, caps, stops, i + 1, parts[0]);
            for (let k = i + 1; k < j; k++) if (!free(k)) j = -1;
            if (j < 0) continue;
            let ok = true;
            for (let k = 0; ok && k < parts.length; k++) {
                if (!free(j + k) || toks[j + k] !== parts[k] || (k < parts.length - 1 && stops[j + k])) ok = false;
            }
            // Found without the model, a verb and particle followed by "the"
            // are a verb and its preposition.
            if (ok && p.known && parts.length === 1 && !stops[j] && PREP_OBJECT.test(toks[j + 1] || '')) ok = false;
            if (!ok) continue;
            // The verb, a pronoun between and the particles; a name keeps its own mark.
            for (let m = i; m < j + parts.length; m++) if (!(m > i && m < j && caps[m])) marks[m] = mark;
            i = j + parts.length - 1;
        }
    }
    return marks;
};

// After a particle, a word that makes it a preposition instead: "went on the
// bus", "ended in 1945" are not "go on", "end in".
const PREP_OBJECT = /^(the|a|an|this|that|these|those|my|your|his|her|its|our|their|\d.*)$/;

/** Ids of the phrasal verbs found without the model, above any table id. */
export const KNOWN_PHRASAL_BASE = 1e8;

/**
 * The phrasal verbs of the dictionary list (data/phrasalVerbs.js) said in
 * the transcript that the tag pass did not list — the everyday ones it
 * passes over ("prop up Assad"). Each comes back as a phrase row of its own
 * with an id from KNOWN_PHRASAL_BASE, `known: true`, for buildPhraseMarks to
 * mark and a tap to look up like any other.
 */
export const knownPhrasals = (chunks, phrases) => {
    const words = [];
    for (const ch of chunks || []) for (const w of ch.words) words[w.globalIndex] = w;
    const toks = words.map(w => normTok(w?.text));
    const stops = words.map(w => (endsSentence(w?.text) ? 1 : 0));
    const caps = words.map(w => (capitalised(w?.text) ? 1 : 0));
    const have = new Set((phrases || []).map(p => tokensOf(p.base).join(' ')));
    const memo = new Map();
    const formsOf = (t) => { let f = memo.get(t); if (!f) { f = stemVariants(t); memo.set(t, f); } return f; };
    const found = [];
    const add = (base) => {
        if (have.has(base)) return;
        have.add(base);
        found.push({ id: KNOWN_PHRASAL_BASE + found.length + 1, kind: 'phrasal', surface: base, base, known: true });
    };
    for (let i = 0; i + 1 < toks.length; i++) {
        const t = toks[i];
        if (!t || OBJECTS.has(t) || stops[i]) continue;
        for (const v of formsOf(t)) {
            // Straight after the verb, or after a short object: "prop Assad up".
            const direct = PHRASAL_VERBS.has(`${v} ${toks[i + 1]}`) || PHRASAL_VERBS.has(`${v} ${toks[i + 1]} ${toks[i + 2]}`);
            const after = direct ? i + 1 : objectEnd(toks, caps, stops, i + 1, '');
            const three = `${v} ${toks[after]} ${toks[after + 1]}`;
            if (PHRASAL_VERBS.has(three)) { add(three); break; }
            const two = `${v} ${toks[after]}`;
            if (PHRASAL_VERBS.has(two) && !PREP_OBJECT.test(toks[after + 1] || '')) { add(two); break; }
        }
    }
    return found;
};

/** The EpisodePhrases id a mark stands for, and whether it is an idiom. */
export const phraseIdOf = (mark) => Math.abs(Number(mark) || 0);
export const isIdiomMark = (mark) => Number(mark) < 0;
