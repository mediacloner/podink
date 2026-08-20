/**
 * Searches the Apple Podcasts (iTunes Search API) directory by name.
 * Queries the US and GB storefronts in parallel and merges the results.
 */

const SEARCH_LIMIT = 12;
const STOREFRONTS = ['US', 'GB'];

/**
 * Heuristic: is the input a URL rather than a search term?
 * URLs start with http(s):// or www., or are a single dotted token
 * (e.g. feeds.example.com/rss). Anything else is treated as a name search.
 */
export const isUrlLike = (input) => {
    const trimmed = input.trim();
    if (/^(https?:\/\/|www\.)/i.test(trimmed)) return true;
    return !/\s/.test(trimmed) && trimmed.includes('.');
};

const searchStorefront = async (term, country, signal) => {
    const response = await fetch(
        `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${SEARCH_LIMIT}&term=${encodeURIComponent(term)}&country=${country}`,
        { signal },
    );
    if (!response.ok) throw new Error('Apple Podcasts search failed.');
    const data = await response.json();
    return data?.results ?? [];
};

/**
 * Returns up to 12 podcasts matching the search term, US results first
 * (in relevance order) then GB results not already seen. One storefront
 * failing never fails the search; if both fail, throws.
 *
 * @param {string} term - Podcast name to search for
 * @param {{ signal?: AbortSignal }} [options] - Optional abort signal
 * @returns {Promise<Array<{ id, title, author, artwork, feedUrl, genre }>>}
 */
export const searchPodcasts = async (term, { signal } = {}) => {
    const settled = await Promise.allSettled(
        STOREFRONTS.map(country => searchStorefront(term, country, signal)),
    );
    if (settled.every(r => r.status === 'rejected')) {
        throw settled[0].reason;
    }

    const seen = new Set();
    const merged = [];
    for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        for (const item of result.value) {
            if (!item.feedUrl) continue;
            const key = item.feedUrl || item.collectionId;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({
                id: item.collectionId,
                title: item.collectionName,
                author: item.artistName,
                artwork: item.artworkUrl100,
                feedUrl: item.feedUrl,
                genre: item.primaryGenreName,
            });
        }
    }
    return merged.slice(0, SEARCH_LIMIT);
};
