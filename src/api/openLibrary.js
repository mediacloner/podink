// Open Library search, by title: the first catalogue the book indexer asks
// (services/bookResolve.js). Documented and keyless; it throttles hard
// (connection resets above ~1 request/s), so callers pace themselves.
import { USER_AGENT } from './userAgent';

const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
const FIELDS = 'key,title,author_name,first_publish_year,cover_i,ratings_average,ratings_count,number_of_pages_median,edition_count';

const tagged = (kind, message) => Object.assign(new Error(message), { kind });

const getJson = async (url, signal) => {
    let res;
    try {
        res = await fetch(url, { headers: HEADERS, signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('offline', e?.message || 'Network request failed');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw tagged(res.status === 429 ? 'throttled' : 'server', 'HTTP ' + res.status);
    try {
        return await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw tagged('server', 'Malformed response');
    }
};

/**
 * Works whose title matches, most relevant first.
 * @returns {Promise<Array<{ key, title, authors: string[], year, coverUrl, rating,
 *   ratingsCount, pages, editions, url }>>}
 */
export const searchOpenLibraryByTitle = async (title, signal, limit = 20) => {
    const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=${limit}&fields=${FIELDS}`;
    const d = await getJson(url, signal);
    return (d?.docs || []).filter(doc => doc.key && doc.title).map(doc => ({
        key: doc.key,                                   // "/works/OL123W"
        title: doc.title,
        authors: doc.author_name || [],
        year: doc.first_publish_year || null,
        coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
        rating: typeof doc.ratings_average === 'number' ? Math.round(doc.ratings_average * 100) / 100 : null,
        ratingsCount: doc.ratings_count || 0,
        pages: doc.number_of_pages_median || null,
        editions: doc.edition_count || 0,
        url: `https://openlibrary.org${doc.key}`,
    }));
};

/** A work's description (plain text), or '' when it has none. */
export const fetchOpenLibraryDescription = async (key, signal) => {
    if (!key) return '';
    const d = await getJson(`https://openlibrary.org${key}.json`, signal);
    const desc = d?.description;
    const text = typeof desc === 'string' ? desc : (desc && typeof desc.value === 'string' ? desc.value : '');
    // Descriptions carry light markdown / wiki links; keep the words.
    return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
        .replace(/-{3,}[\s\S]*$/, '').trim();
};

export const openLibrarySearchUrl = (title) => `https://openlibrary.org/search?title=${encodeURIComponent(title)}`;
