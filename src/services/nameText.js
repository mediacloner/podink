/**
 * People's names, corrected from the episode's own text.
 *
 * The recogniser hears names it has never seen and writes them the way they
 * sound — "Chetin Inanch", "Björger Lililian", "Nissy Schaul", "Lisa Yassik"
 * — and it cannot do better: its vocabulary has no Turkish İ, and it never
 * emits ø or ç for English speech. The episode's show notes, title and
 * author field usually spell those same people right (on The History Hour,
 * nine of the twelve misspelled names were in the notes). So this pass takes
 * the names written there as candidates, finds the capitalised runs in the
 * transcript that sound like them, and records a correction per heard
 * spelling. It says nothing about names the notes do not mention.
 *
 * Matching is on two footings: the spelling with diacritics folded (İnanç →
 * inanch) and a phonetic key with vowels and doubled letters removed
 * (Yaszek / Yassik → ask, Schaul / Shawl → $l), weighted towards the surname.
 * A full name confirmed in the transcript then propagates: its heard surname
 * and first name are fixed wherever they recur alone ("Inanch" ×14), and near
 * misses of them ("Inanc", "Bjerger", "Ura" for Uhura) mid-sentence.
 *
 * Pure text: no database, no network. `findNameCorrections` produces the
 * list, `applyNameCorrections` rewrites transcript rows with it, keeping the
 * rows' timing (one word per row in the normal case).
 */
import { extractNames } from './bookText';
import { sim } from './bookResolve';
import { isSentenceEnd } from './sentenceBoundary';

// ─── Folding ─────────────────────────────────────────────────────────────────

// Letters the recogniser has no token for, or never emits, as it hears them.
// Applied before lowercasing: 'İ'.toLowerCase() is "i" + a combining dot.
const TRANSLIT = new Map(Object.entries({
    ç: 'ch', Ç: 'ch', ş: 'sh', Ş: 'sh', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ø: 'o', Ø: 'o',
    æ: 'ae', Æ: 'ae', å: 'a', Å: 'a', ß: 'ss', ñ: 'ny', Ñ: 'ny', ł: 'l', Ł: 'l',
    þ: 'th', Þ: 'th', ð: 'd', Ð: 'd', œ: 'oe', Œ: 'oe',
}));

/** Lowercase ASCII letters and single spaces: "Çetin İnanç" → "chetin inanch". */
export const fold = (s) => Array.from(String(s || ''), ch => TRANSLIT.get(ch) ?? ch).join('')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Phonetic key of one word: consonant skeleton after common sound merges.
 *  "yassik" and "yaszek" → "ask"; "schaul" and "shawl" → "$l". */
export const keyWord = (w) => {
    let s = fold(w).replace(/\s+/g, '');
    if (!s) return '';
    s = s.replace(/x/g, 'ks')
        .replace(/tch|sch|sh|ch/g, '$')
        .replace(/ph/g, 'f')
        .replace(/ck|q/g, 'k')
        .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
        .replace(/g(?=[eiy])|dg|j/g, 'j')
        .replace(/z/g, 's')
        .replace(/th/g, 't');
    const first = /[aeiouy]/.test(s[0]) ? 'a' : s[0];
    const rest = s.slice(1).replace(/[aeiouywh]/g, '');
    return (first + rest).replace(/(.)\1+/g, '$1');
};
const keyName = (s) => fold(s).split(' ').map(keyWord).join(' ');

// ─── Candidates ──────────────────────────────────────────────────────────────

const ACRONYM = /^\p{Lu}{2,}$/u;
const INITIAL = /^\p{Lu}\.$/u;
// Capitalised runs in notes that are not people: shows, places, institutions,
// works. Any of these words in a candidate rules it out — "Turkish Star Wars"
// confirmed in the transcript would otherwise lend its "surname" to matches.
const NON_PERSON = new Set(('wars trek cup images history witness studies professor tech terrestrial service ' +
    'fiction science sporting world show podcast radio news times post university institute college school ' +
    'street road hall park prize award awards festival society company records films studios pictures ' +
    'productions television music books press games magazine journal review report daily weekly church ' +
    'hospital museum library theatre theater centre center foundation association league union party ' +
    'government department office bank group network channel corporation limited house team club ' +
    'city county state kingdom republic united nations america american british english european').split(' '));
// Roles written before a name ("Actor Peter Coyote"); ranks stay, people are
// called by them ("Lieutenant Uhura", "Captain Kirk").
const ROLE = new Set(('actor actress author writer director producer presenter host historian journalist ' +
    'commentator reporter correspondent editor doctor dr sir dame lord lady president minister senator ' +
    'judge chef singer musician composer poet novelist artist comedian coach manager guest').split(' '));

/**
 * People the episode names in its title, show notes and author field, each
 * with the forms the transcript may use: the full name, the name without
 * middle initials, first + last.
 * @returns [{ canonical, parts: [String] }]
 */
export const nameCandidates = ({ title = '', author = '', notes = '' } = {}) => {
    const seen = new Set();
    const out = [];
    for (const raw of extractNames(`${title}. ${author}. ${notes}`)) {
        const name = raw.replace(/[.,;:]+$/, '').trim();
        let parts = name.split(/\s+/).map(p => p.replace(/['’]s$/, ''));
        while (parts.length && ROLE.has(parts[0].toLowerCase())) parts = parts.slice(1);
        if (parts.length < 2 || parts.some(p => ACRONYM.test(p) || /\d/.test(p) || NON_PERSON.has(p.toLowerCase()))) continue;
        const variants = [parts];
        const noInitials = parts.filter(p => !INITIAL.test(p));
        if (noInitials.length >= 2 && noInitials.length < parts.length) variants.push(noInitials);
        if (noInitials.length > 2) variants.push([noInitials[0], noInitials[noInitials.length - 1]]);
        for (const v of variants) {
            const canonical = v.join(' ');
            const k = fold(canonical);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push({ canonical, parts: v });
        }
    }
    return out;
};

// ─── Transcript tokens ───────────────────────────────────────────────────────

const LEAD = /^[^\p{L}\p{N}]+/u;
const TRAIL = /[^\p{L}\p{N}]+$/u;
const POSSESSIVE = /['’]s$/i;

/** Rows → flat tokens: { row, text, lead, core, trail, poss, cap, sentenceStart }. */
const tokenize = (rows) => {
    const toks = [];
    rows.forEach((row, ri) => {
        for (const text of String(row.text || '').trim().split(/\s+/)) {
            if (!text) continue;
            const lead = (text.match(LEAD) || [''])[0];
            let body = text.slice(lead.length);
            const trail = (body.match(TRAIL) || [''])[0];
            body = trail ? body.slice(0, -trail.length) : body;
            let poss = '';
            if (POSSESSIVE.test(body)) { poss = body.slice(-2); body = body.slice(0, -2); }
            toks.push({ row: ri, text, lead, core: body, trail, poss, cap: /^\p{Lu}/u.test(body) });
        }
    });
    for (let i = 0; i < toks.length; i++) {
        toks[i].sentenceStart = i === 0 || isSentenceEnd(toks[i - 1].text, toks[i].text);
    }
    return toks;
};

// ─── Scoring ─────────────────────────────────────────────────────────────────

const ACCEPT = 0.78;      // weighted score for a full-name match
const STR_FLOOR = 0.6;    // never on spelling alone below this
const STR_ALONE = 0.86;   // spelling this close needs no phonetics

/** How much a heard run sounds like a candidate: folded spelling, phonetic
 *  key, and the surname's key, which carries the identity. */
const scoreName = (heardParts, candParts) => {
    const hf = heardParts.map(fold).join(' '), cf = candParts.map(fold).join(' ');
    const str = sim(hf, cf);
    if (str === 1) return { str, total: 1, exact: true };
    if (str < STR_FLOOR) return { str, total: 0 };
    const key = sim(heardParts.map(keyWord).join(' '), candParts.map(keyWord).join(' '));
    const last = sim(keyWord(heardParts[heardParts.length - 1]), keyWord(candParts[candParts.length - 1]));
    // The first name anchors the identity: "Lucas Star Wars" must not become
    // "Turkish Star Wars" on the strength of a shared last word.
    const first = heardParts.length < 2 ? 1
        : Math.max(sim(fold(heardParts[0]), fold(candParts[0])), sim(keyWord(heardParts[0]), keyWord(candParts[0])));
    if (first < 0.5) return { str, total: 0 };
    let total = 0.35 * str + 0.35 * key + 0.3 * last;
    if (str >= STR_ALONE || (str >= 0.8 && first >= 0.8)) total = Math.max(total, str);
    return { str, key, last, total, exact: false };
};

// ─── Finding corrections ─────────────────────────────────────────────────────

const MIN_PROPAGATE = 5;   // a bare first name or surname this long may be fixed alone

/**
 * Corrections for one transcript: [{ heard, canonical, count, firstMs }],
 * `heard` being the spelling as the transcript has it (case-insensitive when
 * applied). Candidates come from `nameCandidates`; rows are transcript rows.
 */
export const findNameCorrections = (rows, candidates) => {
    if (!rows?.length || !candidates?.length) return [];
    const toks = tokenize(rows);
    const found = new Map();   // fold(heard) → { heard, canonical, count, firstMs, score }
    const record = (i, n, canonical, score) => {
        const heard = toks.slice(i, i + n).map(t => t.core).join(' ');
        const k = fold(heard);
        // Cores carry no dots, so "Octavia E Butler" already is "Octavia E. Butler".
        if (!k || heard === canonical.replace(/\./g, '')) return;
        const prev = found.get(k);
        const ms = rows[toks[i].row].start_time ?? rows[toks[i].row].start ?? 0;
        if (!prev) found.set(k, { heard, canonical, count: 1, firstMs: ms, score });
        else if (prev.canonical === canonical) { prev.count += 1; prev.firstMs = Math.min(prev.firstMs, ms); }
        else if (score > prev.score) { prev.canonical = canonical; prev.score = score; }
    };
    const exactCand = new Set(candidates.map(c => fold(c.canonical)));

    // 1. Full names: windows of capitalised tokens the size of a candidate.
    const confirmed = new Map();   // canonical → { cand, heardFirsts: Set, heardLasts: Set }
    const confirm = (cand, heardParts) => {
        let c = confirmed.get(cand.canonical);
        if (!c) { c = { cand, heardFirsts: new Set(), heardLasts: new Set() }; confirmed.set(cand.canonical, c); }
        if (cand.parts.length >= 2) c.heardFirsts.add(fold(heardParts[0]));
        c.heardLasts.add(fold(heardParts[heardParts.length - 1]));
    };
    for (let i = 0; i < toks.length; i++) {
        if (!toks[i].cap) continue;
        let best = null;
        for (const cand of candidates) {
            const n = cand.parts.length;
            if (i + n > toks.length) continue;
            let ok = true;
            for (let j = i; j < i + n; j++) if (!toks[j].cap) { ok = false; break; }
            if (!ok) continue;
            const heardParts = toks.slice(i, i + n).map(t => t.core);
            if (exactCand.has(heardParts.map(fold).join(' ')) && fold(cand.canonical) !== heardParts.map(fold).join(' ')) continue;
            const s = scoreName(heardParts, cand.parts);
            if (s.exact) {
                // Same letters once folded: confirmed, and "Chetin Inanch" still
                // gets written as "Çetin İnanç".
                confirm(cand, heardParts); record(i, n, cand.canonical, 1); best = null; break;
            }
            if (s.total >= ACCEPT && (!best || s.total > best.s.total)) best = { cand, s, n, heardParts };
        }
        if (best) { confirm(best.cand, best.heardParts); record(i, best.n, best.cand.canonical, best.s.total); }
    }

    // 2. Propagation: a confirmed name's heard surname / first name, alone.
    for (const { cand, heardFirsts, heardLasts } of confirmed.values()) {
        const parts = cand.parts;
        const last = parts[parts.length - 1], first = parts[0];
        // A surname near miss may be loose ("Ura" for Uhura); a first name is a
        // common word far more often ("Mars", "George"), so it must be close.
        const targets = [{ word: last, heard: heardLasts, floor: STR_FLOOR }];
        if (parts.length >= 2 && !INITIAL.test(first)) targets.push({ word: first, heard: heardFirsts, floor: 0.8 });
        for (const { word, heard, floor } of targets) {
            const wf = fold(word);
            if (wf.length < MIN_PROPAGATE) continue;
            const wk = keyWord(word);
            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (!t.cap || t.core === word) continue;
                const tf = fold(t.core);
                if (!tf) continue;
                if (tf === wf || heard.has(tf)) { record(i, 1, word, 1); continue; }   // same letters, or the spelling seen in the full name
                if (t.sentenceStart) continue;                                         // "Person" opening a sentence is a word
                if (keyWord(t.core) === wk && sim(tf, wf) >= floor) record(i, 1, word, 0.9);
            }
        }
    }
    return [...found.values()]
        .sort((a, b) => b.count - a.count || a.heard.localeCompare(b.heard))
        .map(({ heard, canonical, count, firstMs }) => ({ heard, canonical, count, firstMs }));
};

// ─── Applying corrections ────────────────────────────────────────────────────

/**
 * Transcript rows with the corrections written in. Rows are usually one word
 * each: a heard name of k words replaced by a canonical one of m words keeps
 * the first m rows' timing when m ≤ k (the surplus rows go, their span
 * absorbed by the last kept row) and joins the extra words into the last
 * row when m > k. Returns new row objects; the input is left alone.
 */
export const applyNameCorrections = (rows, corrections) => {
    if (!rows?.length || !corrections?.length) return rows;
    const byLen = new Map();   // token count → [{ parts: [lowercase core], canonical: [words] }]
    for (const c of corrections) {
        const parts = String(c.heard).split(/\s+/).map(p => p.toLowerCase());
        const canon = String(c.canonical).split(/\s+/);
        if (!parts.length || !canon.length) continue;
        if (!byLen.has(parts.length)) byLen.set(parts.length, []);
        byLen.get(parts.length).push({ parts, canon });
    }
    const lens = [...byLen.keys()].sort((a, b) => b - a);
    const toks = tokenize(rows);
    const out = toks.map(t => ({ row: t.row, text: t.text, drop: false }));
    let changed = false;
    for (let i = 0; i < toks.length; i++) {
        let hit = null;
        for (const n of lens) {
            if (i + n > toks.length) continue;
            for (const c of byLen.get(n)) {
                let ok = true;
                for (let j = 0; j < n; j++) if (toks[i + j].core.toLowerCase() !== c.parts[j]) { ok = false; break; }
                if (ok) { hit = { n, canon: c.canon }; break; }
            }
            if (hit) break;
        }
        if (!hit) continue;
        const { n, canon } = hit;
        const m = canon.length;
        const first = toks[i], last = toks[i + n - 1];
        for (let j = 0; j < n; j++) {
            const words = j < Math.min(m, n) - 1 ? [canon[j]]
                        : j === Math.min(m, n) - 1 ? canon.slice(j)     // last kept token takes the rest
                        : [];
            if (!words.length) { out[i + j].drop = true; continue; }
            out[i + j].text = (j === 0 ? first.lead : '') + words.join(' ') +
                              (j === Math.min(m, n) - 1 ? last.poss + last.trail : '');
        }
        changed = true;
        i += n - 1;
    }
    if (!changed) return rows;

    const result = [];
    rows.forEach((row, ri) => {
        const mine = out.filter(t => t.row === ri);
        if (!mine.length) { result.push(row); return; }
        const kept = mine.filter(t => !t.drop).map(t => t.text);
        if (!kept.length) {
            // A row whose words merged into the previous one: its span goes there.
            const k = result.length - 1;
            if (k >= 0 && row.end_time != null) {
                result[k] = { ...result[k], end_time: Math.max(result[k].end_time ?? 0, row.end_time) };
            }
            return;
        }
        const text = kept.join(' ');
        result.push(text === row.text ? row : { ...row, text });
    });
    return result;
};
