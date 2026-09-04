// Wikipedia summaries for the word card: names, surnames, places and other
// proper nouns the dictionaries leave out ("Commodus", "Avidius Cassius",
// "Stoicism"). Only the REST summary endpoint is used — exact titles, with
// Wikipedia's own redirects ("commodus" → Commodus) — and never full-text
// search: for a misheard name ("Vidius Cassius") the search API answers with
// unrelated pages, and a wrong article is worse than none.
import { USER_AGENT } from './userAgent';

// Wikimedia asks every client for an identifying User-Agent.
export const WIKIPEDIA_HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

const slugOf = (title) => encodeURIComponent(title.trim().replace(/ /g, '_'));
const summaryUrl = (lang, title) => `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slugOf(title)}`;
const wikitextUrl = (lang, title) =>
    `https://${lang}.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&redirects=1&page=${slugOf(title)}`;

const tagged = (kind, message) => Object.assign(new Error(message), { kind });

const getJson = async (url, signal) => {
    let res;
    try {
        res = await fetch(url, { headers: WIKIPEDIA_HEADERS, signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('offline', e?.message || 'Network request failed');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw tagged('server', 'HTTP ' + res.status);
    try {
        return await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('server', 'Malformed response');
    }
};

/**
 * One article summary, or null when no page has that title. Rejects with
 * `kind: 'offline' | 'server'` on network trouble, `AbortError` untouched.
 *
 * @returns {Promise<null | { title, description, extract, extractHtml,
 *   thumbnail: null | { uri, width, height }, url, disambiguation, lang }>}
 */
export const fetchWikipediaSummary = async (title, lang = 'en', signal) => {
    const d = await getJson(summaryUrl(lang, title), signal);
    if (!d || !d.title) return null;
    // 'standard' is an article; 'disambiguation' lists the articles sharing
    // the name. Anything else (no-extract, mainpage) has nothing to show.
    if (d.type !== 'standard' && d.type !== 'disambiguation') return null;
    return {
        title: d.title,
        description: d.description || '',
        extract: d.extract || '',
        extractHtml: d.extract_html || '',
        thumbnail: d.thumbnail?.source
            ? { uri: d.thumbnail.source, width: d.thumbnail.width, height: d.thumbnail.height }
            : null,
        url: d.content_urls?.mobile?.page || d.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${slugOf(d.title)}`,
        disambiguation: d.type === 'disambiguation',
        lang,
    };
};

const titleCase = (s) => s.split(' ').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

/**
 * Tries the candidates in order — the longest name run first — and resolves
 * the first page any of them names, article or disambiguation: "World Trade
 * Center" (a disambiguation) must win over the article "World", so the
 * reader picks the building from the list rather than reading about the
 * planet. Null when nothing matched. Titles are case-sensitive past the
 * first letter, so each candidate is retried in Title Case when the
 * transcript spelt it otherwise.
 */
export const lookupWikipedia = async (candidates, { lang = 'en', signal } = {}) => {
    const tried = new Set();
    for (const raw of candidates) {
        const cand = (raw || '').trim();
        if (!cand) continue;
        for (const title of [cand, titleCase(cand)]) {
            if (tried.has(title)) continue;
            tried.add(title);
            const page = await fetchWikipediaSummary(title, lang, signal);
            if (page) return page;
        }
    }
    return null;
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

// ── List pages: disambiguations and surname lists ────────────────────────────

// A page whose intro is mostly entries — a disambiguation ("World Trade
// Center may refer to…"), a surname list ("Grigg is a surname. Notable
// people…") — is shown as a list of tappable entries rather than prose.
const LIST_THRESHOLD = 6;
export const isListPage = (page) =>
    !!page && (page.disambiguation || (page.extractHtml.match(/<li\b/gi) || []).length > LIST_THRESHOLD);

// Sections of a disambiguation page that list no articles of their own.
const SKIPPED_SECTIONS = /^(see also|references|external links|notes)$/i;
// Link targets outside the article namespace.
const NON_ARTICLE = /^(?:wikt|wiktionary|file|image|category|wikipedia|wp|help|template|portal|special|talk|user|s|q|commons|c|d|m|mw|b|n|v):/i;

// Wiki markup → plain text: links keep their label, bold/italic quotes go,
// templates, refs and comments vanish.
const stripMarkup = (s) => s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{[^{}]*(?:\{\{[^{}]*\}\}[^{}]*)*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:[^\s\]]+(?:\s+([^\]]*))?\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The entries of a list page, in page order, read from its wikitext:
 * `* [[World Trade Center (1973–2001)]], a building complex…` becomes
 * { title, label, rest, section, depth }. Pure — exported for tests.
 */
export const parseListEntries = (wikitext) => {
    const out = [];
    let section = '';
    let skipping = false;
    for (const rawLine of (wikitext || '').split('\n')) {
        const line = rawLine.trim();
        const heading = /^(={2,})\s*(.*?)\s*\1$/.exec(line);
        if (heading) {
            const text = stripMarkup(heading[2]);
            // Only a top-level heading can end a skipped section.
            if (heading[1].length === 2 || !skipping) skipping = SKIPPED_SECTIONS.test(text);
            if (!skipping && heading[1].length === 2) section = text;
            continue;
        }
        if (skipping) continue;
        const item = /^(\*+|#+)\s*(.*)$/.exec(line);
        if (!item) continue;
        const link = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(item[2]);
        if (!link) continue;
        const title = link[1].trim();
        if (!title || NON_ARTICLE.test(title)) continue;
        const label = (link[2] ?? title).trim() || title;
        const rest = stripMarkup(item[2].slice(link.index + link[0].length));
        out.push({ title, label, rest, section, depth: item[1].length - 1 });
    }
    return out;
};

/** Entries of a list page, or [] when its wikitext cannot be read. */
export const fetchListEntries = async (title, lang = 'en', signal) => {
    const d = await getJson(wikitextUrl(lang, title), signal);
    const text = d?.parse?.wikitext;
    return typeof text === 'string' ? parseListEntries(text) : [];
};

const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The HTML the card flattens like a dictionary record.
 *
 * An article: its intro paragraphs as Wikipedia serves them (`<b>` name,
 * `<i>` terms). A list page with `entries`: the lead line, then the entries
 * grouped under their section labels, each entry an `entry://` link to its
 * own article — the same cross-reference the dictionaries use, so a tap on
 * it opens that article in the card. Without entries (wikitext unreadable)
 * the page's own list is shown cut to its first few items.
 */
export const wikipediaEntryHtml = (page, entries = null) => {
    if (!page) return '';
    const html = page.extractHtml || (page.extract ? `<p>${escapeHtml(page.extract)}</p>` : '');
    if (!isListPage(page)) return html;
    const lead = (html.match(/<p\b[^>]*>[\s\S]*?<\/p>/i) || [''])[0];
    if (entries && entries.length) {
        let out = lead;
        let section = null;
        let open = false;
        for (const e of entries) {
            if (e.section !== section) {
                if (open) { out += '</ul>'; open = false; }
                section = e.section;
                if (section) out += `<p><small>${escapeHtml(section)}</small></p>`;
            }
            if (!open) { out += '<ul>'; open = true; }
            const rest = e.rest ? ` ${escapeHtml(e.rest)}`.replace(/^ ([,;:.])/, '$1') : '';
            out += `<li><a href="entry://${escapeHtml(e.title)}">${escapeHtml(e.label)}</a>${rest}</li>`;
        }
        if (open) out += '</ul>';
        return out;
    }
    const items = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
    if (items.length <= LIST_THRESHOLD) return html;
    return `${lead}<ul>${items.slice(0, LIST_THRESHOLD).join('')}</ul><p><i>…and ${items.length - LIST_THRESHOLD} more on Wikipedia</i></p>`;
};
