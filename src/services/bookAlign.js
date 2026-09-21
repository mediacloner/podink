/**
 * bookAlign — the book's words given the recogniser's times (4.8.0).
 *
 * A chapter imported with its EPUB shows the book's text at estimated
 * times (bookMap.estimateRows). "Sync" runs the speech engine over the
 * audio as usual, but instead of keeping what it heard, the heard words
 * are lined up against the book's and their timestamps carried over: the
 * text stays the author's, the timing becomes the narrator's.
 *
 * Alignment is anchor-based, the way diff finds unchanged lines: word
 * trigrams unique to both texts are paired, the longest monotone chain of
 * them kept, and each gap between anchors refined with shorter n-grams,
 * then a small longest-common-subsequence table. Words the engine missed,
 * misheard or read as digits are interpolated between their neighbours by
 * length. Opening credits and a heading the narrator adds simply match
 * nothing. ~3,000-word chapters align in tens of milliseconds.
 */

const hasNormalize = typeof ''.normalize === 'function';

/** Lower-case letters and digits only; accents stripped where the runtime can. */
export const normToken = (w) => {
    let t = String(w || '');
    if (hasNormalize) {
        try { t = t.normalize('NFD').replace(/\p{M}+/gu, ''); } catch (_) { /* no ICU */ }
    }
    return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
};

/** A word → its tokens: hyphens and dashes split ("twenty-minute" → two), the rest normalised. */
export const tokensOf = (word) => String(word || '').split(/[\s–—\/-]+/).map(normToken).filter(Boolean);

const tokenize = (words) => {
    const toks = [];
    const owner = [];
    words.forEach((w, i) => { for (const t of tokensOf(w)) { toks.push(t); owner.push(i); } });
    return { toks, owner };
};

const DP_MAX_CELLS = 250000;   // refine a gap with the table when it is this small
const DP_GIVE_UP_CELLS = 4000000; // beyond this a gap stays unmatched (interpolated)

/** Exact-token LCS inside a bounded gap; pairs pushed to `out`. */
const dpGap = (a, alo, ahi, b, blo, bhi, out) => {
    const na = ahi - alo, nb = bhi - blo;
    if (na <= 0 || nb <= 0 || na * nb > DP_GIVE_UP_CELLS) return;
    const W = nb + 1;
    const dp = new Uint16Array((na + 1) * W);
    for (let i = na - 1; i >= 0; i--) {
        for (let j = nb - 1; j >= 0; j--) {
            dp[i * W + j] = a[alo + i] === b[blo + j]
                ? dp[(i + 1) * W + j + 1] + 1
                : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
        }
    }
    let i = 0, j = 0;
    while (i < na && j < nb) {
        if (a[alo + i] === b[blo + j]) { out.push([alo + i, blo + j]); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
        else j++;
    }
};

const refine = (a, alo, ahi, b, blo, bhi, n, out) => {
    if (alo >= ahi || blo >= bhi) return;
    if ((ahi - alo) * (bhi - blo) <= DP_MAX_CELLS) { dpGap(a, alo, ahi, b, blo, bhi, out); return; }
    if (n > 1) anchors(a, alo, ahi, b, blo, bhi, n - 1, out);
    else dpGap(a, alo, ahi, b, blo, bhi, out);
};

/** Unique n-gram anchors in both ranges, longest increasing chain, recursive gaps. */
const anchors = (a, alo, ahi, b, blo, bhi, n, out) => {
    if (ahi - alo < n || bhi - blo < n) { if (n > 1) anchors(a, alo, ahi, b, blo, bhi, n - 1, out); else dpGap(a, alo, ahi, b, blo, bhi, out); return; }
    const key = (arr, i) => { let k = arr[i]; for (let x = 1; x < n; x++) k += ' ' + arr[i + x]; return k; };
    const seenA = new Map();
    for (let i = alo; i + n <= ahi; i++) { const k = key(a, i); seenA.set(k, seenA.has(k) ? -1 : i); }
    const seenB = new Map();
    for (let j = blo; j + n <= bhi; j++) { const k = key(b, j); seenB.set(k, seenB.has(k) ? -1 : j); }
    const pairs = [];
    for (const [k, i] of seenA) {
        if (i < 0) continue;
        const j = seenB.get(k);
        if (j !== undefined && j >= 0) pairs.push([i, j]);
    }
    pairs.sort((p, q) => p[0] - q[0]);

    // Longest increasing subsequence on the b side keeps the chain monotone.
    const tails = [], tailIdx = [];
    const prev = new Array(pairs.length).fill(-1);
    for (let x = 0; x < pairs.length; x++) {
        const j = pairs[x][1];
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; }
        tails[lo] = j; tailIdx[lo] = x;
        prev[x] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const chain = [];
    for (let x = tails.length ? tailIdx[tails.length - 1] : -1; x >= 0; x = prev[x]) chain.push(pairs[x]);
    chain.reverse();
    if (!chain.length) {
        if (n > 1) anchors(a, alo, ahi, b, blo, bhi, n - 1, out);
        else dpGap(a, alo, ahi, b, blo, bhi, out);
        return;
    }
    let pa = alo, pb = blo;
    for (const [i, j] of chain) {
        if (i < pa || j < pb) continue; // overlapping n-grams from the chain
        refine(a, pa, i, b, pb, j, n, out);
        for (let x = 0; x < n; x++) out.push([i + x, j + x]);
        pa = i + n; pb = j + n;
    }
    refine(a, pa, ahi, b, pb, bhi, n, out);
};

const weightOf = (w) => normToken(w).length + 1;

/**
 * bookWords: string[] (the range's words, bookMap.wordsInRange order);
 * asr: [{ start, end, text }] ms, the recogniser's rows; durationMs the
 * chapter's length. Returns `{ rows: [{ start, end, text }], stats }` —
 * one row per book word, strictly increasing, unmatched words interpolated.
 */
export const alignBookToAsr = (bookWords, asr, durationMs) => {
    const A = tokenize(bookWords);
    const B = tokenize(asr.map((r) => r.text));
    // Some recognisers return several words in one timed segment. Split that
    // segment's interval as well as its text, rather than stacking all words
    // at the same start time.
    const tokenTimes = [];
    for (let j = 0; j < B.toks.length;) {
        let k = j + 1;
        while (k < B.toks.length && B.owner[k] === B.owner[j]) k++;
        const row = asr[B.owner[j]];
        const step = Math.max(0, row.end - row.start) / (k - j);
        for (let x = j; x < k; x++) tokenTimes[x] = { start: row.start + (x - j) * step, end: row.start + (x - j + 1) * step };
        j = k;
    }
    const pairs = [];
    anchors(A.toks, 0, A.toks.length, B.toks, 0, B.toks.length, 3, pairs);
    pairs.sort((p, q) => p[0] - q[0]);

    const n = bookWords.length;
    const start = new Array(n).fill(null);
    const end = new Array(n).fill(null);
    let lastJ = -1;
    for (const [i, j] of pairs) {
        if (j <= lastJ) continue; // keep strictly monotone in the audio too
        lastJ = j;
        const w = A.owner[i];
        const r = tokenTimes[j];
        if (start[w] == null || r.start < start[w]) start[w] = r.start;
        if (end[w] == null || r.end > end[w]) end[w] = r.end;
    }
    let matched = 0;
    for (let i = 0; i < n; i++) if (start[i] != null) matched++;

    const total = durationMs > 0 ? durationMs : (asr.length ? asr[asr.length - 1].end : n * 400);
    const times = new Array(n);
    let i = 0;
    while (i < n) {
        if (start[i] != null) { times[i] = { start: start[i], end: end[i] }; i++; continue; }
        let k = i;
        while (k < n && start[k] == null) k++;
        // Unmatched run i..k-1: between the previous word's end and the next word's start.
        const gapWords = k - i;
        const t0 = i > 0 ? end[i - 1] : Math.max(0, (k < n ? start[k] : total) - 350 * gapWords);
        const t1 = k < n ? start[k] : Math.min(total, t0 + 350 * gapWords);
        let W = 0;
        for (let x = i; x < k; x++) W += weightOf(bookWords[x]);
        let t = t0;
        for (let x = i; x < k; x++) {
            const d = Math.max(0, t1 - t0) * (weightOf(bookWords[x]) / W);
            times[x] = { start: t, end: t + d };
            t += d;
        }
        i = k;
    }
    // Monotone, integer, unique (start, end) pairs for the Transcripts index.
    const rows = new Array(n);
    let lastStart = -1;
    for (let x = 0; x < n; x++) {
        let s = Math.round(times[x].start);
        let e = Math.round(times[x].end);
        if (s <= lastStart) s = lastStart + 1;
        if (e <= s) e = s + 1;
        rows[x] = { start: s, end: e, text: bookWords[x] };
        lastStart = s;
    }
    return { rows, stats: { words: n, matched, matchedRatio: n ? matched / n : 0, asrWords: asr.length } };
};
