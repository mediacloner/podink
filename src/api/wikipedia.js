// Wikipedia summaries for the word card: names, surnames, places and other
// proper nouns the dictionaries leave out ("Commodus", "Avidius Cassius",
// "Stoicism"). Only the REST summary endpoint is used — exact titles, with
// Wikipedia's own redirects ("commodus" → Commodus) — and never full-text
// search: for a misheard name ("Vidius Cassius") the search API answers with
// unrelated pages, and a wrong article is worse than none.
import { USER_AGENT } from './userAgent';

// Wikimedia asks every client for an identifying User-Agent.
export const WIKIPEDIA_HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

const summaryUrl = (lang, title) =>
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.trim().replace(/ /g, '_'))}`;

const tagged = (kind, message) => Object.assign(new Error(message), { kind });

/**
 * One article summary, or null when no page has that title. Rejects with
 * `kind: 'offline' | 'server'` on network trouble, `AbortError` untouched.
 *
 * @returns {Promise<null | { title, description, extract, extractHtml,
 *   thumbnail: null | { uri, width, height }, url, disambiguation, lang }>}
 */
export const fetchWikipediaSummary = async (title, lang = 'en', signal) => {
    let res;
    try {
        res = await fetch(summaryUrl(lang, title), { headers: WIKIPEDIA_HEADERS, signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('offline', e?.message || 'Network request failed');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw tagged('server', 'HTTP ' + res.status);
    let d;
    try {
        d = await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('server', 'Malformed response');
    }
    if (!d || !d.title) return null;
    // 'standard' is an article; 'disambiguation' lists the articles sharing
    // the name. Anything else (no-extract, mainpage) has nothing to show.
    if (d.type !== 'standard' && d.type !== 'disambiguation') return null;
    const slug = encodeURIComponent(d.title.replace(/ /g, '_'));
    return {
        title: d.title,
        description: d.description || '',
        extract: d.extract || '',
        extractHtml: d.extract_html || '',
        thumbnail: d.thumbnail?.source
            ? { uri: d.thumbnail.source, width: d.thumbnail.width, height: d.thumbnail.height }
            : null,
        url: d.content_urls?.mobile?.page || d.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${slug}`,
        disambiguation: d.type === 'disambiguation',
        lang,
    };
};

const titleCase = (s) => s.split(' ').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

/**
 * Tries the candidates in order — the longest name run first — and resolves
 * the first real article. A disambiguation page is remembered and returned
 * only when no candidate is an article; null when nothing matched at all.
 * Titles are case-sensitive past the first letter, so each candidate is
 * retried in Title Case when the transcript spelt it otherwise.
 */
export const lookupWikipedia = async (candidates, { lang = 'en', signal } = {}) => {
    let disambiguation = null;
    const tried = new Set();
    for (const raw of candidates) {
        const cand = (raw || '').trim();
        if (!cand) continue;
        for (const title of [cand, titleCase(cand)]) {
            if (tried.has(title)) continue;
            tried.add(title);
            const page = await fetchWikipediaSummary(title, lang, signal);
            if (!page) continue;
            if (!page.disambiguation) return page;
            if (!disambiguation) disambiguation = page;
        }
    }
    return disambiguation;
};

// ── Name runs around the tapped word ─────────────────────────────────────────

// "I" is capitalised wherever it stands and is never part of a name.
const CAPITALISED = /^\p{Lu}/u;
const isCapitalised = (w) => CAPITALISED.test(w || '') && !/^I(?:['’]|$)/.test(w);

// Lower-case words that sit inside names: "Statue of Liberty", "Gulf of
// Mexico", "Ludwig van Beethoven", "Simon & Garfunkel". They only count when
// a capitalised word follows.
const CONNECTORS = new Set(['of', 'the', 'de', 'del', 'la', 'le', 'da', 'di', 'du', 'von', 'van', 'der', 'den', 'and', '&', 'y', 'e']);
const isConnector = (w) => CONNECTORS.has((w || '').toLowerCase());

const MAX_RUN = 4;

/**
 * Titles to try for a tapped word, longest first: the capitalised words
 * around it are gathered into a name run ("Gaius Avidius Cassius"), and
 * every stretch of it that contains the word becomes a candidate — the whole
 * run, then shorter ones, down to the word alone. A word that is not
 * capitalised is offered on its own (a dictionary miss such as "stoicism").
 * `prevWords` / `nextWords` are the clause context the transcript already
 * hands the card (punctuation trimmed, case kept).
 */
export const nameCandidates = ({ word, prevWords = [], nextWords = [] }) => {
    const w = (word || '').trim();
    if (!w) return [];
    if (!isCapitalised(w)) return [w];

    const before = [];
    for (let i = prevWords.length - 1; i >= 0; i--) {
        const p = prevWords[i];
        if (isCapitalised(p)) { before.unshift(p); continue; }
        if (isConnector(p) && i > 0 && isCapitalised(prevWords[i - 1])) { before.unshift(p); continue; }
        break;
    }
    const after = [];
    for (let i = 0; i < nextWords.length; i++) {
        const n = nextWords[i];
        if (isCapitalised(n)) { after.push(n); continue; }
        if (isConnector(n) && i + 1 < nextWords.length && isCapitalised(nextWords[i + 1])) { after.push(n); continue; }
        break;
    }

    const run = [...before, w, ...after];
    const at = before.length;
    const out = [];
    for (let len = Math.min(run.length, MAX_RUN); len >= 1; len--) {
        for (let start = Math.max(0, at - len + 1); start <= at && start + len <= run.length; start++) {
            const words = run.slice(start, start + len);
            // A run never starts or ends on a connector ("of Liberty").
            if (isConnector(words[0]) || isConnector(words[words.length - 1])) continue;
            out.push(words.join(' '));
        }
    }
    return out;
};

// How many entries of a list page the card shows.
const LIST_ITEMS = 6;

/**
 * The HTML the card flattens like a dictionary record: the article's intro
 * paragraphs as Wikipedia serves them (`<b>` name, `<i>` terms). A list page
 * — a disambiguation ("Cassius may refer to…"), a surname list ("Grigg is a
 * surname. Notable people…"), any intro that is mostly entries — is cut to
 * its lead line and the first few entries; the rest is one tap away.
 */
export const wikipediaEntryHtml = (page) => {
    if (!page) return '';
    const html = page.extractHtml || (page.extract ? `<p>${page.extract}</p>` : '');
    const items = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
    if (items.length <= LIST_ITEMS) return html;
    const lead = (html.match(/<p\b[^>]*>[\s\S]*?<\/p>/i) || [''])[0];
    const shown = items.slice(0, LIST_ITEMS).join('');
    return `${lead}<ul>${shown}</ul><p><i>…and ${items.length - LIST_ITEMS} more on Wikipedia</i></p>`;
};
