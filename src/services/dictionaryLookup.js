/**
 * dictionaryLookup.js — how a tapped transcript word becomes a dictionary
 * entry. A port of the scanning pen's viewer (penReader scan-bridge) to a
 * tap in a sentence, and pure: `dict` is anything with `findKeys(word)` →
 * [{ key, off }] and `readRecord(off)` → string (see mdx.js).
 *
 * Steps, in the pen's order:
 *  1. Candidates. The pen tries the whole scan, then shorter windows, then
 *     single words. A tap has one word — but it also has the sentence, so
 *     the candidates are the phrasal verbs the word could be part of in
 *     place ("gave up", "gave it up", "look forward to") followed by the
 *     word itself. A phrase is only ever *offered*; whether it is real is
 *     decided by the dictionary (it is a headword, or the base verb's entry
 *     defines it under a bold heading — see analyzeEntry).
 *  2. Exact keys, then inflections. Keys match on their folded form (case,
 *     accents and punctuation ignored) but must have the same number of
 *     words and the same affix hyphens ("look up" is not the noun "look-up",
 *     "looking" is not the suffix "-looking"). A miss retries plausible base
 *     forms — possessive, plural, -ed/-ing/-er, irregular verbs — for the
 *     dictionaries that carry no redirect records (Oxford Advanced 8th).
 *  3. Redirects. Inflected forms are stored as `@@@LINK=<base>` records,
 *     one per source entry, often several per key and sometimes to two
 *     different bases ("analyses" → analyse / analysis). Each record is
 *     resolved on its own before any HTML is assembled; a key's real records
 *     win over its redirects; a visited set and a depth cap contain mutual
 *     redirect pairs. No `@@@LINK=` text can reach the screen.
 *  4. Phrasal verb inside the base entry. Ten of the twelve dictionaries
 *     don't index phrasal verbs as headwords but define them inside the
 *     verb, far down. When the phrase isn't a headword, the entry is scanned
 *     for the bold heading that *is* the phrase (with the inflection undone:
 *     "gave up" → "give up") and the card jumps there. An irregular form
 *     whose own entry is only a grammar stub ("gave: past tense of give")
 *     hands over to the base entry when that is where the phrase lives.
 */
import { findPhrase, flattenEntry } from './dictionaryHtml';

const LINK_RE = /^\s*@@@LINK=([^\r\n]+)/i;
const REDIRECT_LIMIT = 4;
const ALTERNATES = 6;

// ── Tokens ───────────────────────────────────────────────────────────────────

/** Trims a transcript token to the word: edge punctuation off, inner ' and - kept. */
export const cleanToken = (t) =>
    String(t || '').trim().replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

// Particles and prepositions that turn a verb into a phrasal/prepositional
// verb. Broad on purpose — false positives are filtered by the dictionary.
export const PARTICLES = new Set([
    'up', 'down', 'out', 'off', 'on', 'in', 'over', 'away', 'back', 'through', 'into', 'along', 'around', 'round',
    'about', 'after', 'for', 'by', 'forward', 'together', 'apart', 'across', 'ahead', 'aside', 'behind', 'forth',
    'to', 'with', 'at', 'from', 'of', 'onto', 'upon', 'under', 'without', 'against', 'past',
]);
// Objects that can sit between a verb and its particle: "gave it up".
export const OBJECTS = new Set([
    'it', 'them', 'him', 'her', 'me', 'us', 'you', 'this', 'that', 'these', 'those', 'something', 'someone',
    'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves', 'themselves', 'one',
]);

const lower = (s) => String(s || '').toLowerCase();
const wordCount = (s) => String(s).trim().split(/\s+/).length;
const affixShape = (s) => (s.startsWith('-') ? 'L' : '') + (s.endsWith('-') ? 'R' : '');

/**
 * Phrasal-verb candidates around a tapped word, longest first:
 *   tapped verb + particle(s): "look forward to", "gave up"
 *   tapped verb + object + particle: "gave it up" → "gave up"
 *   tapped particle after a verb: tapping "up" in "gave up" / "gave it up"
 * When the tapped word is itself a particle, the verb before it is the
 * likelier reading and its phrases come first.
 */
export const contextPhrases = ({ word, prevWords = [], nextWords = [] }) => {
    const w = cleanToken(word);
    if (!w) return [];
    const n = nextWords.map(cleanToken).filter(Boolean);
    const p = prevWords.map(cleanToken).filter(Boolean);
    const ahead = [];
    const behind = [];
    const add = (list, parts) => {
        const phrase = parts.join(' ');
        if (parts.length > 1 && !list.includes(phrase)) list.push(phrase);
    };
    const n1 = lower(n[0]);
    const n2 = lower(n[1]);
    if (PARTICLES.has(n1)) {
        if (PARTICLES.has(n2)) add(ahead, [w, n[0], n[1]]);
        add(ahead, [w, n[0]]);
    } else if (OBJECTS.has(n1) && PARTICLES.has(n2)) {
        add(ahead, [w, n[1]]);
    }
    const tappedParticle = PARTICLES.has(lower(w));
    if (tappedParticle && p.length) {
        const p1 = p[p.length - 1];
        const p2 = p[p.length - 2];
        if (OBJECTS.has(lower(p1)) && p2) add(behind, [p2, w]);
        else if (PARTICLES.has(lower(p1)) && p2 && !OBJECTS.has(lower(p2))) add(behind, [p2, p1, w]);
        else if (!PARTICLES.has(lower(p1)) && !OBJECTS.has(lower(p1))) add(behind, [p1, w]);
    }
    const out = tappedParticle ? [...behind, ...ahead] : [...ahead, ...behind];
    return out.filter((x, i) => out.indexOf(x) === i);
};

// ── Inflections ──────────────────────────────────────────────────────────────

const IRREGULAR = {
    was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be',
    had: 'have', has: 'have', did: 'do', does: 'do', done: 'do',
    went: 'go', gone: 'go', goes: 'go', gave: 'give', given: 'give', took: 'take', taken: 'take',
    came: 'come', saw: 'see', seen: 'see', made: 'make', got: 'get', gotten: 'get', ran: 'run',
    said: 'say', told: 'tell', thought: 'think', knew: 'know', known: 'know', found: 'find',
    left: 'leave', felt: 'feel', brought: 'bring', bought: 'buy', began: 'begin', begun: 'begin',
    kept: 'keep', held: 'hold', wrote: 'write', written: 'write', stood: 'stand', heard: 'hear',
    meant: 'mean', met: 'meet', paid: 'pay', sat: 'sit', spoke: 'speak', spoken: 'speak',
    spent: 'spend', taught: 'teach', understood: 'understand', won: 'win', broke: 'break', broken: 'break',
    chose: 'choose', chosen: 'choose', drove: 'drive', driven: 'drive', ate: 'eat', eaten: 'eat',
    fell: 'fall', fallen: 'fall', flew: 'fly', flown: 'fly', forgot: 'forget', forgotten: 'forget',
    grew: 'grow', grown: 'grow', hid: 'hide', hidden: 'hide', lay: 'lie', lain: 'lie', lost: 'lose',
    rose: 'rise', risen: 'rise', sold: 'sell', sent: 'send', shook: 'shake', shaken: 'shake',
    showed: 'show', shown: 'show', sang: 'sing', sung: 'sing', slept: 'sleep', threw: 'throw', thrown: 'throw',
    woke: 'wake', woken: 'wake', wore: 'wear', worn: 'wear', drew: 'draw', drawn: 'draw', built: 'build',
    caught: 'catch', dealt: 'deal', fought: 'fight', led: 'lead', lent: 'lend', lit: 'light', sought: 'seek',
    struck: 'strike', swore: 'swear', sworn: 'swear', drank: 'drink', drunk: 'drink', swam: 'swim', swum: 'swim',
    stole: 'steal', stolen: 'steal', rode: 'ride', ridden: 'ride', froze: 'freeze', frozen: 'freeze',
    bit: 'bite', bitten: 'bite', blew: 'blow', blown: 'blow', bent: 'bend', bound: 'bind', bled: 'bleed',
    bred: 'breed', burnt: 'burn', crept: 'creep', dug: 'dig', fed: 'feed', fled: 'flee', flung: 'fling',
    forgave: 'forgive', forgiven: 'forgive', hung: 'hang', laid: 'lay', leapt: 'leap',
    rang: 'ring', rung: 'ring', sank: 'sink', sunk: 'sink', shot: 'shoot',
    shrank: 'shrink', slid: 'slide', spun: 'spin', spat: 'spit',
    sprang: 'spring', stuck: 'stick', stung: 'sting', stank: 'stink', strove: 'strive', swept: 'sweep',
    swung: 'swing', tore: 'tear', torn: 'tear', trod: 'tread', wept: 'weep', wound: 'wind', withdrew: 'withdraw',
    withdrawn: 'withdraw', wrung: 'wring', arose: 'arise', arisen: 'arise', awoke: 'awake', became: 'become',
    befell: 'befall', beheld: 'behold', clung: 'cling',
    forbade: 'forbid', forbidden: 'forbid', foresaw: 'foresee', foreseen: 'foresee', mistook: 'mistake',
    mistaken: 'mistake', overcame: 'overcome', oversaw: 'oversee', overtook: 'overtake', undertook: 'undertake',
    undertaken: 'undertake', sped: 'speed', sewn: 'sew', sown: 'sow',
    children: 'child', people: 'person', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth',
    mice: 'mouse', geese: 'goose', lives: 'life', wives: 'wife', knives: 'knife', leaves: 'leaf', halves: 'half',
    better: 'good', best: 'good', worse: 'bad', worst: 'bad', further: 'far', farther: 'far',
};

/** Base forms a single inflected word could come from, most likely first. */
export const stemVariants = (word) => {
    const w = lower(cleanToken(word));
    const out = [];
    const add = (v) => { if (v && v.length > 1 && !out.includes(v)) out.push(v); };
    add(w);
    const noPoss = w.replace(/'s$/, '').replace(/s'$/, 's');
    add(noPoss);
    if (IRREGULAR[noPoss]) add(IRREGULAR[noPoss]);
    const s = noPoss;
    if (s.endsWith('ies') && s.length > 4) add(s.slice(0, -3) + 'y');
    if (s.endsWith('es') && s.length > 4) add(s.slice(0, -2));
    if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) add(s.slice(0, -1));
    if (s.endsWith('ied') && s.length > 4) add(s.slice(0, -3) + 'y');
    if (s.endsWith('ed') && s.length > 4) {
        add(s.slice(0, -2));
        add(s.slice(0, -1));
        if (s.length > 5 && s[s.length - 3] === s[s.length - 4]) add(s.slice(0, -3));
    }
    if (s.endsWith('ing') && s.length > 5) {
        add(s.slice(0, -3));
        add(s.slice(0, -3) + 'e');
        if (s[s.length - 4] === s[s.length - 5]) add(s.slice(0, -4));
    }
    if (s.endsWith('iest') && s.length > 5) add(s.slice(0, -4) + 'y');
    if (s.endsWith('est') && s.length > 5) { add(s.slice(0, -3)); add(s.slice(0, -2)); if (s[s.length - 4] === s[s.length - 5]) add(s.slice(0, -4)); }
    if (s.endsWith('ier') && s.length > 4) add(s.slice(0, -3) + 'y');
    if (s.endsWith('er') && s.length > 4) { add(s.slice(0, -2)); add(s.slice(0, -1)); if (s[s.length - 3] === s[s.length - 4]) add(s.slice(0, -3)); }
    if (s.endsWith('ly') && s.length > 4) { add(s.slice(0, -2)); if (s.endsWith('ily')) add(s.slice(0, -3) + 'y'); }
    return out;
};

/** Variants of a multi-word phrase: the first (verb) token de-inflected. */
export const phraseVariants = (phrase) => {
    const parts = String(phrase).trim().split(/\s+/);
    if (parts.length < 2) return stemVariants(phrase);
    const rest = parts.slice(1).join(' ').toLowerCase();
    return stemVariants(parts[0]).map(v => `${v} ${rest}`);
};

// ── Records & redirects ──────────────────────────────────────────────────────

export const redirectTarget = (record) => {
    const m = LINK_RE.exec(record || '');
    return m ? m[1].trim() : null;
};

/**
 * Keys that may stand for `candidate`: same folded form (findKeys), same
 * number of words, same affix hyphens. Among those, the spelling closest to
 * what was tapped wins: the lower-case key, then the exact key, then any —
 * so "ran" follows its redirect to run rather than landing on the
 * abbreviation RAN, and a sentence-initial "Children" still means child.
 */
const keysFor = (dict, candidate) => {
    const all = dict.findKeys(candidate).filter(k =>
        wordCount(k.key) === wordCount(candidate) && affixShape(k.key) === affixShape(candidate));
    if (all.length <= 1) return all;
    const low = candidate.toLowerCase();
    const tier1 = all.filter(k => k.key === low);
    if (tier1.length) return tier1;
    const tier2 = all.filter(k => k.key === candidate);
    if (tier2.length) return tier2;
    return all;
};

/**
 * Records for one key, redirects followed. `bodies` are real HTML records
 * (deduplicated, in file order); `targets` the base forms the redirects
 * named; `alternates` base forms named by a key that also has records of its
 * own — its own win, but an irregular form whose only record is a grammar
 * stub would otherwise hide the real entry, so they are offered as chips.
 */
const resolveKey = (dict, key, depth, out) => {
    const k = String(key || '').trim();
    if (!k || depth > REDIRECT_LIMIT) return;
    const visitKey = k.toLowerCase();
    if (out.visited.has(visitKey)) return;
    out.visited.add(visitKey);
    const keys = depth === 0 ? keysFor(dict, k) : dict.findKeys(k).filter(x => wordCount(x.key) === wordCount(k));
    if (!keys.length) return;
    const links = [];
    let direct = false;
    for (const { key: spelled, off } of keys) {
        const record = dict.readRecord(off);
        const target = redirectTarget(record);
        if (target == null) {
            const body = (record || '').trim();
            if (body && !out.bodySet.has(body)) {
                out.bodySet.add(body);
                out.bodies.push(body);
                direct = true;
                if (!out.entry) out.entry = spelled;
            }
        } else {
            links.push(target);
        }
    }
    if (direct) {
        for (const target of links) {
            const fold = target.toLowerCase();
            if (fold === visitKey || out.alternates.size >= ALTERNATES) continue;
            if (!out.alternates.has(fold)) out.alternates.set(fold, target);
        }
        return;
    }
    for (const target of links) {
        const fold = target.toLowerCase();
        if (!out.targets.has(fold)) out.targets.set(fold, target);
        resolveKey(dict, target, depth + 1, out);
    }
};

/**
 * Resolves a candidate (word or phrase) to its records: the exact key first,
 * then inflection variants until one has records. Null when nothing does.
 */
export const resolveEntry = (dict, candidate) => {
    const isPhrase = /\s/.test(candidate.trim());
    const variants = isPhrase ? phraseVariants(candidate) : stemVariants(candidate);
    const tried = [candidate, ...variants.filter(v => v !== candidate.toLowerCase())];
    for (const attempt of tried) {
        const out = {
            entry: null, bodies: [], bodySet: new Set(), visited: new Set(),
            targets: new Map(), alternates: new Map(),
        };
        resolveKey(dict, attempt, 0, out);
        if (out.bodies.length) {
            return {
                attempt,                                  // the spelling that answered
                entry: out.entry || attempt,              // key of the first real record
                viaVariant: attempt !== candidate,
                bodies: out.bodies,
                targets: [...out.targets.values()],
                alternates: [...out.alternates.values()],
            };
        }
    }
    return null;
};

// The pen's lookup trail — how the tap became the entry on screen:
// “gave up” → give up   ·   gave → give   ·   “axes” → ax / axis
const buildTrail = (candidate, word, entry, targets) => {
    const trail = [];
    const push = (t) => { if (t && !trail.some(x => x.toLowerCase() === t.toLowerCase())) trail.push(t); };
    push(candidate === word ? word : `“${candidate}”`);
    if (entry.toLowerCase() !== candidate.toLowerCase()) push(entry);
    if (targets.length) {
        const names = targets.join(' / ');
        if (targets.length > 1 || targets[0].toLowerCase() !== trail[trail.length - 1].toLowerCase()) push(names);
    }
    return trail.length > 1 ? trail : [];
};

// Spellings of a phrase to look for inside a base entry: as tapped, then
// with the tapped word replaced by each base form the dictionary named.
const phraseSpellings = (phrases, word, bases) => {
    const out = [];
    const add = (p) => { if (p && !out.some(x => x.toLowerCase() === p.toLowerCase())) out.push(p); };
    for (const phrase of phrases) {
        const parts = phrase.split(' ');
        const idx = parts.findIndex(t => t.toLowerCase() === word.toLowerCase());
        add(phrase);
        if (idx >= 0) for (const base of bases) add([...parts.slice(0, idx), base, ...parts.slice(idx + 1)].join(' '));
    }
    return out;
};

// ── The lookup ───────────────────────────────────────────────────────────────

/**
 * @param dict    opened dictionary (findKeys / readRecord)
 * @param query   { word, prevWords, nextWords, forceWord }
 *                forceWord: skip the phrasal candidates (user asked for the word itself)
 * @returns null when nothing matched, else
 *   { tapped, phrases, candidate, entry, bodies, targets, alternates,
 *     phraseIsEntry, phraseTries, trail }
 */
export const lookupEntry = (dict, query) => {
    const word = cleanToken(query.word);
    if (!word) return null;
    const phrases = query.forceWord ? [] : contextPhrases({ word, prevWords: query.prevWords, nextWords: query.nextWords });
    const candidates = [...phrases, word];
    let hit = null;
    let candidate = null;
    for (const c of candidates) {
        hit = resolveEntry(dict, c);
        if (hit) { candidate = c; break; }
    }
    if (!hit) return null;

    const entryHasSpace = /\s/.test(hit.entry.trim());
    const phraseIsEntry = candidate !== word && entryHasSpace;
    const phraseTries = phrases.length && !entryHasSpace
        ? phraseSpellings(phrases, word, [hit.entry, ...hit.targets, ...hit.alternates])
        : [];

    return {
        tapped: word,
        phrases,
        candidate,
        entry: hit.entry,
        bodies: hit.bodies,
        targets: hit.targets,
        alternates: hit.alternates,
        phraseIsEntry,
        phraseTries,
        trail: buildTrail(candidate, word, hit.entry, hit.targets),
    };
};

const locateIn = (flats, tries) => {
    for (const phrase of tries) {
        for (let b = 0; b < flats.length; b++) {
            const at = findPhrase(flats[b], phrase);
            if (at) return { highlight: { bodyIndex: b, ...at }, phraseFound: phrase };
        }
    }
    return null;
};

/**
 * Flattens the entry's records for rendering and finds the phrasal-verb
 * heading to jump to, if the tap was inside one.
 *
 * When the phrase isn't defined in the entry that answered, the base forms
 * the dictionary itself pointed at (alternates, redirect targets) and the
 * de-inflected word are tried: an irregular past tense often has only a
 * stub of its own ("gave: past tense of give") while the phrasal verb is
 * defined under the base. If one of them has the heading, that entry is
 * shown instead and the trail says so.
 *
 * @returns { result, flats, highlight, phraseFound }
 *          highlight = { bodyIndex, paraIndex, start, end, heading } | null
 */
export const analyzeEntry = (dict, result, styleKey) => {
    let flats = result.bodies.map(html => flattenEntry(html, { styleKey }));
    if (!result.phrases?.length || result.phraseIsEntry) {
        return { result, flats, highlight: null, phraseFound: '' };
    }
    let found = locateIn(flats, result.phraseTries);
    if (found) return { result, flats, ...found };

    const word = result.tapped;
    const seen = new Set([result.entry.toLowerCase(), word.toLowerCase()]);
    const fallbacks = [...result.alternates, ...result.targets, ...stemVariants(word)]
        .filter(b => b && !/\s/.test(b) && !seen.has(b.toLowerCase()) && seen.add(b.toLowerCase()));
    for (const base of fallbacks) {
        const hit = resolveEntry(dict, base);
        if (!hit || /\s/.test(hit.entry.trim())) continue;
        const altFlats = hit.bodies.map(html => flattenEntry(html, { styleKey }));
        const tries = phraseSpellings(result.phrases, word, [hit.entry, base, ...hit.targets]);
        found = locateIn(altFlats, tries);
        if (found) {
            const switched = {
                ...result,
                entry: hit.entry,
                bodies: hit.bodies,
                targets: hit.targets,
                alternates: hit.alternates,
                trail: buildTrail(word, word, hit.entry, hit.targets),
            };
            return { result: switched, flats: altFlats, ...found };
        }
    }
    return { result, flats, highlight: null, phraseFound: '' };
};
