/**
 * bookSilence — the book's words timed by where the narrator stops (4.8.0).
 *
 * An imported audiobook shows the book's own text (bookMap), spread across
 * each chapter by a reading-pace model. That model is never the narrator's:
 * it starts in step and drifts, so half way through a chapter the sentence
 * lit up is not the one being read.
 *
 * Putting that right does not need the words recognised, only the *pauses*
 * found. A narrator stops at the end of a paragraph, and more briefly at the
 * end of a sentence, and the book says exactly where its paragraphs and
 * sentences end. So the audio is decoded to loudness alone (no speech model —
 * AudioImport.analyzeSilence, tens of times faster than recognition) and the
 * two ordered sequences are matched.
 *
 * What makes the match trustworthy is *pace*, not position. Asking which
 * pause lies nearest a guessed time fails exactly where it matters: the guess
 * has drifted by then, and the nearest pause is the wrong one. Instead every
 * candidate pairing is judged by the reading speed it would imply — words
 * between two pauses, divided by the audio between them — against the speed
 * the whole chapter is read at. A wrong pairing forces one stretch to be
 * gabbled and the next to crawl, and that is what the cost sees. The best
 * path through all pairings is found with a dynamic program over the breaks,
 * which may skip a break the narrator ran through (dialogue is written a
 * paragraph per line and read as one breath) at a small price.
 *
 * What is left is the drift inside a single paragraph, a fraction of a
 * second. The words themselves are never in doubt: they are the author's.
 */
import { isSentenceEnd } from './sentenceBoundary';

// The reading-pace model, shared with bookMap.estimateRows: a unit per
// character, plus the gap between words and the breath at each ending.
const UNITS_PER_WORD = 1.5;
const UNITS_SENTENCE_END = 4;
const UNITS_PARAGRAPH_END = 5;
const UNITS_HEADING_WORD = 8;

export const PARAGRAPH_BREAK = 2;
export const SENTENCE_BREAK = 1;

const PARAGRAPH_PAUSE_MS = 900;   // what a paragraph's pause is worth in full
const MIN_ANCHORS = 3;
// Pace bounds a real stretch of narration stays inside, as a multiple of the
// chapter's own average.
const RATE_SLOW = 0.35;
const RATE_FAST = 2.6;
// How far the search looks for the pause that ends a stretch: from a quarter
// of the expected time to four times it, and never more than this many pauses.
const WINDOW_MIN = 0.22;
const WINDOW_MAX = 4.0;
const WINDOW_PAUSES = 24;
const MAX_SKIP = 4;
// Every break pinned to a pause earns this much against the pace cost it
// adds, so the alignment reaches for as many landmarks as it can and gives
// one up only where pairing it would force an unreadable pace. A pause as
// long as a paragraph's is worth a little more.
const MATCH_REWARD = 25;
const LONG_PAUSE_BONUS = 0.35;

/** Per-word weights in the pace model's units. */
export const wordUnits = (words) => {
    const n = words.length;
    const units = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const w = words[i];
        let u = w.text.replace(/[^\p{L}\p{N}]/gu, '').length + UNITS_PER_WORD;
        if (w.heading) u += UNITS_HEADING_WORD;
        if (isSentenceEnd(w.text, words[i + 1]?.text)) u += UNITS_SENTENCE_END;
        if (w.paraEnd) u += UNITS_PARAGRAPH_END;
        units[i] = u;
    }
    return units;
};

/**
 * Where the text invites a pause: `[{ index, kind, at, before, after }]` —
 * after word `index`, at cumulative unit position `at`, with the length in
 * words of the paragraph on either side.
 */
export const textBreaks = (words, units) => {
    const out = [];
    let at = 0;
    let sinceParagraph = 0;
    for (let i = 0; i < words.length; i++) {
        at += units[i];
        sinceParagraph++;
        if (i === words.length - 1) break;
        const w = words[i];
        if (w.paraEnd) {
            out.push({ index: i, kind: PARAGRAPH_BREAK, at, before: sinceParagraph, after: 0 });
            sinceParagraph = 0;
        } else if (isSentenceEnd(w.text, words[i + 1]?.text)) {
            out.push({ index: i, kind: SENTENCE_BREAK, at, before: sinceParagraph, after: 0 });
        }
    }
    let lastParagraph = null;
    for (const b of out) {
        if (b.kind !== PARAGRAPH_BREAK) continue;
        if (lastParagraph) lastParagraph.after = b.before;
        lastParagraph = b;
    }
    if (lastParagraph) lastParagraph.after = words.length - lastParagraph.index;
    return out;
};

/** First index in `sorted` whose `key` is at least `value` (binary search). */
const lowerBound = (sorted, key, value) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (key(sorted[mid]) < value) lo = mid + 1; else hi = mid;
    }
    return lo;
};

/**
 * The cheapest monotone pairing of `breaks` to `pauses` by reading pace.
 * Returns `[[breakIndex, pauseIndex], …]` in order.
 */
export const matchByPace = (breaks, pauses, { totalUnits, speechStart, speechEnd }) => {
    const B = breaks.length;
    const S = pauses.length;
    if (!B || !S) return [];
    const span = Math.max(1, speechEnd - speechStart);
    const rate = totalUnits / span;            // units of text per millisecond
    const BIG = 1e12;

    // cost of reading `du` units in `dt` milliseconds
    const paceCost = (du, dt) => {
        if (dt <= 0) return BIG;
        const r = (du / dt) / rate;
        if (r > RATE_FAST || r < RATE_SLOW) return BIG;
        const l = Math.log(r);
        return l * l * Math.max(1, du);
    };

    const dp = new Float64Array(B * S).fill(BIG);
    const prevBreak = new Int32Array(B * S).fill(-1);
    const prevPause = new Int32Array(B * S).fill(-1);

    for (let i = 0; i < B; i++) {
        const b = breaks[i];
        const bonus = (b.kind === PARAGRAPH_BREAK ? LONG_PAUSE_BONUS : LONG_PAUSE_BONUS * 0.4);
        for (let j = 0; j < S; j++) {
            const p = pauses[j];
            if (p.start <= speechStart) continue;
            let best = BIG;
            let bi = -1;
            let bj = -1;
            // Start of the chapter: everything up to this break read from the
            // first sound.
            const first = paceCost(b.at, p.start - speechStart);
            if (first < best) best = first;
            // Or carry on from an earlier break matched to an earlier pause.
            for (let k = 1; k <= MAX_SKIP && i - k >= 0; k++) {
                const prev = breaks[i - k];
                const du = b.at - prev.at;
                if (du <= 0) continue;
                const expected = du / rate;
                const from = p.start - expected * WINDOW_MAX;
                const to = p.start - expected * WINDOW_MIN;
                const lo = lowerBound(pauses, (x) => x.end, from);
                let seen = 0;
                for (let q = lo; q < S && seen < WINDOW_PAUSES; q++) {
                    const pq = pauses[q];
                    if (pq.end > to || pq.end >= p.start) break;
                    seen++;
                    const base = dp[(i - k) * S + q];
                    if (base >= BIG) continue;
                    const c = base + paceCost(du, p.start - pq.end);
                    if (c < best) { best = c; bi = i - k; bj = q; }
                }
            }
            if (best >= BIG) continue;
            // Earn the reward for this pairing; a pause of a paragraph's
            // length earns a little more, which settles the choice between
            // pauses the pace cost cannot tell apart.
            const strength = Math.min(1.5, p.ms / PARAGRAPH_PAUSE_MS);
            dp[i * S + j] = best - MATCH_REWARD * (1 + bonus * strength);
            prevBreak[i * S + j] = bi;
            prevPause[i * S + j] = bj;
        }
    }

    // Finish: the words after the last matched break run to the last sound.
    let endBest = BIG;
    let endI = -1;
    let endJ = -1;
    for (let i = 0; i < B; i++) {
        const du = totalUnits - breaks[i].at;
        for (let j = 0; j < S; j++) {
            const base = dp[i * S + j];
            if (base >= BIG) continue;
            const c = base + paceCost(du, speechEnd - pauses[j].end);
            if (c < endBest) { endBest = c; endI = i; endJ = j; }
        }
    }
    if (endI < 0) return [];
    const out = [];
    let i = endI;
    let j = endJ;
    while (i >= 0 && j >= 0) {
        out.push([i, j]);
        const pi = prevBreak[i * S + j];
        const pj = prevPause[i * S + j];
        i = pi;
        j = pj;
    }
    out.reverse();
    return out;
};

/**
 * words: [{text, heading, paraEnd}] (bookMap.wordsInRange);
 * scan: AudioImport.analyzeSilence's result. Returns
 * `{ rows, stats }` — one row per word, strictly increasing, pinned to the
 * narrator's pauses, or `rows: null` when the audio gives too little to go on.
 */
export const alignBookToSilences = (words, scan) => {
    const n = words.length;
    if (!n) return { rows: null, stats: { anchors: 0, breaks: 0, pauses: 0, spanMs: 0 } };

    const units = wordUnits(words);
    let totalUnits = 0;
    for (let i = 0; i < n; i++) totalUnits += units[i];
    const durationMs = Math.max(0, Math.round(scan?.durationMs || 0));
    const speechStart = Math.max(0, Math.round(scan?.speechStartMs ?? 0));
    const speechEnd = Math.max(speechStart + 1000, Math.round(scan?.speechEndMs || durationMs || n * 400));

    const pauses = (scan?.silences || [])
        .map((s) => ({ start: Math.round(s.startMs), end: Math.round(s.endMs), ms: Math.round(s.endMs - s.startMs) }))
        .filter((p) => p.start > speechStart && p.end < speechEnd)
        .sort((a, b) => a.start - b.start);

    const breaks = textBreaks(words, units);
    const paragraphs = breaks.filter((b) => b.kind === PARAGRAPH_BREAK);
    // Paragraph ends are the reliable landmarks; sentence ends only stand in
    // for a text with no paragraphs to speak of.
    const primary = paragraphs.length >= MIN_ANCHORS ? paragraphs : breaks;

    const pairs = matchByPace(primary, pauses, { totalUnits, speechStart, speechEnd });
    const anchors = [];
    for (const [bi, pj] of pairs) {
        const b = primary[bi];
        const p = pauses[pj];
        const prev = anchors[anchors.length - 1];
        if (prev && (b.at <= prev.at || p.start <= prev.pauseEnd)) continue;
        anchors.push({ at: b.at, ms: p.start, pauseEnd: p.end, index: b.index });
    }
    if (anchors.length < MIN_ANCHORS) {
        return { rows: null, stats: { anchors: anchors.length, breaks: primary.length, pauses: pauses.length, spanMs: speechEnd - speechStart } };
    }

    // Walk the words segment by segment: everything between two pauses shares
    // that stretch of audio, split by the same weights the pace model uses.
    const rows = new Array(n);
    let wordIndex = 0;
    let segStartMs = speechStart;
    let lastStart = -1;
    const stops = [...anchors, { index: n - 1, ms: speechEnd, pauseEnd: speechEnd }];
    for (const stop of stops) {
        if (stop.index < wordIndex) continue;
        let segUnits = 0;
        for (let i = wordIndex; i <= stop.index; i++) segUnits += units[i];
        const segSpan = Math.max(1, stop.ms - segStartMs);
        let t = segStartMs;
        for (let i = wordIndex; i <= stop.index; i++) {
            const d = (units[i] / (segUnits || 1)) * segSpan;
            let start = Math.round(t);
            if (start <= lastStart) start = lastStart + 1;
            t += d;
            let end = Math.round(t);
            if (end <= start) end = start + 1;
            rows[i] = { start, end, text: words[i].text };
            lastStart = start;
        }
        // The last word of a stretch holds until the voice returns.
        const last = rows[stop.index];
        if (last) last.end = Math.max(last.end, Math.round(stop.ms));
        wordIndex = stop.index + 1;
        segStartMs = Math.round(stop.pauseEnd ?? stop.ms);
    }
    for (let i = 0; i < n; i++) {
        if (rows[i]) continue;
        const prev = rows[i - 1];
        const start = prev ? prev.end + 1 : speechStart;
        rows[i] = { start, end: start + 1, text: words[i].text };
    }
    return {
        rows,
        stats: {
            anchors: anchors.length, breaks: primary.length, pauses: pauses.length,
            spanMs: speechEnd - speechStart, coverage: anchors.length / Math.max(1, primary.length),
        },
    };
};
