/**
 * importMeta — the pure half of the audio import (no React Native imports,
 * so it runs in Node): reading an audiobook's .nfo, putting chapter files in
 * book order, and choosing the default title / author / chapter names and
 * cover for a set of chosen files. importService.js does the I/O.
 *
 * Inputs are the entries the native AudioImport module describes:
 *   { uri, name, relativePath, size, kind: 'audio'|'image'|'text', tags? }
 * where `tags` is MediaMetadataRetriever's view of an audio file:
 *   { title, artist, album, albumArtist, author, composer, writer, genre,
 *     year, date, track, disc, durationMs, hasCover }  (all nullable)
 */

// ─── .nfo ────────────────────────────────────────────────────────────────────

// "Key: value" lines, lower-cased key → draft field. Audiobook rips (inAudible,
// Libation, OpenAudible …) all use some subset of these.
const NFO_KEYS = {
    title:     ['title', 'book title', 'book', 'name', 'album'],
    author:    ['author', 'authors', 'written by', 'writer', 'by'],
    narrator:  ['read by', 'narrator', 'narrated by', 'narrators', 'reader', 'performer'],
    genre:     ['genre', 'genres'],
    publisher: ['publisher', 'label'],
    year:      ['year', 'copyright', 'release date', 'released', 'date', 'audiobook copyright'],
    series:    ['series'],
    duration:  ['duration', 'length', 'runtime', 'running time'],
    chapters:  ['chapters'],
};
const KEY_TO_FIELD = Object.fromEntries(
    Object.entries(NFO_KEYS).flatMap(([field, names]) => names.map(n => [n, field]))
);
const DESCRIPTION_HEADER = /^(book\s+)?(description|synopsis|summary|about(\s+the\s+book)?|blurb|plot)\s*:?\s*$/i;
const isUnderline = (s) => /^\s*[=\-_*~#]{3,}\s*$/.test(s || '');

const BULLET = /^(\s*[-*•·]\s+|\s*\d+[.)]\s+)/;

/** .nfo text is hard-wrapped at ~80 columns. Blank lines separate paragraphs;
 *  inside a paragraph the wrapped lines are joined back into one — except
 *  list items, which keep their own line. */
export const unwrapParagraphs = (lines) => {
    const paragraphs = [];
    let current = [];
    const flush = () => {
        if (!current.length) return;
        const joined = [];
        for (const line of current) {
            if (!joined.length || BULLET.test(line)) joined.push(line);
            else joined[joined.length - 1] += ` ${line}`;
        }
        paragraphs.push(joined.join('\n').replace(/[ \t]{2,}/g, ' ').trim());
        current = [];
    };
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) flush(); else current.push(line);
    }
    flush();
    return paragraphs.filter(Boolean).join('\n\n');
};

/** Fields found in an .nfo / .txt companion file. Missing keys are absent. */
export const parseNfo = (text) => {
    const out = {};
    if (!text) return out;
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let description = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (description !== null) {
            // The next "Header" + "=====" pair closes the description.
            if (line && isUnderline(lines[i + 1])) break;
            if (isUnderline(line)) continue;
            description.push(line);
            continue;
        }
        if (DESCRIPTION_HEADER.test(line)) {
            description = [];
            if (isUnderline(lines[i + 1])) i++;
            continue;
        }
        const m = line.match(/^([A-Za-z][A-Za-z ]{0,30}?)\s*[:：]\s*(.+)$/);
        if (!m) continue;
        const field = KEY_TO_FIELD[m[1].trim().toLowerCase()];
        const value = m[2].trim();
        if (field && value && out[field] === undefined) out[field] = value;
    }
    if (description) {
        const d = unwrapParagraphs(description);
        if (d) out.description = d;
    }
    if (out.year) {
        const y = out.year.match(/\b(19|20)\d{2}\b/);
        if (y) out.year = y[0]; else delete out.year;
    }
    return out;
};

// ─── Names & order ───────────────────────────────────────────────────────────

export const stripExtension = (name) => String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');

/** File name → something a person would type: no extension, no underscores. */
export const cleanName = (name) => stripExtension(name).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

/** "3/60" → 3, "03" → 3, "" → null. */
export const parseTrack = (v) => {
    if (v == null) return null;
    const m = String(v).match(/\d+/);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};

const chunks = (s) => String(s || '').toLowerCase().match(/(\d+|\D+)/g) || [];

/** "Chapter 2" < "Chapter 10": digit runs compare as numbers. */
export const naturalCompare = (a, b) => {
    const ca = chunks(a), cb = chunks(b);
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
        const x = ca[i], y = cb[i];
        const nx = /^\d/.test(x), ny = /^\d/.test(y);
        if (nx && ny) {
            const d = parseInt(x, 10) - parseInt(y, 10);
            if (d) return d;
            if (x.length !== y.length) return x.length - y.length;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return ca.length - cb.length;
};

const pathOf = (it) => `${it.relativePath || ''}${it.name || ''}`;
const discOf = (it) => parseTrack(it.tags?.disc) ?? 1;
const trackOf = (it) => parseTrack(it.tags?.track);

/**
 * Book order. Track tags are used only when every file has one and they are
 * all distinct — rips often stamp the same number on every chapter, and then
 * the file names ("… - 01", "… - 02") are the reliable order.
 */
export const orderChapters = (items) => {
    const copy = items.slice();
    const tracked = copy.length > 0 && copy.every(it => trackOf(it) != null);
    const distinct = tracked && new Set(copy.map(it => `${discOf(it)}/${trackOf(it)}`)).size === copy.length;
    if (distinct) copy.sort((a, b) => (discOf(a) - discOf(b)) || (trackOf(a) - trackOf(b)));
    else copy.sort((a, b) => naturalCompare(pathOf(a), pathOf(b)));
    return copy;
};

/** The most frequent non-empty value, or null. */
export const mostCommon = (values) => {
    const counts = new Map();
    for (const v of values) {
        const s = (v ?? '').toString().trim();
        if (s) counts.set(s, (counts.get(s) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [s, n] of counts) if (n > bestN) { best = s; bestN = n; }
    return best;
};

const SEPARATORS = [' ', '-', '_', '.', ':', '–'];

/** Shared leading text of several names, cut back to a separator so a word is
 *  never split; '' when there is none or when stripping it would empty a name. */
export const commonPrefix = (names) => {
    if (names.length < 2) return '';
    let p = names[0];
    for (const n of names) {
        let i = 0;
        while (i < p.length && i < n.length && p[i] === n[i]) i++;
        p = p.slice(0, i);
        if (!p) return '';
    }
    const cut = Math.max(...SEPARATORS.map(c => p.lastIndexOf(c)));
    if (cut <= 0) return '';
    const prefix = p.slice(0, cut + 1);
    const leavesSomething = names.every(n => stripLead(n.slice(prefix.length)));
    return leavesSomething ? prefix : '';
};
const stripLead = (s) => s.replace(/^[\s\-–_.:]+/, '').trim();

/** The chapter number a file name carries, or null.
 *    "07", "07-60", "07 of 60", "07/60", "Part 07", "Chapter 7"   (whole name)
 *    "… - Skyward 60-60", "… Part 12", "… (03 of 20)"             (trailing)
 *  For "N-M" / "N of M" forms M must be ≥ N, so a date-like "2018-11" or a
 *  "Symphony 5-1" movement is left alone. */
export const chapterNumber = (stem) => {
    const s = String(stem || '').trim();
    let m = s.match(/^(?:part|chapter|track|ch|pt|episode|ep)?\s*\.?\s*(\d+)\s*(?:(?:[-–\/]|of)\s*(\d+))?$/i);
    if (m && (!m[2] || parseInt(m[2], 10) >= parseInt(m[1], 10))) return parseInt(m[1], 10);
    m = s.match(/(?:^|[\s\-–_.:(\[])(?:part|chapter|ch|pt|episode|ep)\s*\.?\s*(\d+)\s*[)\]]?$/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/(?:^|[\s\-–_.:(\[])(\d+)\s*(?:[-–\/]|of)\s*(\d+)\s*[)\]]?$/i);
    if (m && parseInt(m[2], 10) >= parseInt(m[1], 10) && parseInt(m[2], 10) >= 2) return parseInt(m[1], 10);
    return null;
};

/**
 * Chapter titles for files already in book order. A per-file title tag wins
 * when it is unique and is not the book's own name; a tag repeated across
 * files is the book's name, not a chapter's, so the file name is used
 * instead — minus the part every file shares — and a chapter number in the
 * name becomes "Chapter N".
 *
 * `knownStems` are the cleaned file names of chapters already in the
 * collection (Add files): they take part in the shared-prefix detection so
 * one new file is named the way the first import named its siblings.
 * `bookTitles` (collection title, album tag) are never chapter titles.
 */
export const chapterTitles = (items, { knownStems = [], bookTitles = [] } = {}) => {
    const ignored = new Set(bookTitles.filter(Boolean).map(t => t.trim().toLowerCase()));
    const tagTitles = items.map(it => (it.tags?.title || '').trim());
    const counts = new Map();
    for (const t of tagTitles) if (t) counts.set(t, (counts.get(t) || 0) + 1);
    const stems = items.map(it => cleanName(it.name));
    const allStems = [...knownStems.filter(Boolean), ...stems];
    const prefix = allStems.length >= 3 ? commonPrefix(allStems) : '';
    return items.map((it, i) => {
        const tag = tagTitles[i];
        if (tag && counts.get(tag) === 1 && !ignored.has(tag.toLowerCase()) && chapterNumber(tag) == null) return tag;
        let stem = stems[i];
        if (prefix && stem.startsWith(prefix)) stem = stripLead(stem.slice(prefix.length)) || stem;
        const n = chapterNumber(stem) ?? (tag ? chapterNumber(tag) : null);
        if (n != null) return `Chapter ${n}`;
        return stem || tag || `Track ${i + 1}`;
    });
};

/** Cleaned original file names of a collection's chapters, recovered from
 *  the stored paths (`…/060-Brandon Sanderson - Skyward 60-60.mp4`). */
export const stemsFromLocalPaths = (paths) => paths
    .map(p => decodeURIComponent(String(p || '').split('/').pop() || ''))
    .map(name => cleanName(name.replace(/^\d{3,4}-/, '')))
    .filter(Boolean);

// ─── The draft ───────────────────────────────────────────────────────────────

/**
 * Defaults for the import form. `items` are the audio entries with their
 * tags, `nfo` is parseNfo's result (or null), `folderName` the picked
 * folder's name (or ''). Everything is editable afterwards; this only has to
 * be a good first guess.
 */
export const buildDraft = ({ items, nfo = null, folderName = '', context = null }) => {
    const ordered = orderChapters(items);
    const tag = (key) => mostCommon(ordered.map(it => it.tags?.[key]));
    const titles = chapterTitles(ordered, {
        knownStems: context?.stems || [],
        bookTitles: [nfo?.title, tag('album'), context?.title],
    });
    const single = ordered.length === 1;

    const title = nfo?.title
        || tag('album')
        || (single ? (ordered[0].tags?.title || cleanName(ordered[0].name)) : folderName)
        || (ordered[0] ? cleanName(ordered[0].name) : '')
        || 'Imported audio';
    const author = nfo?.author || tag('albumArtist') || tag('artist') || tag('author') || tag('writer') || tag('composer') || '';

    const parts = [];
    if (nfo?.narrator) parts.push(`Read by ${nfo.narrator}`);
    if (nfo?.description) parts.push(nfo.description);
    const description = parts.join('\n\n');

    const chapters = ordered.map((it, i) => ({
        uri: it.uri,
        name: it.name,
        size: it.size ?? -1,
        title: titles[i],
        track: i + 1,
        durationSec: it.tags?.durationMs > 0 ? Math.round(it.tags.durationMs / 1000) : 0,
        hasCover: !!it.tags?.hasCover,
    }));

    return {
        title,
        author,
        description,
        year: nfo?.year || (tag('year') || '').slice(0, 4) || '',
        genre: nfo?.genre || tag('genre') || '',
        narrator: nfo?.narrator || '',
        chapters,
    };
};

/**
 * Where the cover should come from: a folder image named like a cover, else
 * the first chapter with embedded art, else any image in the folder.
 * `{ type: 'image' | 'embedded', uri }` or null.
 */
export const pickCoverCandidate = (images, chapters) => {
    const named = images.find(img => /^(cover|folder|front|album|artwork)\b/i.test(stripExtension(img.name)));
    if (named) return { type: 'image', uri: named.uri };
    const embedded = chapters.find(ch => ch.hasCover);
    if (embedded) return { type: 'embedded', uri: embedded.uri };
    if (images.length) return { type: 'image', uri: images[0].uri };
    return null;
};

/** Total length of a chapter list, in seconds. */
export const totalDuration = (chapters) => chapters.reduce((s, ch) => s + (ch.durationSec || ch.duration || 0), 0);
