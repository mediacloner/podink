/**
 * bookText.js — finds the books a transcript talks about, and marks their
 * words for the Player.
 *
 * Pure module: no React, no native, no network — the indexer and the
 * transcript view share it, and it runs under plain node for tests.
 *
 * Detection is pattern-based, not a model. The speech recognizer keeps the
 * capitals of proper nouns, so the phrases people use to name a book give
 * candidates cheaply:
 *
 *   "…The Gilt Kid by James Curtis…"          title + author
 *   "her novel is called Permafrost"           "called / titled / entitled"
 *   "Alan Moore's The Great When"              author's title
 *
 * A candidate is only a guess ("Sider with Rosie", "The Guilt Kid", "Lee' as
 * I walked out one midsummer morning"): bookResolve.js asks Open Library and
 * Goodreads which are real books and fixes the spelling. Once a book is
 * confirmed, every place the transcript says its title — in any of the
 * spellings that led to it — is marked (`buildBookMarks`).
 */

// A capitalised word, apostrophes and hyphens included (O'Brien, Prawer-Jhabvala).
const CAP = "\\p{Lu}[\\p{L}\\p{N}'’\\-]*";   // any script's capital: Çetin, İnanç, Éric
// Words a title may carry in lower case ("As I Walked Out One Midsummer
// Morning", "Heat and Dust", "Emil and the Detectives", "The Great When").
const SMALL_WORDS = 'of|the|and|a|an|in|on|to|for|with|from|at|as|or|one|out|my|our|your|his|her|their|its|vs\\.?|versus|de|la|le|du|des|del|von|van|not|no|is|are|was|be|all|that|this|who|what|when|where|how|why|it|you|we|i|up|down|over|under|into';
const SMALL = `(?:${SMALL_WORDS})`;
const END = '(?![\\p{L}\\p{N}])';   // a whole word — "on" must not match inside "one"
const TITLE = `${CAP}${END}(?:\\s+(?:${CAP}|${SMALL})${END})*`;
const NAME_PART = `(?:${CAP}|\\p{Lu}\\.|de|van|von|da|di|du|le|la|del|della|der|den|bin|ibn|al)`;
const AUTHOR = `(?:\\p{Lu}\\.|${CAP})(?:\\s+${NAME_PART}${END}){0,3}`;   // "D. Rothon", "J. B. Priestley"

const RE_BY = new RegExp(`\\bby\\s+(${AUTHOR})`, 'gu');
const RE_CALLED = new RegExp(`\\b(?:called|titled|entitled|named)\\s+(${TITLE})`, 'gu');
const RE_POSSESSIVE = new RegExp(`\\b(${CAP}(?:\\s+${CAP}){0,2})['’]s\\s+(${TITLE})`, 'gu');
// "your new book Taipei Story", "her debut novel The Poppy War", "the
// novella, Boulder": how an interview names the guest's own book — no
// author is said because the author is in the room.
const BOOK_NOUN = '(?:book|novel|memoir|novella|biography|autobiography|thriller|debut|sequel|prequel|collection|anthology|trilogy|series|title|story|poem|essay|bestseller|masterpiece|classic)s?';
const RE_NOUN = new RegExp(`\\b${BOOK_NOUN},?\\s+(${TITLE})`, 'gu');
// Show notes: "author of Babel and Yellowface", "The Dragon Republic (2019)".
const RE_AUTHOR_OF = new RegExp(`\\bauthor of\\s+(${TITLE})(?:,?\\s+and\\s+(${TITLE}))?`, 'gu');
const RE_YEARED = new RegExp(`(${TITLE})\\s*\\((?:19|20)\\d\\d\\)`, 'gu');

const SMALL_RE = new RegExp(`^(?:${SMALL_WORDS})$`, 'u');   // lower case only, on purpose
// Publishers, prizes, shows: capitalised runs that are never a title.
const NOT_A_TITLE = /\b(Prize|Award|Awards|Press|Publishing|Publishers|Classics|Podcast|Podcasts|Patreon|Radio|BBC|Bookshop|Records|Label|Magazine|Review|Times|Guardian|Prize-winning)\b/i;
// "Published by Bloomsbury", "Narrated by…": a lone participle before "by".
const PARTICIPLE = /^(Published|Narrated|Written|Translated|Edited|Introduced|Produced|Directed|Read|Presented|Hosted|Made|Created|Recorded|Illustrated|Followed|Inspired|Sponsored|Brought|Interrupted|Joined|Chosen|Picked|Recommended|Reviewed|Told|Sung|Performed|Played|Covered|Voiced|Adapted|Compiled|Designed|Founded|Started|Run|Owned|Loved|Hated|Won|Nominated|Shortlisted|Longlisted|Judged|Selected|Described|Praised|Championed|Discovered|Mentioned|Quoted|Cited|Taught|Given|Sent|Lent|Signed|Bought|Sold|Held)$/;
// Sentence starters a suffix must not begin at ("So that is Boulder by…").
const STARTERS = new Set(('So|And|But|Then|Now|Well|Okay|OK|Right|Yes|Yeah|No|It|Its|That|This|These|Those|There|Here|Which|Because|If|When|What|Where|Who|How|Why|Also|Just|Actually|Obviously|Anyway|Book|Books|Novel|Called|Read|Reading|Love|Loved|Like|Think|Know|Mean|Sure|Oh|Um|Us|We|They|He|She|You|Me|Him|Her|Them|Our|Your|Their|His|Is|Are|Was|Were|Has|Have|Had|Do|Does|Did|Can|Could|Will|Would|Should|May|Might|Not|Very|Really|Quite|Maybe|Perhaps|Today|Tonight|Next|Last|First|Second|Third|Finally|Again|Still|Already|Please|Thanks|Thank|Hello|Hi|Bye|Welcome|Back|Listen|Listening|Talking|Talk|Speaking|Recommend|Recommended|Recommendation|Recommendations|Episode|Show|Summer|Winter|Spring|Autumn|Special|Interview|Author|Writer|Poet|Guest|Host|Producer|Everybody|Everyone|Someone|Something|Nothing|Anything|Everything').split('|'));

// Capitalised words that end an author's name only because the recognizer
// dropped the full stop: "…by James Curtis As I walked out…".
const AUTHOR_TAIL = new Set('As|At|In|On|For|To|With|From|Of|The|A|An|By|After|Before|During|While|Since|Until|Once|Although|Though|Even|Whether|Either|Neither|Both|Each|Every|Any|Some|Many|Much|Most|More|Less|Few|Several|Such|Other|Another|Same|Own|Only|Than|I'.split('|'));

const isCap = (tok) => /^\p{Lu}/u.test(tok);
const trimEdges = (t) => String(t || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’.!?]+$/gu, '').replace(/[.!?,;:]+$/u, '');
const alpha = (t) => t.replace(/[^\p{L}]/gu, '');

// Trailing lower-case small words go ("called Boulder the" → "Boulder");
// capitalised ones stay ("The Great When"). The candidate must start with a
// capital, and hold a real word.
const cleanTitle = (raw) => {
    const toks = trimEdges(raw).split(/\s+/).filter(Boolean);
    while (toks.length && SMALL_RE.test(alpha(toks[toks.length - 1]))) toks.pop();
    if (!toks.length || !isCap(toks[0])) return '';
    const title = toks.join(' ');
    if (NOT_A_TITLE.test(title)) return '';
    if (toks.length === 1) {
        if (alpha(toks[0]).length < 4) return '';
        if (PARTICIPLE.test(toks[0]) || STARTERS.has(toks[0])) return '';
    }
    return title;
};

const cleanAuthor = (raw) => {
    const toks = trimEdges(raw).split(/\s+/).filter(Boolean);
    // "James Curtis As I walked…" — the words after a name are the next
    // sentence's start when the recognizer lost the full stop.
    while (toks.length > 1) {
        const t = toks[toks.length - 1];
        if (SMALL_RE.test(alpha(t).toLowerCase()) || STARTERS.has(t) || AUTHOR_TAIL.has(t)) toks.pop();
        else break;
    }
    return toks.join(' ');
};

/**
 * Candidate book mentions in `text` (the transcript joined with spaces).
 * @returns {Array<{ title, author, heard, index, pattern, site }>} ordered by
 *   position. `heard` is the title exactly as the transcript has it (what the
 *   marks look for), `author` is '' when none was said, and `site` groups the
 *   alternatives for one mention — once one resolves, the rest are skipped.
 */
export const extractBookCandidates = (text) => {
    const src = String(text || '');
    const out = [];
    const seen = new Set();
    let site = 0;
    const push = (title, author, index, pattern) => {
        const t = cleanTitle(title);
        if (!t) return false;
        const a = cleanAuthor(author || '');
        const key = `${t.toLowerCase()}|${a.toLowerCase()}`;
        if (seen.has(key)) return 'dup';
        seen.add(key);
        out.push({ title: t, author: a, heard: t, index, pattern, site });
        return true;
    };

    // 1. "<title> by <Author>": the clause before "by", cut at sentence
    //    punctuation (a comma right before "by" is allowed — "…Morning, by
    //    Laurie Lee"). First guess: the run of capitalised (and small) words
    //    ending at "by"; then longer suffixes that start with a capital.
    let m;
    let lastByEnd = 0;   // a window never reaches back into the previous "by <Author>"
    RE_BY.lastIndex = 0;
    while ((m = RE_BY.exec(src))) {
        const author = cleanAuthor(m[1]);
        if (!author) continue;
        const from = Math.max(lastByEnd, m.index - 160);
        // The next window starts after the name, not after the words the
        // regex swallowed behind it ("James Curtis As I walked…").
        lastByEnd = m.index + m[0].indexOf(m[1]) + author.length;
        RE_BY.lastIndex = lastByEnd;
        const before = src.slice(from, m.index).replace(/,\s*$/u, '');
        // "published by", "narrated by", "inspired by": not a title.
        const lastWord = (before.match(/([\p{L}]+)\W*$/u) || [])[1] || '';
        if (lastWord && !isCap(lastWord) && PARTICIPLE.test(lastWord[0].toUpperCase() + lastWord.slice(1))) continue;
        let clause = (before.split(/[.;:!?()"“”]|\s[-–—]\s/u).pop() || '').replace(/^[\s,]+/u, '');
        // A comma inside the clause: "X, which is the new novel by A" names X
        // (nothing capitalised after the comma); "X, Y by A" and "…, the
        // prize-winning book Y by A" name Y (the title is after the comma).
        const comma = clause.lastIndexOf(',');
        if (comma > 0) {
            const rest = clause.slice(comma + 1).trim();
            clause = rest.split(/\s+/).some(isCap) ? rest : clause.slice(0, comma);
        }
        const toks = clause.trim().split(/\s+/).filter(Boolean).slice(-9);
        if (!toks.length) continue;
        site++;
        const at = (i) => m.index - clause.length + Math.max(0, clause.indexOf(toks[i]));
        // First guess: the capitalised run ending at "by" (small words allowed
        // inside it). Then, shortest first, the suffixes that start at an
        // earlier capital — for titles the recognizer left in lower case
        // ("Lee' as I walked out one midsummer morning").
        let r = toks.length - 1;
        while (r >= 0 && (isCap(toks[r]) || SMALL_RE.test(alpha(toks[r])))) r--;
        r++;
        // The run starts at its first capital that is not a sentence starter
        // ("So that is Boulder" → "Boulder").
        while (r < toks.length && (!isCap(toks[r]) || STARTERS.has(toks[r]))) r++;
        let added = 0;
        if (r < toks.length) {
            const res = push(toks.slice(r).join(' '), author, at(r), 'by');
            if (res === 'dup') continue;          // this mention was already guessed the same way
            if (res) added++;
        }
        for (let i = r - 1; i >= 0 && added < 3; i--) {
            if (!isCap(toks[i]) || STARTERS.has(toks[i])) continue;
            if (push(toks.slice(i).join(' '), author, at(i), 'by') === true) added++;
        }
    }

    // 2. "called <Title>"
    RE_CALLED.lastIndex = 0;
    while ((m = RE_CALLED.exec(src))) { site++; push(m[1], '', m.index, 'called'); }

    // 3. "<Author>'s <Title>"
    RE_POSSESSIVE.lastIndex = 0;
    while ((m = RE_POSSESSIVE.exec(src))) {
        const parts = m[1].split(/\s+/);
        if (parts.length < 2 || parts.some(w => STARTERS.has(w))) continue;
        site++;
        push(m[2], m[1], m.index, 'possessive');
    }

    // 4. "<book noun> <Title>" — no author; the lookup accepts it only when the
    //    title is unmistakable or its author is one the episode points at.
    RE_NOUN.lastIndex = 0;
    while ((m = RE_NOUN.exec(src))) { site++; push(m[1], '', m.index, 'noun'); }

    // Position order, alternatives of a site kept in their guess order.
    return out.map((c, i) => ({ ...c, _i: i })).sort((a, b) => (a.site - b.site) || (a._i - b._i)).map(({ _i, ...c }) => c);
};

/**
 * Candidates from an episode's show notes (plain text): the transcript
 * patterns plus the two forms notes use — "author of X and Y" and a list of
 * titles with years. They carry no position; bookIndex finds where (if
 * anywhere) the transcript says them.
 */
export const extractNotesCandidates = (notes) => {
    const src = String(notes || '');
    const out = extractBookCandidates(src).map(c => ({ ...c, fromNotes: true }));
    const seen = new Set(out.map(c => c.title.toLowerCase()));
    let site = 1000;
    const add = (raw, index, pattern) => {
        const t = cleanTitle(raw);
        if (!t || seen.has(t.toLowerCase())) return;
        seen.add(t.toLowerCase());
        out.push({ title: t, author: '', heard: t, index, pattern, site: site++, fromNotes: true });
    };
    let m;
    RE_AUTHOR_OF.lastIndex = 0;
    while ((m = RE_AUTHOR_OF.exec(src))) {
        for (const g of [m[1], m[2]]) {
            if (!g) continue;
            // "Babel and Yellowface": one capture, two books.
            for (const part of g.split(/\s+and\s+/u)) if (isCap(part)) add(part, m.index, 'notes-author-of');
        }
    }
    RE_YEARED.lastIndex = 0;
    while ((m = RE_YEARED.exec(src))) add(m[1], m.index, 'notes-year');
    return out;
};

// A person's name as written in a title or in notes: two to four parts,
// initials allowed ("Rebecca F. Kuang", "R.F. Kuang", "Samantha Shannon").
const NAME_PART_RE = `(?:(?:\\p{Lu}\\.){1,3}|${CAP})`;   // initials first: "F." must not stop at "F"
// Not \b: JavaScript's word boundary is ASCII-only, so "\bÇetin" never
// matches and a name with a non-ASCII initial ("Çetin İnanç", "Éric") is lost.
const NAME_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${NAME_PART_RE}(?:\\s+${NAME_PART_RE}){1,3})(?![\\p{L}\\p{N}])`, 'gu');
const NOUN_WORD = new RegExp(`^${BOOK_NOUN}$`, 'iu');

/**
 * Names the episode points at — its title, its show notes, the podcast's
 * author field: hints for the lookup when a book is named without its
 * author ("your new book Taipei Story" in an interview with its writer).
 */
export const extractNames = (text) => {
    const out = new Set();
    let m;
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(String(text || '')))) {
        const parts = m[1].split(/\s+/);
        if (parts.some(w => STARTERS.has(w) || AUTHOR_TAIL.has(w) || NOUN_WORD.test(w) || SMALL_RE.test(w.toLowerCase()))) continue;
        if (NOT_A_TITLE.test(m[1])) continue;
        if (!parts.some(w => /^\p{Lu}[\p{L}]{2,}/u.test(w))) continue;   // at least one real word, not all initials
        out.add(m[1].replace(/\s+/g, ' '));
    }
    return [...out];
};

/**
 * Joins transcript rows into one text and maps a character offset back to
 * the row's start time, so a mention can be timestamped.
 */
export const joinSegments = (rows) => {
    const parts = [];
    const starts = [];   // char offset where each row begins
    const ms = [];
    let len = 0;
    for (const r of rows || []) {
        const t = String(r.text || '').trim();
        if (!t) continue;
        starts.push(len);
        ms.push(r.start_time ?? r.start ?? 0);
        parts.push(t);
        len += t.length + 1;
    }
    const msAt = (offset) => {
        let lo = 0, hi = starts.length - 1;
        if (hi < 0) return 0;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
        }
        return ms[lo];
    };
    return { text: parts.join(' '), msAt };
};

// ─── Marks ───────────────────────────────────────────────────────────────────

const normTok = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const tokensOf = (s) => String(s || '').split(/\s+/).map(normTok).filter(Boolean);

/** The spellings a book is looked for under: its title and every form the
 *  transcript used, as normalised token arrays, longest first. */
export const bookVariants = (book) => {
    const forms = [book.title];
    let heard = book.heard_as ?? book.heardAs ?? [];
    if (typeof heard === 'string') { try { heard = JSON.parse(heard); } catch (_) { heard = [heard]; } }
    if (Array.isArray(heard)) forms.push(...heard);
    const out = [];
    const seen = new Set();
    for (const f of forms) {
        const toks = tokensOf(f);
        if (!toks.length) continue;
        const key = toks.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(toks);
    }
    out.sort((a, b) => b.length - a.length);
    return out;
};

/**
 * Where a variant (normalised tokens) occurs in the transcript's tokens: the
 * same tokens in a row, or the same letters split differently — the
 * recognizer writes "Yellow Face" for Yellowface and "Palmhouse" for The Palm
 * House. Returns the end index (exclusive) of a match starting at `i`, or -1.
 * A one-word title, or a title split into pieces, must be capitalised in the
 * transcript, so "carrying a flashlight" stays plain.
 */
const matchAt = (toks, caps, i, variant, joined, requireCap = false) => {
    const L = variant.length;
    if (variant[0].length < 4 && L === 1) return -1;
    const anyCap = (a, b) => { for (let k = a; k < b; k++) if (caps[k]) return true; return false; };
    let same = i + L <= toks.length;
    for (let k = 0; same && k < L; k++) if (toks[i + k] !== variant[k]) same = false;
    if (same) {
        if (L === 1 && !caps[i]) return -1;
        if (requireCap && !anyCap(i, i + L)) return -1;
        return i + L;
    }
    // Different split, same letters — a proper noun somewhere in the span.
    let acc = '';
    for (let k = i; k < toks.length && acc.length < joined.length; k++) {
        acc += toks[k];
        if (acc === joined) return anyCap(i, k + 1) ? k + 1 : -1;
        if (!joined.startsWith(acc)) return -1;
    }
    return -1;
};

const tokenize = (rows) => {
    const toks = [], caps = [], ms = [], orig = [];
    for (const r of rows || []) {
        const t = r.start_time ?? r.start ?? 0;
        for (const w of String(r.text || '').split(/\s+/)) {
            if (!w) continue;
            toks.push(normTok(w)); caps.push(/^[^\p{L}\p{N}]*\p{Lu}/u.test(w) ? 1 : 0); ms.push(t); orig.push(w);
        }
    }
    return { toks, caps, ms, orig };
};

/**
 * The start time (ms) of the first place the transcript says the book's
 * title in any of its spellings, or null when it never does — used for a
 * book that came from the show notes or an author's bibliography.
 */
export const findFirstMention = (rows, book) => {
    const { toks, caps, ms } = tokenize(rows);
    for (const variant of bookVariants(book)) {
        const joined = variant.join('');
        for (let i = 0; i < toks.length; i++) if (matchAt(toks, caps, i, variant, joined) > 0) return ms[i];
    }
    return null;
};

/**
 * Candidates for the titles of a known author's other books that the
 * transcript says without naming her — "back in Yellowface days". Titles are
 * matched as tokens (any split), capitalised when a single word.
 * @returns {Array<{ title, author, heard, ms, pattern: 'bibliography', site }>}
 */
export const bibliographyCandidates = (rows, titles, author, siteBase = 5000) => {
    const { toks, caps, ms, orig } = tokenize(rows);
    const out = [];
    const seen = new Set();
    let site = siteBase;
    for (const title of titles || []) {
        const variant = tokensOf(title);
        if (!variant.length) continue;
        if (variant.length === 1 && variant[0].length < 5) continue;     // "Cold" alone would be noise
        const joined = variant.join('');
        for (let i = 0; i < toks.length; i++) {
            const end = matchAt(toks, caps, i, variant, joined, true);
            if (end < 0) continue;
            const heard = orig.slice(i, end).join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
            const key = joined;
            if (seen.has(key)) break;
            seen.add(key);
            // Looked up under the catalogue's spelling, marked under the transcript's.
            out.push({ title, author, heard, ms: ms[i], index: -1, pattern: 'bibliography', site: site++ });
            break;
        }
    }
    return out;
};

/**
 * Which words of the built transcript belong to which book.
 * @param chunks  TranscriptHighlighter's chunks: [{ words: [{ text, globalIndex }] }]
 * @param books   EpisodeBooks rows ({ id, title, heard_as })
 * @returns Int32Array indexed by word globalIndex — the book's row id, or 0.
 *   A one-word title ("Boulder", "Flashlight") only counts where the
 *   transcript capitalised it, so "carrying a flashlight" stays plain.
 */
export const buildBookMarks = (chunks, books) => {
    let total = 0;
    for (const ch of chunks || []) for (const w of ch.words) if (w.globalIndex + 1 > total) total = w.globalIndex + 1;
    const marks = new Int32Array(total);
    if (!total || !books?.length) return marks;

    const toks = new Array(total).fill('');
    const caps = new Uint8Array(total);
    for (const ch of chunks) {
        for (const w of ch.words) {
            toks[w.globalIndex] = normTok(w.text);
            caps[w.globalIndex] = /^\s*[^\p{L}\p{N}]*\p{Lu}/u.test(w.text) ? 1 : 0;
        }
    }

    for (const book of books) {
        const id = Number(book.id) || 0;
        if (!id) continue;
        for (const variant of bookVariants(book)) {
            const joined = variant.join('');
            for (let i = 0; i < total; i++) {
                if (marks[i]) continue;
                const end = matchAt(toks, caps, i, variant, joined);
                if (end < 0) continue;
                for (let k = i; k < end; k++) if (!marks[k]) marks[k] = id;
                i = end - 1;
            }
        }
    }
    return marks;
};
