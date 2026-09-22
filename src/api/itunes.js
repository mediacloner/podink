/**
 * Apple's search endpoint: no key, no account, no terms to accept, and it
 * knows records and television. It is what the entity cards use for an album
 * or a programme (services/entityIndex.js).
 *
 * Films are not here. Apple retired iTunes Movies, and `entity=movie` now
 * answers nothing at all in every storefront tried (2026-09-22) — those go to
 * TMDB when a key is set, and to Wikipedia otherwise.
 *
 * Rate limit is about twenty calls a minute, which one episode's worth of
 * lookups stays well inside.
 */
import { USER_AGENT } from './userAgent';

const ENDPOINT = 'https://itunes.apple.com/search';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

/** The 100 px thumbnail the search returns, asked for at a readable size. */
export const bigArtwork = (url, px = 600) =>
    (url ? String(url).replace(/\/\d+x\d+bb\./, `/${px}x${px}bb.`) : null);

const year = (d) => {
    const m = /^(\d{4})/.exec(String(d || ''));
    return m ? Number(m[1]) : null;
};

/**
 * `entity` is Apple's: 'album', 'tvSeason', 'song', 'audiobook'.
 * Resolves [{ id, title, subtitle, year, genre, url, imageUrl, blurb, tracks }],
 * best match first, or [] — never throws for a miss.
 */
export const searchITunes = async (term, entity, { limit = 5, country = 'US', signal } = {}) => {
    const q = String(term || '').trim();
    if (!q) return [];
    const url = `${ENDPOINT}?term=${encodeURIComponent(q)}&entity=${encodeURIComponent(entity)}`
        + `&limit=${limit}&country=${country}`;
    let res;
    try {
        res = await fetch(url, { headers: HEADERS, signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        return [];
    }
    if (!res.ok) return [];
    let data;
    try { data = await res.json(); } catch (_) { return []; }
    const rows = Array.isArray(data?.results) ? data.results : [];
    return rows.map(r => ({
        id: String(r.collectionId || r.trackId || ''),
        title: r.collectionName || r.trackName || '',
        subtitle: r.artistName || '',
        year: year(r.releaseDate),
        genre: r.primaryGenreName || '',
        url: r.collectionViewUrl || r.trackViewUrl || '',
        imageUrl: bigArtwork(r.artworkUrl100),
        blurb: (r.longDescription || r.shortDescription || '').trim(),
        tracks: Number(r.trackCount) || null,
    })).filter(r => r.title);
};
