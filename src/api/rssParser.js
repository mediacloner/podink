import * as rssParser from 'react-native-rss-parser';

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
      episodes: feed.items.map(item => ({
        id: item.id,
        title: item.title,
        description: item.description,
        release_date: item.published ? new Date(item.published).toISOString() : new Date().toISOString(),
        enclosure: item.enclosures && item.enclosures.length > 0 ? item.enclosures[0].url : null,
        duration: item.itunes && item.itunes.duration ? item.itunes.duration : 0,
      }))
    };
  } catch (error) {
    console.error('RSS Parsing Error:', error);
    throw error;
  }
};
