// Where a sentence ends in recognizer output.
//
// Both Parakeet models punctuate and capitalise, so a full stop, question or
// exclamation mark is the sentence boundary the reader, the export and the
// window fallback all split on. A full stop is not always an end, though:
// "E.T. phone home", "Mr. Loomis", "the U.S. market". The old rule — any word
// ending in . ? ! — cut "E.T." into a chunk of its own every time it was said
// (The History Hour, 2026-09-09). Three signals settle it: a title never ends
// one, an abbreviation or initialism ends it only when a capitalised word
// follows, and a lowercase next word means the stop was inside the sentence.

// A title is always followed by a name, so it never closes a sentence.
const TITLES = new Set([
    'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'mt.', 'ft.', 'gen.', 'sgt.', 'capt.',
    'lt.', 'col.', 'rev.', 'hon.',
]);
// Other abbreviations close a sentence only when a capitalised word follows.
const ABBREVIATIONS = new Set([
    'jr.', 'sr.', 'vs.', 'no.', 'etc.', 'e.g.', 'i.e.', 'a.m.', 'p.m.', 'inc.', 'ltd.',
    'co.', 'approx.', 'dept.', 'est.', 'vol.', 'fig.', 'ch.', 'pp.', 'ed.', 'op.',
]);
const INITIALISM = /^(?:\p{L}\.){2,}$/u;          // E.T., U.S.A., a.k.a.
const LEADING_QUOTES = /^["'“‘(\[]+/;
const TRAILING_QUOTES = /["'”’)\]]+$/;

/** True when `word` closes a sentence, given the word that follows it (or
 *  nothing at the end of the text). Both are raw tokens as split on spaces. */
export const isSentenceEnd = (word, nextWord) => {
    const w = String(word || '').replace(TRAILING_QUOTES, '');
    if (!/[.?!]$/.test(w)) return false;
    if (/[?!]$/.test(w)) return true;
    const bare = w.replace(LEADING_QUOTES, '');
    const next = nextWord ? String(nextWord).replace(LEADING_QUOTES, '') : '';
    if (TITLES.has(bare.toLowerCase())) return false;
    if (INITIALISM.test(bare) || ABBREVIATIONS.has(bare.toLowerCase())) {
        return !!next && /^\p{Lu}/u.test(next);
    }
    if (next && /^\p{Ll}/u.test(next)) return false;
    return true;
};

/** Groups a flat list of items carrying a `text` word into sentences. Each
 *  sentence is an array of the original items, so callers keep whatever else
 *  they attached (timestamps, indices). */
export const splitSentences = (items) => {
    const out = [];
    let cur = [];
    for (let i = 0; i < items.length; i++) {
        cur.push(items[i]);
        if (isSentenceEnd(items[i].text, items[i + 1]?.text)) {
            out.push(cur);
            cur = [];
        }
    }
    if (cur.length) out.push(cur);
    return out;
};

// ─── Timed sentences ─────────────────────────────────────────────────────────
// Transcript rows (usually one word each, with start_time) grouped into
// sentences that keep the time their first word starts: the export, the
// episode assistant and the chapter times all read the same lines.

/** [{ startMs, endMs, text }] — one per sentence, in order. */
export const sentencesWithTimes = (rows) => {
    const words = [];
    for (const seg of rows || []) {
        const startMs = seg.start_time ?? seg.start ?? 0;
        const endMs = seg.end_time ?? seg.end ?? startMs;
        for (const t of String(seg.text || '').trim().split(/\s+/)) {
            if (t) words.push({ text: t, startMs, endMs });
        }
    }
    return splitSentences(words).map((ws) => ({
        startMs: ws[0].startMs,
        endMs: ws[ws.length - 1].endMs,
        text: ws.map((w) => w.text).join(' '),
    }));
};

/** "12:34", or "1:02:33" past the hour. */
export const formatClock = (ms) => {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
