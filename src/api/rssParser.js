import * as rssParser from 'react-native-rss-parser';

/** Parse iTunes duration string ("1:20:34", "20:34", or "1234") to seconds. */
const parseDuration = (raw) => {
    if (!raw) return 0;
    const str = String(raw).trim();
    if (!str.includes(':')) return parseInt(str, 10) || 0;
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
};

export const fetchPodcastFeed = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch RSS: ${response.status}`);
    }
    const responseData = await response.text();
    const feed = await rssParser.parse(responseData);
    
    // Normalize and return standard metadata needed for the UI
    return {
      title: feed.title,
      description: feed.description,
      image: feed.image ? feed.image.url : null,
      episodes: feed.items.map(item => {
        const enclosure = item.enclosures && item.enclosures.length > 0 ? item.enclosures[0].url : null;
        return {
          // react-native-rss-parser returns undefined for <guid>-less items.
          // Fall back to the enclosure URL (then the item link) so episodes get
          // a stable, non-NULL key and don't duplicate / crash on every refresh.
          id: item.id || enclosure || (item.links && item.links[0] && item.links[0].url) || null,
          title: item.title,
          description: item.description,
          release_date: item.published ? new Date(item.published).toISOString() : new Date().toISOString(),
          enclosure,
          duration: parseDuration(item.itunes?.duration),
        };
      })
    };
  } catch (error) {
    console.error('RSS Parsing Error:', error);
    throw error;
  }
};
