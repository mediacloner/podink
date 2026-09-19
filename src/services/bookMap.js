/**
 * bookMap — which part of the book each audio chapter reads (4.8.0).
 *
 * An audiobook's files (or the chapter markers inside one m4b) and the
 * EPUB's sections rarely line up one to one: the book has a cover, a
 * copyright page and a contents list the narrator never reads; the audio
 * has opening credits the book never prints; part dividers are a page in
 * the book and a breath in the audio. This module:
 *
 *   prepareBook(epub)        classifies the EPUB's sections (body / matter /
 *                            divider), folds dividers into the section that
 *                            follows and reads chapter numbers from titles;
 *   autoMapChapters(...)     pairs chapters with sections — by title, by
 *                            named section (Prologue, Interlude…), by chapter
 *                            number — then hands out what is left in order
 *                            or, when the counts differ, by share of words
 *                            against share of running time;
 *   wordsInRange / estimateRows  turn a range of the book into transcript
 *                            rows, one per word, with times spread across
 *                            the chapter's duration by word length and the
 *                            pauses a reader takes at sentence and paragraph
 *                            ends. bookAlign.js replaces the estimate with
 *                            the recogniser's times when the user syncs.
 *
 * A range is `{ s0, w0, s1, w1 }`: from word w0 of section s0 up to (not
 * including) word w1 of section s1. Whole sections have w0 = 0 and
 * s1 = s0 + n, w1 = 0. null = the chapter has no text (credits, an intro).
 */
import { isSentenceEnd } from './sentenceBoundary';

// Sections the narration skips (unless an audio chapter carries the same title).
const MATTER_RE = /^(?:cover|title\s*page|half[\s-]*title|titles?\s+by|also\s+by|books?\s+by|other\s+(?:books|titles|works)|by\s+the\s+same\s+author|copyright|contents|table\s+of\s+contents|dedication|epigraph|maps?|list\s+of|acknowledg\w*|about\s+the\s+(?:author|translator|narrator|publisher)|next\s+reads?|credits|praise|newsletter|glossary|index|bibliograph\w*|notes|appendix|colophon|imprint|permissions|landmarks|guide|excerpt|preview|sneak\s+peek|teaser|discussion|reading\s+group|questions)(?:\s|$)/i;
// Sections the narration reads and names as such — matched by name inside a
// chapter's title ("01 - Prologue", "Interlude (Part Three)").
const NAMED_SECTIONS = ['prologue', 'epilogue', 'interlude', 'introduction', 'foreword', 'preface', 'afterword',
    'dedication', 'epigraph', 'prelude', 'postscript', 'coda', 'intermission', 'entracte', 'author\'s note'];
const DIVIDER_MAX_WORDS = 30;

const WORD_NUMBERS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };

export const normTitle = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const wordNumber = (s) => {
    const parts = s.toLowerCase().split(/[\s-]+/).filter(Boolean);
    if (!parts.length || parts.length > 2) return null;
    let n = 0;
    for (const p of parts) {
        if (!(p in WORD_NUMBERS)) return null;
        n += WORD_NUMBERS[p];
    }
    return n > 0 ? n : null;
};
const romanNumber = (s) => {
    if (!/^[ivxlc]+$/i.test(s)) return null;
    let n = 0;
    const t = s.toLowerCase();
    for (let i = 0; i < t.length; i++) {
        const v = ROMAN[t[i]];
        const next = ROMAN[t[i + 1]] || 0;
        n += v < next ? -v : v;
    }
    return n > 0 ? n : null;
};

/**
 * The chapter number a title carries, or null: "Chapter 12", "CHAPTER TWELVE",
 * "Chapter XII", "12", "12. The Cave", "3: Saturday" — but not "Skyward 01-60",
 * "Track 5" or "Part Two".
 */
export const chapterNumberOf = (title) => {
    const t = String(title || '').trim();
    if (!t) return null;
    let m = /^(?:chapter|chap\.?|ch\.?|cap[ií]tulo|kapitel|chapitre)\s+([0-9]+|[ivxlc]+|[a-z]+(?:[\s-][a-z]+)?)\b/i.exec(t);
    if (m) {
        const raw = m[1];
        if (/^\d+$/.test(raw)) return parseInt(raw, 10);
        return wordNumber(raw) ?? romanNumber(raw);
    }
    m = /^(\d{1,3})(?:\s*[.:)\-–—]|\s|$)/.exec(t);
    if (m) return parseInt(m[1], 10);
    const bare = t.replace(/[.:]$/, '');
    return wordNumber(bare) ?? romanNumber(bare);
};

const countWords = (paragraphs) => paragraphs.reduce((n, p) => n + (p.text ? p.text.split(' ').length : 0), 0);

// Matter first — a dedication is skipped unless an audio chapter is called
// "Dedication" (then the title anchor brings it in); a named section
// ("Prologue") is body however short.
const classify = (title, words) => {
    const t = normTitle(title);
    if (t && MATTER_RE.test(t)) return 'matter';
    if (words < DIVIDER_MAX_WORDS && !NAMED_SECTIONS.some((n) => t === normTitle(n))) return 'divider';
    return 'body';
};

/**
 * epubText.readEpub's result → the book the mapping and the transcripts
 * work from: `{ title, author, language, sections: [{ title, kind, number,
 * paragraphs, words }] }`. Dividers ("Part One", an empty cover page) are
 * folded into the next section as headings, so the narrator's "Part One.
 * Chapter one." is where the book says it.
 */
export const prepareBook = (epub) => {
    const sections = [];
    let pending = [];
    for (const s of epub.sections || []) {
        const words = countWords(s.paragraphs || []);
        const kind = classify(s.title, words);
        if (kind === 'divider') {
            pending.push(s);
            continue;
        }
        const paragraphs = [
            ...pending.flatMap((d) => (d.paragraphs || []).map((p) => ({ text: p.text, heading: true }))),
            ...(s.paragraphs || []).map((p) => ({ text: p.text, heading: !!p.heading })),
        ];
        pending = [];
        sections.push({ title: s.title || '', kind, number: chapterNumberOf(s.title), paragraphs, words: countWords(paragraphs) });
    }
    return { title: epub.title || '', author: epub.author || '', language: epub.language || '', sections };
};

/** A section's name for the editor: "Chapter 12" for a bare "12", "Section 7" for none. */
export const sectionLabel = (section, index) => {
    const t = (section?.title || '').trim();
    if (/^\d+$/.test(t)) return `Chapter ${t}`;
    if (t) return t;
    return section?.number != null ? `Chapter ${section.number}` : `Section ${index + 1}`;
};

// ─── Matching ───────────────────────────────────────────────────────────────

/** 3 = same title, 2 = the chapter names this section (Prologue…), 1 = same chapter number, 0 = no. */
const matchScore = (chapterTitle, chapterNumber, section) => {
    const a = normTitle(chapterTitle);
    const b = normTitle(section.title);
    if (!a || !b) return 0;
    if (a === b) return 3;
    const named = NAMED_SECTIONS.map(normTitle).find((n) => b === n || b.startsWith(`${n} `));
    if (named && new RegExp(`(^| )${named}( |$)`).test(a)) return 2;
    if (chapterNumber != null && section.number != null && chapterNumber === section.number) return 1;
    return 0;
};

const wholeSection = (j) => ({ s0: j, w0: 0, s1: j + 1, w1: 0 });

/** The word offset `k` inside the block of sections [from, to] → a position `{ s, w }`. */
const positionAt = (book, from, to, k) => {
    let left = k;
    for (let j = from; j <= to; j++) {
        const n = book.sections[j].words;
        if (left < n) return { s: j, w: left };
        left -= n;
    }
    return { s: to + 1, w: 0 };
};

/**
 * chapters: [{ title, durationSec }] in playing order → one range or null
 * per chapter (see the file comment for the strategy).
 */
export const autoMapChapters = (chapters, book) => {
    const S = book.sections.length;
    const n = chapters.length;
    const ranges = new Array(n).fill(null);
    if (!S || !n) return ranges;

    // 0. As many audio chapters as the book has body sections: read them off
    //    one to one and trust nothing else. A file's name is often only its
    //    number ("Chapter 1" for track 1), and matching those numbers to the
    //    book's would hand file 1 the first numbered chapter when what it
    //    reads is the prologue — every later file off by one. Counting agrees
    //    only when the narration follows the book section for section, which
    //    is the common case. An exact title match anywhere means the files do
    //    carry real names, and those are better evidence than the count.
    const bodies = [];
    for (let j = 0; j < S; j++) if (book.sections[j].kind === 'body') bodies.push(j);
    const titled = chapters.some((c) => {
        const a = normTitle(c.title);
        return !!a && book.sections.some((sec) => normTitle(sec.title) === a);
    });
    if (!titled && bodies.length === n) return bodies.map((j) => wholeSection(j));

    // 1. Anchors: title, named section, chapter number — monotone.
    const anchors = new Array(n).fill(null);
    let p = 0;
    for (let i = 0; i < n; i++) {
        const num = chapterNumberOf(chapters[i].title);
        let exact = -1, named = -1, numbered = -1;
        for (let j = p; j < S; j++) {
            const sc = matchScore(chapters[i].title, num, book.sections[j]);
            if (sc === 3) { exact = j; break; }
            if (sc === 2 && named < 0) named = j;
            if (sc === 1 && numbered < 0) numbered = j;
        }
        const j = exact >= 0 ? exact : named >= 0 ? named : numbered;
        if (j != null && j >= 0) {
            anchors[i] = j;
            ranges[i] = wholeSection(j);
            p = j + 1;
        }
    }

    // 2. The gaps between anchors (and before the first / after the last).
    const anchored = [];
    anchors.forEach((j, i) => { if (j != null) anchored.push([i, j]); });
    anchored.push([n, S]); // sentinel
    let prevI = -1, prevJ = -1;
    for (const [i2, j2] of anchored) {
        const tracks = [];
        for (let i = prevI + 1; i < i2; i++) tracks.push(i);
        const bodies = [];
        for (let j = prevJ + 1; j < j2; j++) if (book.sections[j].kind === 'body') bodies.push(j);

        if (tracks.length === 0) {
            // Body text with no chapter of its own, between two matched
            // chapters, follows the earlier one (the narrator did not split
            // where the book did). After the last match nothing is assumed:
            // an incomplete set of files, or a bonus chapter never recorded,
            // must not hand the whole rest of the book to one chapter.
            if (prevI >= 0 && i2 < n && bodies.length && ranges[prevI]) {
                ranges[prevI] = { ...ranges[prevI], s1: bodies[bodies.length - 1] + 1, w1: 0 };
            }
        } else if (bodies.length === 0) {
            // Nothing in the book for these (opening credits, closing credits).
        } else if (tracks.length === bodies.length) {
            tracks.forEach((i, k) => { ranges[i] = wholeSection(bodies[k]); });
        } else {
            // Share the block of text out by running time (or evenly).
            const from = bodies[0], to = bodies[bodies.length - 1];
            let total = 0;
            for (let j = from; j <= to; j++) total += book.sections[j].words;
            const weights = tracks.map((i) => Math.max(0, chapters[i].durationSec || 0));
            const allTimed = weights.every((w) => w > 0);
            const wsum = allTimed ? weights.reduce((a, b) => a + b, 0) : tracks.length;
            let acc = 0;
            let start = { s: from, w: 0 };
            tracks.forEach((i, k) => {
                acc += allTimed ? weights[k] : 1;
                const end = k === tracks.length - 1 ? { s: to + 1, w: 0 } : positionAt(book, from, to, Math.round((acc / wsum) * total));
                if (end.s > start.s || (end.s === start.s && end.w > start.w)) {
                    ranges[i] = { s0: start.s, w0: start.w, s1: end.s, w1: end.w };
                }
                start = end;
            });
        }
        prevI = i2;
        prevJ = j2;
    }
    return ranges;
};

/**
 * The user picked `startSection` (or null = no text) for chapter `index`:
 * every ranged chapter becomes whole sections again, each running up to the
 * next ranged chapter's start (at least its own section).
 */
export const rangesAfterEdit = (ranges, index, startSection) => {
    const starts = ranges.map((r) => (r ? r.s0 : null));
    starts[index] = startSection;
    const out = starts.map(() => null);
    for (let i = 0; i < starts.length; i++) {
        if (starts[i] == null) continue;
        let nextStart = null;
        for (let k = i + 1; k < starts.length; k++) if (starts[k] != null) { nextStart = starts[k]; break; }
        const end = nextStart != null && nextStart > starts[i] ? nextStart : starts[i] + 1;
        out[i] = { s0: starts[i], w0: 0, s1: end, w1: 0 };
    }
    return out;
};

/** "Chapter 3", "Prologue – Chapter 2", "Chapter 9 (part)", or "No text". */
export const describeRange = (book, range) => {
    if (!range) return 'No text';
    const secs = book.sections;
    const first = secs[range.s0];
    if (!first) return 'No text';
    const lastIndex = range.w1 > 0 ? range.s1 : range.s1 - 1;
    const last = secs[Math.min(lastIndex, secs.length - 1)];
    const partial = range.w0 > 0 || range.w1 > 0;
    const a = sectionLabel(first, range.s0);
    if (!last || lastIndex <= range.s0) return partial ? `${a} (part)` : a;
    return `${a} – ${sectionLabel(last, lastIndex)}${partial ? ' (part)' : ''}`;
};

// What a narrator's speed can be. Outside this, the words and the audio are
// not the same passage — the chapter is pointed at the wrong part of the book.
export const MIN_WPM = 45;
export const MAX_WPM = 340;
// Below this much audio, the word count says nothing.
export const FIT_CHECK_MS = 8000;
// The pace to lay words out at when the audio cannot say (an unknown length,
// or a length the text plainly does not belong to).
export const FALLBACK_WPM = 150;

/** How many words a range holds, without building the list. */
export const wordCountInRange = (book, range) => {
    let n = 0;
    if (!range) return 0;
    for (let j = range.s0; j < book.sections.length; j++) {
        const lastSection = j === range.s1 && range.w1 > 0;
        if (j > range.s1 || (j === range.s1 && range.w1 === 0)) break;
        const sec = book.sections[j];
        if (j > range.s0 && !lastSection) { n += sec.words; continue; }
        let k = 0;
        for (const p of sec.paragraphs) {
            const ws = p.text.split(' ');
            for (let x = 0; x < ws.length; x++) {
                if ((j > range.s0 || k >= range.w0) && (!lastSection || k < range.w1)) n++;
                k++;
            }
        }
        if (lastSection) break;
    }
    return n;
};

/**
 * 0 when this many words can be read aloud in this much audio, otherwise the
 * words a minute it would take — which is the sign of a chapter mapped to the
 * wrong part of the book.
 */
export const paceIfImpossible = (wordCount, durationMs) => {
    if (!(durationMs > FIT_CHECK_MS) || !wordCount) return 0;
    const wpm = wordCount / (durationMs / 60000);
    return wpm > MAX_WPM || wpm < MIN_WPM ? Math.round(wpm) : 0;
};

/** Words of a range in reading order: [{ text, heading, paraEnd }]. */
export const wordsInRange = (book, range) => {
    const out = [];
    if (!range) return out;
    for (let j = range.s0; j < book.sections.length; j++) {
        const lastSection = j === range.s1 && range.w1 > 0;
        if (j > range.s1 || (j === range.s1 && range.w1 === 0)) break;
        const sec = book.sections[j];
        let k = 0;
        for (const p of sec.paragraphs) {
            const ws = p.text.split(' ');
            for (let x = 0; x < ws.length; x++) {
                const inRange = (j > range.s0 || k >= range.w0) && (!lastSection || k < range.w1);
                if (inRange) out.push({ text: ws[x], heading: !!p.heading, paraEnd: x === ws.length - 1 });
                k++;
            }
        }
        if (lastSection) break;
    }
    return out;
};

// Reading-rate model for the estimate: a unit per character, plus these.
const UNITS_PER_WORD = 1.5;      // the gap between words
const UNITS_SENTENCE_END = 4;    // a breath at a full stop
const UNITS_PARAGRAPH_END = 5;   // a longer one at a paragraph
const UNITS_HEADING_WORD = 8;    // "Chapter one." is read slowly
const FALLBACK_MS_PER_WORD = 400; // ~150 words a minute when the duration is unknown

/**
 * Transcript rows for `words` spread across `durationMs`: one row per word,
 * strictly increasing times, so the Player's word highlight and tap-to-seek
 * work at once — roughly, until the chapter is synced to the audio.
 */
export const estimateRows = (words, durationMs) => {
    const n = words.length;
    if (!n) return [];
    const total = durationMs > 0 ? durationMs : n * FALLBACK_MS_PER_WORD;
    const weights = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const w = words[i];
        let u = w.text.replace(/[^\p{L}\p{N}]/gu, '').length + UNITS_PER_WORD;
        if (w.heading) u += UNITS_HEADING_WORD;
        if (isSentenceEnd(w.text, words[i + 1]?.text)) u += UNITS_SENTENCE_END;
        if (w.paraEnd) u += UNITS_PARAGRAPH_END;
        weights[i] = u;
        sum += u;
    }
    const rows = new Array(n);
    let t = 0;
    let lastStart = -1;
    for (let i = 0; i < n; i++) {
        let start = Math.round(t);
        if (start <= lastStart) start = lastStart + 1;
        t += (weights[i] / sum) * total;
        let end = Math.round(t);
        if (end <= start) end = start + 1;
        rows[i] = { start, end, text: words[i].text };
        lastStart = start;
    }
    return rows;
};
