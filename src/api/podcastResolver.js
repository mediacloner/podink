/**
 * Resolves various podcast URL formats to an RSS feed URL.
 * Add new services by adding a detector + resolver below.
 */

// ─── Apple Podcasts ───────────────────────────────────────────────────────────
// e.g. https://podcasts.apple.com/us/podcast/name/id123456789

const isApplePodcasts = (url) => url.includes('podcasts.apple.com');

const resolveApplePodcasts = async (url) => {
    const match = url.match(/\/id(\d+)/);
    if (!match) throw new Error('Could not find a podcast ID in this Apple Podcasts link.');

    const response = await fetch(
        `https://itunes.apple.com/lookup?id=${match[1]}&entity=podcast`
    );
    if (!response.ok) throw new Error('Apple Podcasts lookup failed.');

    const data = await response.json();
    const feedUrl = data?.results?.[0]?.feedUrl;
    if (!feedUrl) throw new Error('No RSS feed found for this Apple Podcasts link.');

    return feedUrl;
};

// ─── Spotify ──────────────────────────────────────────────────────────────────
// Spotify doesn't expose RSS feeds publicly — let the user know.

const isSpotify = (url) => url.includes('open.spotify.com/show');

const resolveSpotify = async () => {
    throw new Error('Spotify does not provide public RSS feeds. Try finding the podcast on Apple Podcasts or the show\'s website.');
};

// ─── YouTube ──────────────────────────────────────────────────────────────────
// A video link is not a feed: the Feed's add box hands it to the YouTube
// import (services/youtubeService), which downloads the audio and transcribes
// it. Channel / playlist links are not supported.

const isYouTube = (url) => /(^|\/\/|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)(\/|$)/i.test(url);

const resolveYouTube = async () => {
    throw new Error('This is a YouTube link. Use "Import from YouTube" (My Podcasts → folder button) to add the video\'s audio with a transcript.');
};

// ─── Public resolver ──────────────────────────────────────────────────────────

/**
 * Returns an RSS feed URL for any supported input.
 * Throws with a human-readable message if resolution fails.
 *
 * @param {string} input - Raw user input (RSS URL or service link)
 * @returns {Promise<string>} RSS feed URL
 */
export const resolveToRssUrl = async (input) => {
    const url = input.trim();

    if (isSpotify(url))       return resolveSpotify(url);
    if (isYouTube(url))       return resolveYouTube(url);
    if (isApplePodcasts(url)) return resolveApplePodcasts(url);

    // Assume it's already an RSS/Atom feed URL
    return url;
};

/**
 * Returns a short label for the detected service (for UI feedback).
 */
export const detectService = (input) => {
    const url = input.trim();
    if (isSpotify(url))       return 'Spotify';
    if (isYouTube(url))       return 'YouTube';
    if (isApplePodcasts(url)) return 'Apple Podcasts';
    return 'RSS';
};
