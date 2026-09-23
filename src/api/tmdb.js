/**
 * The Movie Database — films and television, with the listener's own key
 * (Settings → Films and television). A key is free and issued at once from a
 * TMDB account; without one the entity cards fall back to Wikipedia, which
 * knows the film but not its poster, its rating or its IMDb id.
 *
 * IMDb itself has no free API — its developer access is an enterprise
 * arrangement through AWS Data Exchange — so the IMDb link on a card comes
 * from TMDB's `external_ids`, which is the one call made beyond the search.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { USER_AGENT } from './userAgent';

export const TMDB_KEY_KEY = '@tmdb_api_key';
const BASE = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p/w342';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

export const getTmdbKey = async () => {
    try { return ((await AsyncStorage.getItem(TMDB_KEY_KEY)) || '').trim(); } catch (_) { return ''; }
};

const getJson = async (url, signal) => {
    let res;
    try {
        res = await fetch(url, { headers: HEADERS, signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        return null;
    }
    if (!res.ok) return null;
    try { return await res.json(); } catch (_) { return null; }
};

/**
 * The best match for a title. `kind` is 'movie' or 'tv'; `year` narrows it
 * when the episode said one. Resolves
 * { id, title, subtitle, year, imageUrl, blurb, rating, ratingsCount, url, imdbUrl }
 * or null — a missing key, a miss and a network failure all look the same to
 * the caller, which simply falls back.
 */
export const searchTmdb = async (kind, title, { year = null, apiKey = null, signal } = {}) => {
    const key = apiKey || (await getTmdbKey());
    const q = String(title || '').trim();
    if (!key || !q) return null;
    const dated = kind === 'movie' ? 'primary_release_year' : 'first_air_date_year';
    const url = `${BASE}/search/${kind}?api_key=${encodeURIComponent(key)}`
        + `&query=${encodeURIComponent(q)}&include_adult=false`
        + (year ? `&${dated}=${year}` : '');
    const data = await getJson(url, signal);
    const hit = Array.isArray(data?.results) ? data.results[0] : null;
    if (!hit) return null;
    const ids = await getJson(`${BASE}/${kind}/${hit.id}/external_ids?api_key=${encodeURIComponent(key)}`, signal);
    const released = String(hit.release_date || hit.first_air_date || '');
    return {
        id: String(hit.id),
        title: hit.title || hit.name || q,
        subtitle: kind === 'movie' ? 'Film' : 'Television',
        year: /^(\d{4})/.test(released) ? Number(released.slice(0, 4)) : null,
        imageUrl: hit.poster_path ? IMAGE + hit.poster_path : null,
        blurb: (hit.overview || '').trim(),
        rating: Number.isFinite(hit.vote_average) && hit.vote_average > 0 ? Number(hit.vote_average) : null,
        ratingsCount: Number(hit.vote_count) || 0,
        url: `https://www.themoviedb.org/${kind}/${hit.id}`,
        imdbUrl: ids?.imdb_id ? `https://www.imdb.com/title/${ids.imdb_id}/` : null,
    };
};
