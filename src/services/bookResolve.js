/**
 * bookResolve.js — turns book candidates from a transcript into confirmed
 * books with a title, author, description, rating, cover and links.
 *
 * Pure module with the network injected (`fetchers`), so it runs under node
 * against the real services and under tests against canned answers.
 *
 * Why lookup does the deciding: the recognizer hears titles well — they are
 * ordinary words — but spells names phonetically ("Ava Balthazar", "Susan
 * Choy", "Ruth Praoab Vala"). Searching a catalogue by the *title* and then
 * choosing the hit whose author sounds like what was heard fixes the name
 * from the catalogue's side. Open Library is asked first (documented,
 * keyless); Goodreads' autocomplete second — it knows this year's books and
 * carries the description, rating and cover. A candidate with no author said
 * ("her novel is called Permafrost") is accepted only when its title is
 * unmistakable or the author is one already confirmed in this episode.
 */

// ─── Text similarity ─────────────────────────────────────────────────────────

const LEAD_ARTICLE = /^(?:the|a|an)\s+/u;
const cleanTitleText = (s) => String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEAD_ARTICLE, '');
/** The main title: a subtitle / edition note after ":" or "(" dropped. */
export const normTitle = (s) => cleanTitleText(String(s || '').split(/[:(\[]/)[0]);
/** The whole title, subtitle included — "Gary Stewart: I Am From the Honky-Tonks". */
export const normTitleFull = (s) => cleanTitleText(s);
/** The subtitle alone, or '' — "I Am From the Honky-Tonks". */
const normTitleSub = (s) => { const i = String(s || '').search(/[:(\[]/); return i < 0 ? '' : cleanTitleText(String(s).slice(i + 1)); };
// A catalogue title matches when its main part, its subtitle or the whole of
// it is what was heard: people say "Gary Stewart" and "I Am From the Honky Tonks".
const titleSim = (docTitle, want) => Math.max(
    sim(normTitle(docTitle), want), sim(normTitleFull(docTitle), want), sim(normTitleSub(docTitle), want));

export const normName = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Levenshtein ratio in [0, 1] — the strings are short (titles, names).
export const sim = (a, b) => {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const n = a.length, m = b.length;
    let prev = new Array(m + 1), cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
        cur[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= m; j++) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return 1 - prev[m] / Math.max(n, m);
};

// Surnames carry the signal: "Choy" vs "Choi" is one letter, but a first
// name the recognizer got right must not paper over a different surname.
const nameSim = (a, b) => {
    const na = normName(a), nb = normName(b);
    if (!na || !nb) return 0;
    const full = sim(na, nb);
    const la = na.split(' ').pop(), lb = nb.split(' ').pop();
    return Math.max(full, 0.5 * full + 0.5 * sim(la, lb));
};

const sigWords = (title) => normTitle(title).split(' ').filter(w => w.length > 2).length;

// ─── Choosing among hits ─────────────────────────────────────────────────────

const TITLE_MIN = 0.86;        // title must be this close (after normalisation)
const AUTHOR_MIN = 0.6;        // heard author vs catalogue author
const TITLE_ALONE_MIN = 0.92;  // a no-author candidate needs a near-exact title…
const POPULAR_GR = 50;         // …and a book people have actually rated
const EPISODE_AUTHOR_MIN = 0.7;

const popular = (doc) => (doc.ratingsCount || 0) >= POPULAR_GR || (doc.editions || 0) >= 3;

/**
 * The hit that is the candidate, or null. `docs` are normalised search hits
 * ({ title, authors: [] | author: '' , ratingsCount, editions }).
 * @param ctx.confirmedAuthors  names already confirmed in this episode
 */
export const pickMatch = (docs, cand, ctx = {}) => {
    const wantT = normTitle(cand.title);
    if (!wantT) return null;
    // Authors this episode points at: confirmed from earlier candidates, or
    // hinted by its title / notes (the interviewed writer).
    const confirmed = [...(ctx.confirmedAuthors || []), ...(ctx.hintAuthors || [])];
    let best = null;
    for (const doc of docs || []) {
        const authors = doc.authors || (doc.author ? [doc.author] : []);
        const tScore = titleSim(doc.title, wantT);
        if (tScore < TITLE_MIN) continue;
        let aScore = 0, viaEpisode = false;
        if (cand.author) {
            aScore = Math.max(0, ...authors.map(a => nameSim(a, cand.author)));
        } else if (confirmed.length && authors.length) {
            const hit = Math.max(0, ...authors.map(a => Math.max(...confirmed.map(c => nameSim(a, c)))));
            if (hit >= EPISODE_AUTHOR_MIN) { aScore = hit; viaEpisode = true; }
        }
        let ok = false;
        if (cand.author) ok = aScore >= AUTHOR_MIN;
        else if (viaEpisode) ok = true;
        else ok = tScore >= TITLE_ALONE_MIN && sigWords(cand.title) >= 2 && popular(doc);
        if (!ok) continue;
        const score = tScore + aScore + Math.min(0.2, Math.log10(1 + (doc.ratingsCount || 0)) / 20);
        if (!best || score > best.score) best = { doc, tScore, aScore, score };
    }
    return best;
};

// ─── Resolution ──────────────────────────────────────────────────────────────

const OL_GAP_MS = 1200;   // openlibrary.org resets connections above ~1 req/s
const GR_GAP_MS = 700;

const cacheKey = (title) => normTitle(title).replace(/\s+/g, '');

/**
 * @param cands     extractBookCandidates() output, each optionally with `ms`
 * @param fetchers  { searchOpenLibrary(title), searchGoodreads(title),
 *                    fetchOpenLibraryDescription(key), sleep(ms), log?(msg, data) }
 * @returns books: [{ title, author, description, rating, ratingsCount, coverUrl,
 *   year, pages, openlibraryUrl, goodreadsUrl, source, heardAs: [], firstMs }]
 */
export const resolveCandidates = async (cands, fetchers, { signal, hintAuthors = [] } = {}) => {
    const { searchOpenLibrary, searchGoodreads, fetchOpenLibraryDescription, sleep } = fetchers;
    const log = fetchers.log || (() => {});
    const confirmedAuthors = new Set();
    const cache = new Map();      // cacheKey(title) → resolved book | null
    const books = new Map();      // identity → book
    const doneSites = new Set();  // a mention's alternatives stop at the first hit
    let lastOl = 0, lastGr = 0;

    const paced = async (kind, fn) => {
        const gap = kind === 'ol' ? OL_GAP_MS : GR_GAP_MS;
        const last = kind === 'ol' ? lastOl : lastGr;
        const wait = last + gap - Date.now();
        if (wait > 0) await sleep(wait);
        try {
            return await fn();
        } catch (e) {
            log(`${kind} lookup failed`, { error: e?.message || String(e) });
            return null;
        } finally {
            if (kind === 'ol') lastOl = Date.now(); else lastGr = Date.now();
        }
    };

    const resolveOne = async (cand) => {
        const ctx = { confirmedAuthors, hintAuthors };
        const olDocs = await paced('ol', () => searchOpenLibrary(cand.title, signal));
        const ol = pickMatch(olDocs, cand, ctx);
        // Goodreads: the fallback when Open Library has nothing, and the
        // source of description / rating / cover when it has.
        const grDocs = await paced('gr', () => searchGoodreads(cand.title, signal));
        const grCand = ol ? { title: ol.doc.title, author: ol.doc.authors[0] || cand.author } : cand;
        let gr = pickMatch(grDocs, grCand, ctx);
        if (!gr && ol && cand.author) gr = pickMatch(grDocs, cand, ctx);
        if (!ol && !gr) return null;

        const book = {
            title: gr?.doc.title || ol.doc.title,
            author: (ol ? ol.doc.authors[0] : gr.doc.author) || gr?.doc.author || '',
            description: gr?.doc.description || '',
            rating: gr?.doc.rating ?? ol?.doc.rating ?? null,
            ratingsCount: gr?.doc.ratingsCount || ol?.doc.ratingsCount || 0,
            coverUrl: gr?.doc.coverUrl || ol?.doc.coverUrl || null,
            year: ol?.doc.year || null,
            pages: gr?.doc.pages || ol?.doc.pages || null,
            openlibraryUrl: ol ? ol.doc.url : null,
            goodreadsUrl: gr ? gr.doc.url : null,
            source: ol ? 'openlibrary' : 'goodreads',
            identity: gr?.doc.id ? `gr:${gr.doc.id}` : `ol:${ol.doc.key}`,
        };
        // Goodreads' autocomplete cuts the description short; Open Library's
        // work record often has the whole blurb.
        if ((!book.description || gr?.doc.descriptionTruncated) && ol && fetchOpenLibraryDescription) {
            const d = await paced('ol', () => fetchOpenLibraryDescription(ol.doc.key, signal));
            if (d && d.length > (book.description || '').length) book.description = d;
        }
        return book;
    };

    for (const cand of cands || []) {
        if (signal?.aborted) break;
        if (cand.site != null && doneSites.has(cand.site)) continue;
        const key = cacheKey(cand.title);
        let book;
        if (cache.has(key)) {
            book = cache.get(key);
        } else {
            book = await resolveOne(cand);
            cache.set(key, book);
        }
        if (!book) continue;
        if (cand.site != null) doneSites.add(cand.site);
        if (book.author) confirmedAuthors.add(book.author);
        const prev = books.get(book.identity);
        const ms = Number.isFinite(cand.ms) ? cand.ms : null;
        if (prev) {
            if (!prev.heardAs.includes(cand.heard)) prev.heardAs.push(cand.heard);
            if (ms != null && (prev.firstMs == null || ms < prev.firstMs)) prev.firstMs = ms;
        } else {
            books.set(book.identity, { ...book, heardAs: [cand.heard], firstMs: ms });
        }
    }
    // Spellings that did not resolve on their own but name a confirmed book
    // ("The Guilt Kid" next to "The Gilt Kid by James Curtis") are attached
    // as heard forms, so those mentions are marked too.
    const resolved = [...books.values()];
    for (const cand of cands || []) {
        const heardKey = cacheKey(cand.title);
        if (cache.get(heardKey)) continue;
        for (const b of resolved) {
            if (b.heardAs.includes(cand.heard)) break;
            const tOk = sim(normTitle(b.title), normTitle(cand.title)) >= 0.75;
            const aOk = cand.author ? nameSim(b.author, cand.author) >= 0.7 : false;
            if (tOk && aOk) { b.heardAs.push(cand.heard); break; }
        }
    }
    return resolved.sort((a, b) => (a.firstMs ?? 0) - (b.firstMs ?? 0));
};
