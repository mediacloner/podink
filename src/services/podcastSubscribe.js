/**
 * A podcast an episode names, followed into the app (the podcast card,
 * components/transcript/EntitySheet.js).
 *
 * The card knows the show only by name and, when Apple Podcasts answered the
 * lookup, by its Apple page. The feed is what the app subscribes to, and it
 * also carries the show's own description — Apple's search gives none for a
 * podcast — so the card finds the feed first, reads the head of it, and
 * subscribes to that same feed when asked.
 */
import { resolveToRssUrl } from '../api/podcastResolver';
import { searchPodcasts } from '../api/podcastSearch';
import { fetchPodcastFeed } from '../api/rssParser';
import { capNewEpisodes, getPodcastByFeedUrl, saveEpisodesBatch, savePodcast } from '../database/queries';
import { blockText, showNotesToBlocks } from './showNotes';
import { notifyLibraryChange } from './libraryEvents';

// What the Feed keeps per podcast (SubscribedTimeline's MAX_EPISODES_PER_PODCAST).
const MAX_EPISODES = 50;

const key = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]/gu, '');

/** The feed behind a podcast entity, or null when no show by that name is found. */
const findFeed = async (entity) => {
    if (/podcasts\.apple\.com/.test(entity.source_url || '')) {
        try { return await resolveToRssUrl(entity.source_url); } catch (_) {}
    }
    const want = key(entity.canonical);
    if (!want) return null;
    const hits = await searchPodcasts(entity.canonical).catch(() => []);
    // Only the show by that name: a near miss would subscribe to someone else's.
    const hit = hits.find(h => key(h.title) === want)
        || hits.find(h => key(h.title).startsWith(want) && want.length >= 8);
    return hit?.feedUrl || null;
};

/**
 * { feedUrl, description, subscribed } for the card, or null when the show
 * cannot be found. `description` is the feed's own, as plain text, one paragraph a line.
 */
export const lookUpPodcast = async (entity) => {
    const feedUrl = await findFeed(entity);
    if (!feedUrl) return null;
    const [feed, row] = await Promise.all([
        fetchPodcastFeed(feedUrl, { maxItems: 1 }).catch(() => null),
        getPodcastByFeedUrl(feedUrl).catch(() => null),
    ]);
    return {
        feedUrl,
        // Paragraphs kept: the card folds a long description itself.
        description: showNotesToBlocks(feed?.description || '').map(b => blockText(b).trim()).filter(Boolean).join('\n'),
        subscribed: !!row,
    };
};

/** Subscribes to the feed as the Feed's own Add does. Rejects when the feed will not load. */
export const subscribeToPodcast = async (feedUrl) => {
    const feed = await fetchPodcastFeed(feedUrl, { maxItems: MAX_EPISODES });
    await savePodcast({ title: feed.title, description: feed.description, feed_url: feedUrl, image_url: feed.image });
    await saveEpisodesBatch(feed.episodes.slice(0, MAX_EPISODES).map(ep => ({
        ...ep,
        podcast_title: feed.title,
        podcast_feed_url: feedUrl,
        description: ep.description || '',
        audio_url: ep.enclosure,
    })));
    // A new subscription's back catalogue is not "new": only its latest five keep the dot.
    await capNewEpisodes(feedUrl);
    notifyLibraryChange({ type: 'subscribe' });
};
