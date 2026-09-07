// Goodreads, through the autocomplete endpoint its own search box uses. There
// has been no Goodreads API since 2020 and the search page is a script shell,
// but this endpoint answers JSON to any User-Agent, knows this year's books,
// and carries what the book card shows: description, rating, cover, link.
// Undocumented — treat a change here like a YouTube extractor break: the
// indexer falls back to Open Library alone (services/bookResolve.js).
import { USER_AGENT } from './userAgent';
import { decodeEntities } from '../services/dictionaryHtml';

const ENDPOINT = 'https://www.goodreads.com/book/auto_complete?format=json&q=';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

const tagged = (kind, message) => Object.assign(new Error(message), { kind });

const htmlToText = (html) => decodeEntities(
    String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, ''),
).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Thumbnails come as "…/12345._SY75_.jpg"; without the size token the same
// path serves the full cover.
const largeCover = (url) => (url ? String(url).replace(/\._S[XY]\d+_(?=\.)/, '') : null);

/**
 * Books matching a title (5 at most), Goodreads' own ranking.
 * @returns {Promise<Array<{ id, workId, title, author, coverUrl, rating, ratingsCount,
 *   pages, description, descriptionTruncated, url }>>}
 */
export const searchGoodreads = async (title, signal) => {
    let res;
    try {
        res = await fetch(ENDPOINT + encodeURIComponent(title), { headers: HEADERS, signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('offline', e?.message || 'Network request failed');
    }
    if (!res.ok) throw tagged('server', 'HTTP ' + res.status);
    let d;
    try {
        d = await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('server', 'Malformed response');
    }
    if (!Array.isArray(d)) throw tagged('server', 'Unexpected response shape');
    return d.map(hit => ({
        id: hit.bookId != null ? String(hit.bookId) : '',
        workId: hit.workId != null ? String(hit.workId) : '',
        title: hit.bookTitleBare || hit.title || '',
        author: hit.author?.name || '',
        coverUrl: largeCover(hit.imageUrl),
        rating: Number.isFinite(parseFloat(hit.avgRating)) ? parseFloat(hit.avgRating) : null,
        ratingsCount: Number(hit.ratingsCount) || 0,
        pages: Number(hit.numPages) || null,
        description: htmlToText(hit.description?.html),
        descriptionTruncated: !!hit.description?.truncated,
        url: hit.bookUrl ? (/^https?:/i.test(hit.bookUrl) ? hit.bookUrl : `https://www.goodreads.com${hit.bookUrl}`) : null,
    })).filter(h => h.title);
};

export const goodreadsSearchUrl = (title) => `https://www.goodreads.com/search?q=${encodeURIComponent(title)}`;
