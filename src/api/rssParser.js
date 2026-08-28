import * as rssParser from 'react-native-rss-parser';
import { log } from '../services/logService';

// The app never keeps more than this many episodes per podcast
// (SubscribedTimeline.MAX_EPISODES_PER_PODCAST), so it never needs to parse
// more than this many either.
const DEFAULT_MAX_ITEMS = 50;

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

/**
 * Drop every <item> after the first `maxItems` from an RSS 2.0 document,
 * keeping everything else.
 *
 * Podcast feeds ship their whole back catalogue — The Daily's is ~20 MB and
 * 2,960 items — and react-native-rss-parser (xmldom) builds the full DOM
 * synchronously on the JS thread. Parsing that froze the UI for the whole
 * refresh: taps on the tab bar were queued behind the parse, so you could
 * not leave the Feed while it loaded. Items are newest-first and only the
 * first `maxItems` are ever stored, so the rest is removed before the parser
 * sees it (20 MB → ~330 KB for The Daily).
 *
 * Channel-level elements are kept wherever they sit: some feeds (Dwarkesh
 * Podcast) place their <itunes:image> *after* the items, so the tail cannot
 * simply be cut off — the surplus items are excised from it instead.
 * Only <rss><channel>…<item> documents are touched; Atom (<entry>) and RDF
 * feeds are parsed whole.
 */
export const truncateFeedItems = (xml, maxItems = DEFAULT_MAX_ITEMS) => {
    if (!xml || !maxItems || maxItems <= 0) return xml;
    const firstItem = xml.indexOf('<item');
    if (firstItem < 0) return xml;
    if (xml.lastIndexOf('<rss', firstItem) < 0 || xml.lastIndexOf('<channel', firstItem) < 0) return xml;

    // End of the item that closes the kept set.
    const closer = /<\/item\s*>/g;
    let keepEnd = -1;
    let count = 0;
    let m;
    while (count < maxItems && (m = closer.exec(xml)) !== null) {
        keepEnd = m.index + m[0].length;
        count += 1;
    }
    if (count < maxItems) return xml; // fewer items than the cap — nothing to drop

    // Copy the tail minus its <item>…</item> blocks.
    let out = xml.slice(0, keepEnd);
    let pos = keepEnd;
    let dropped = 0;
    for (;;) {
        const start = xml.indexOf('<item', pos);
        if (start < 0) break;
        const close = xml.indexOf('</item', start);
        if (close < 0) break; // malformed — keep the rest verbatim
        const end = xml.indexOf('>', close);
        if (end < 0) break;
        out += xml.slice(pos, start);
        pos = end + 1;
        dropped += 1;
    }
    if (dropped === 0) return xml; // exactly the cap — nothing dropped
    return out + xml.slice(pos);
};

export const fetchPodcastFeed = async (url, { maxItems = DEFAULT_MAX_ITEMS } = {}) => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch RSS: ${response.status}`);
    }
    const responseData = await response.text();
    const xml = truncateFeedItems(responseData, maxItems);
    // Parse time is JS-thread time the UI cannot use — visible in Debug Log.
    const t0 = Date.now();
    const feed = await rssParser.parse(xml);
    log('SERVICE', 'Feed parsed', {
        url, bytes: responseData.length, parsedBytes: xml.length,
        items: feed.items.length, ms: Date.now() - t0,
    });

    // Normalize and return standard metadata needed for the UI
    return {
      title: feed.title,
      description: feed.description,
      // Many hosts (Anchor/Spotify, Substack, the Dwarkesh feed) declare the
      // cover only as <itunes:image href> and ship no RSS <image> block.
      image: feed.image?.url || feed.itunes?.image || null,
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
