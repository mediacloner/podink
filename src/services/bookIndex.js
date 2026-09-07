/**
 * bookIndex.js — scans an episode's transcript for the books it talks about
 * and stores what the catalogues say about them (EpisodeBooks rows).
 *
 * When: right after a transcription finishes (whisperService), and when the
 * Player opens a transcribed episode that was never scanned (or was scanned
 * offline — then nothing is stored and the next open tries again). One scan
 * per episode at a time; radio sessions are never scanned (they are deleted
 * when they stop).
 *
 * How: bookText.extractBookCandidates finds "<title> by <author>", "called
 * <title>" and "<author>'s <title>" phrases; bookResolve.resolveCandidates
 * confirms each against Open Library, then Goodreads, with the network paced
 * to what the sites tolerate. The Player puts the confirmed titles in bold
 * (bookText.buildBookMarks) and opens a book card on tap.
 */
import NetInfo from '@react-native-community/netinfo';
import { getEpisodeById, getTranscriptsForEpisode, replaceEpisodeBooks } from '../database/queries';
import { searchOpenLibraryByTitle, fetchOpenLibraryDescription } from '../api/openLibrary';
import { searchGoodreads } from '../api/goodreads';
import { extractBookCandidates, joinSegments } from './bookText';
import { resolveCandidates } from './bookResolve';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

const _inFlight = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const isOnline = async () => {
    try {
        const st = await NetInfo.fetch();
        return st?.isConnected !== false && st?.isInternetReachable !== false;
    } catch (_) {
        return true; // no way to tell — try, the lookups fail softly
    }
};

/**
 * Scans the episode unless it was already scanned (`force` rescans — after a
 * transcript grows). Resolves to the stored books, or null when skipped.
 */
export const indexEpisodeBooks = async (episodeId, { force = false } = {}) => {
    if (!episodeId || String(episodeId).startsWith('radio:')) return null;
    if (_inFlight.has(episodeId)) return null;
    _inFlight.add(episodeId);
    try {
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
        log('SYSTEM', 'Book scan started', { id: episodeId, words: text.split(/\s+/).length, candidates: cands.length });
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
    } catch (e) {
        log('SYSTEM', 'Book scan failed', { id: episodeId, error: e?.message || String(e) });
        return null;
    } finally {
        _inFlight.delete(episodeId);
    }
};

export const isBookIndexRunning = (episodeId) => _inFlight.has(episodeId);
