/**
 * bookIndex.js — scans an episode's transcript for the books it talks about
 * and stores what the catalogues say about them (EpisodeBooks rows).
 *
 * When: right after a transcription finishes (whisperService), when the
 * Player opens a transcribed episode that was never scanned, and at launch
 * for the backlog — every transcribed episode without a scan
 * (`backfillBookIndex`). Radio sessions are never scanned (they are deleted
 * when they stop).
 *
 * One queue, one scan at a time: the lookups are paced to what Open Library
 * tolerates (≈1 request/s), and two scans side by side would break that
 * pace and lose books to refused requests. Scans the user is waiting for
 * (the episode on screen, the transcript that just finished) go to the
 * front; the launch backlog fills in behind them. A scan while offline is
 * skipped without marking the episode, so the next launch or Player open
 * tries again.
 *
 * How: bookText.extractBookCandidates finds "<title> by <author>", "called
 * <title>" and "<author>'s <title>" phrases; bookResolve.resolveCandidates
 * confirms each against Open Library, then Goodreads. The Player puts the
 * confirmed titles in bold (bookText.buildBookMarks) and opens a book card
 * on tap; the Listening rows show a book badge with the count.
 */
import NetInfo from '@react-native-community/netinfo';
import {
    getEpisodeById, getEpisodesNeedingBookScan, getTranscriptsForEpisode, replaceEpisodeBooks,
} from '../database/queries';
import { searchOpenLibraryByTitle, fetchOpenLibraryDescription } from '../api/openLibrary';
import { searchGoodreads } from '../api/goodreads';
import { extractBookCandidates, joinSegments } from './bookText';
import { resolveCandidates } from './bookResolve';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const isOnline = async () => {
    try {
        const st = await NetInfo.fetch();
        return st?.isConnected !== false && st?.isInternetReachable !== false;
    } catch (_) {
        return true; // no way to tell — try, the lookups fail softly
    }
};

// ─── Queue ───────────────────────────────────────────────────────────────────

const _queue = [];            // [{ id, force, resolvers: [fn] }]
const _queued = new Map();    // id → item in _queue
let _running = null;          // id being scanned
let _pumping = false;

const pump = async () => {
    if (_pumping) return;
    _pumping = true;
    try {
        while (_queue.length) {
            const item = _queue.shift();
            _queued.delete(item.id);
            _running = item.id;
            let result = null;
            try {
                result = await scanOne(item.id, item.force);
            } catch (e) {
                log('SYSTEM', 'Book scan failed', { id: item.id, error: e?.message || String(e) });
            } finally {
                _running = null;
            }
            for (const r of item.resolvers) { try { r(result); } catch (_) {} }
        }
    } finally {
        _pumping = false;
    }
};

/**
 * Queues a scan of the episode unless it was already scanned (`force`
 * rescans — after a transcript grew). `front` puts it ahead of the backlog.
 * Resolves, once the scan ran, to the stored books; null when skipped.
 */
export const indexEpisodeBooks = (episodeId, { force = false, front = false } = {}) => new Promise((resolve) => {
    if (!episodeId || String(episodeId).startsWith('radio:')) { resolve(null); return; }
    const existing = _queued.get(episodeId);
    if (existing) {
        existing.force = existing.force || force;
        existing.resolvers.push(resolve);
        if (front) {
            const i = _queue.indexOf(existing);
            if (i > 0) { _queue.splice(i, 1); _queue.unshift(existing); }
        }
        return;
    }
    if (_running === episodeId && !force) { resolve(null); return; }
    const item = { id: episodeId, force, resolvers: [resolve] };
    _queued.set(episodeId, item);
    if (front) _queue.unshift(item); else _queue.push(item);
    pump();
});

/** Every transcribed episode that was never scanned, oldest listens last. */
export const backfillBookIndex = async () => {
    try {
        if (!(await isOnline())) return 0;
        const ids = await getEpisodesNeedingBookScan();
        if (!ids.length) return 0;
        log('SYSTEM', 'Book scan backlog queued', { episodes: ids.length });
        for (const id of ids) indexEpisodeBooks(id);
        return ids.length;
    } catch (e) {
        log('SYSTEM', 'Book scan backlog failed', { error: e?.message || String(e) });
        return 0;
    }
};

export const isBookIndexRunning = (episodeId) => _running === episodeId || _queued.has(episodeId);

// ─── One scan ────────────────────────────────────────────────────────────────

const scanOne = async (episodeId, force) => {
    const ep = await getEpisodeById(episodeId);
    if (!ep) return null;
    if (ep.books_indexed_at && !force) return null;
    const rows = await getTranscriptsForEpisode(episodeId);
    if (!rows.length) return null;
    if (!(await isOnline())) {
        log('SYSTEM', 'Book scan postponed: offline', { id: episodeId });
        return null;
    }

    const { text, msAt } = joinSegments(rows);
    const cands = extractBookCandidates(text).map(c => ({ ...c, ms: msAt(c.index) }));
    log('SYSTEM', 'Book scan started', { id: episodeId, title: ep.title, words: text.split(/\s+/).length, candidates: cands.length });
    const t0 = Date.now();
    const books = await resolveCandidates(cands, {
        searchOpenLibrary: searchOpenLibraryByTitle,
        searchGoodreads,
        fetchOpenLibraryDescription,
        sleep,
        log: (msg, data) => log('SYSTEM', `Book scan: ${msg}`, data),
    });
    await replaceEpisodeBooks(episodeId, books);
    log('SYSTEM', 'Book scan finished', {
        id: episodeId, books: books.length, seconds: Math.round((Date.now() - t0) / 1000),
        titles: books.map(b => `${b.title} — ${b.author}`).slice(0, 30),
    });
    try { notifyLibraryChange({ type: 'books-indexed', episodeId, count: books.length }); } catch (_) {}
    return books;
};
