/**
 * bookService — an audiobook's EPUB as the transcript of its chapters (4.8.0).
 *
 * The user asked for the book's own text in place of a recognised
 * transcript: "import with the own epub and not transcribe — use the book
 * to read". So a collection can carry its EPUB (imports/<id>/book.epub,
 * with the parsed text beside it as book.json and Podcasts.book_path set),
 * and each chapter mapped to a part of it (bookMap.js) gets that part's
 * words as Transcripts rows straight away — one row per word at estimated
 * times, so the Player reads along at once with no engine work.
 *
 * Timing is an estimate until speech recognition supplies word timestamps.
 * Matching pauses alone cannot identify which sentence was spoken. Sync runs
 * the on-device speech engine in align mode: its words only supply timing,
 * and the EPUB remains the displayed text. Older pause-based results remain
 * readable but are offered for sync again.
 *
 * The pause scanner below remains an approximate timing helper; it must not
 * mark its results as speech-aligned.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { openZip } from './zipReader';
import { fileReader } from './mdx';
import { readEpub } from './epubText';
import { FALLBACK_WPM, paceIfImpossible, prepareBook, wordsInRange, estimateRows } from './bookMap';
import { alignBookToAsr } from './bookAlign';
import { alignBookToSilences } from './bookSilence';
import {
    deleteEpisodeTranscript, getEpisodeById, replaceEpisodeTranscript, updateCollection, updateEpisodeBookRange,
} from '../database/queries';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

const Native = Platform.OS === 'android' ? NativeModules.AudioImport : null;
const emitter = Native ? new NativeEventEmitter(Native) : null;
const SILENCE_EVENT = 'AudioSilenceProgress';

/** file:// URI → the path native code opens. Imported chapters carry %20 in
 *  their names, and a decoder handed the encoded form finds no file. (The
 *  same rule as whisperService.fileUriToPath, kept here so the book service
 *  and the transcription service do not import each other.) */
const nativePath = (uri) => {
    const raw = String(uri || '').replace(/^file:\/\//, '');
    try { return decodeURIComponent(raw); } catch (_) { return raw; }
};

export const BOOK_FILE = 'book.epub';
export const BOOK_TEXT_FILE = 'book.json';
// Below this share of the book's words found in the recognised audio, the
// chapter is most likely mapped to the wrong text — keep the estimate.
const MIN_MATCH_RATIO = 0.25;
// Under this, a chapter is too short for pauses to say anything the guessed
// pace does not already say.
const SHORT_CHAPTER_MS = 120000;

// A scan is only evidence when it reached the end of the chapter; a decode
// that stopped early would squeeze the text into the part it did read.
const SCAN_COVERAGE = 0.97;
const covers = (scan, claimedMs) =>
    !(claimedMs > 0) || (scan?.durationMs || 0) >= claimedMs * SCAN_COVERAGE;

// Episodes.transcript_aligned: how the book text is timed.
export const TIMED_GUESS = 0;    // an estimated reading pace
export const TIMED_VOICE = 1;    // legacy pause-based estimate
export const TIMED_SPEECH = 3;   // matched to recognised words
export const TIMED_MISFIT = 2;   // this audio does not read this text at all

const importsRoot = () => new Directory(Paths.document, 'imports');
const collectionDir = (feedUrl) => new Directory(importsRoot(), String(feedUrl).replace(/^local:\/\//, ''));
const bookCache = () => new Directory(Paths.cache, 'import-books');
const ensure = (d) => { if (!d.exists) d.create({ intermediates: true }); return d; };

/** A book-sourced transcript (the author's words, not the recogniser's). */
export const isBookTranscript = (episode) => episode?.transcript_source === 'book';
/** Book text still at a guessed pace: the lists and the Player offer to match it. */
export const needsSync = (episode) =>
    isBookTranscript(episode) && [TIMED_GUESS, TIMED_VOICE].includes(episode?.transcript_aligned || 0) && !!episode?.has_transcript;
/**
 * The words shown cannot be what this audio reads — far too many of them for
 * its length, or far too few. Matching them to the voice would be meaningless,
 * so the chapter says so and the part it reads is changed in the editor.
 */
export const textDoesNotFit = (episode) =>
    isBookTranscript(episode) && (episode?.transcript_aligned || 0) === TIMED_MISFIT;

/** Episodes.book_range (JSON) → range object, or null. */
export const parseRange = (value) => {
    try {
        const r = typeof value === 'string' ? JSON.parse(value) : value;
        return r && Number.isFinite(r.s0) && Number.isFinite(r.s1) ? r : null;
    } catch (_) {
        return null;
    }
};

/** Parse an EPUB at a file:// URI into the prepared book (bookMap.prepareBook). */
export const parseBookFile = async (fileUri) => {
    const file = new File(fileUri);
    if (!file.exists) throw new Error('Book file not found');
    const zip = openZip(fileReader(file));
    const epub = await readEpub(async (p) => (zip.has(p) ? zip.readText(p) : null));
    const book = prepareBook(epub);
    if (!book.sections.some((s) => s.words > 0)) throw new Error('The EPUB has no readable text');
    log('SERVICE', 'Book parsed', {
        title: book.title, sections: book.sections.length,
        words: book.sections.reduce((n, s) => n + s.words, 0),
    });
    return book;
};

/**
 * A picked EPUB (`{uri, name}`, content:// or file://) copied into the
 * cache and parsed, for the import form: `{ uri, name, book }`. The import
 * moves it into the collection's folder (attachBook).
 */
export const stageBook = async (entry) => {
    const dest = new File(ensure(bookCache()), `book_${Date.now().toString(36)}.epub`);
    try { if (dest.exists) dest.delete(); } catch (_) {}
    await Native.copyToFile(entry.uri, dest.uri, `book${Date.now().toString(36)}`);
    const book = await parseBookFile(dest.uri);
    return { uri: dest.uri, name: entry.name || BOOK_FILE, book };
};

/** Previews left by an abandoned import. */
export const clearBookCache = () => {
    try {
        const d = bookCache();
        if (d.exists) for (const f of d.list()) { try { f.delete(); } catch (_) {} }
    } catch (_) {}
};

/**
 * Keep a staged EPUB with its collection: the file moves to
 * imports/<id>/book.epub, its text is written as book.json and
 * Podcasts.book_path records it. Returns the stored file's URI.
 */
export const attachBook = async (feedUrl, stagedUri, book) => {
    const dir = ensure(collectionDir(feedUrl));
    const dest = new File(dir, BOOK_FILE);
    const src = new File(stagedUri);
    if (src.uri !== dest.uri) {
        try { if (dest.exists) dest.delete(); } catch (_) {}
        src.move(dest);
    }
    const text = new File(dir, BOOK_TEXT_FILE);
    try { if (text.exists) text.delete(); } catch (_) {}
    text.write(JSON.stringify(book));
    await updateCollection(feedUrl, { book_path: dest.uri });
    _bookCache = { feedUrl, book };
    log('SERVICE', 'Book attached', { feedUrl, title: book.title, sections: book.sections.length });
    return dest.uri;
};

// One book is read for every chapter of it in turn (the import matches sixty
// in a row), and a novel's text is a megabyte of JSON: keep the last one.
let _bookCache = { feedUrl: null, book: null };
export const forgetBookCache = (feedUrl) => {
    if (!feedUrl || _bookCache.feedUrl === feedUrl) _bookCache = { feedUrl: null, book: null };
};

/** The collection's prepared book (book.json), or null when it has none. */
export const loadBook = async (feedUrl) => {
    if (_bookCache.feedUrl === feedUrl && _bookCache.book) return _bookCache.book;
    try {
        const f = new File(collectionDir(feedUrl), BOOK_TEXT_FILE);
        if (!f.exists) return null;
        const book = JSON.parse(await f.text());
        _bookCache = { feedUrl, book };
        return book;
    } catch (e) {
        log('SERVICE', 'Book text unreadable', { feedUrl, error: e?.message || String(e) });
        return null;
    }
};

/**
 * Write the book's words for `range` as the episode's transcript at
 * estimated times (bookMap.estimateRows). `range` null clears a book
 * transcript (the chapter has no text). Returns the number of rows.
 */
export const applyBookText = async (episode, book, range) => {
    if (!range) {
        if (isBookTranscript(episode)) await deleteEpisodeTranscript(episode.id);
        await updateEpisodeBookRange(episode.id, null);
        return { rows: 0, misfit: 0 };
    }
    const words = wordsInRange(book, range);
    const durationMs = (episode.duration || 0) * 1000;
    const misfit = paceIfImpossible(words.length, durationMs);
    // Spreading a whole chapter of text across half a minute of audio makes
    // the reader race through thousands of words and the transcript scroll
    // wildly (user: "when you play a spisode the scroll is crazy"). Where the
    // two plainly do not belong together, lay the words out at an ordinary
    // reading pace and say so, rather than pretend to a timing.
    const rows = estimateRows(words, misfit ? words.length * (60000 / FALLBACK_WPM) : durationMs);
    await replaceEpisodeTranscript(episode.id, rows, {
        source: 'book', aligned: misfit ? TIMED_MISFIT : TIMED_GUESS, range,
    });
    return { rows: rows.length, misfit };
};

/** The words of the part of the book an episode reads, or null. */
const episodeWords = async (episode) => {
    const range = parseRange(episode.book_range);
    if (!range) return null;
    const book = await loadBook(episode.podcast_feed_url);
    if (!book) return null;
    return wordsInRange(book, range);
};

// ─── Matching the text to the voice ─────────────────────────────────────────

let _silenceSeq = 0;
/** AudioImport.analyzeSilence with progress as a 0..1 fraction. */
export const scanPauses = (audioPath, onFraction) => {
    const jobId = `sil${++_silenceSeq}`;
    const sub = emitter?.addListener(SILENCE_EVENT, (e) => {
        if (e?.jobId !== jobId || !onFraction) return;
        onFraction(e.total > 0 ? Math.min(1, e.copied / e.total) : 0);
    });
    return Native.analyzeSilence(nativePath(audioPath), { minSilenceMs: 220, thresholdDb: 9 }, jobId)
        .finally(() => sub?.remove());
};

/**
 * Give one chapter's book text the narrator's timing, from its pauses alone.
 * Resolves with the alignment's stats, or null when the chapter has no book
 * text. Throws when the audio yields too few pauses to go on, leaving the
 * estimate in place.
 */
export const syncEpisodeToVoice = async (episode, { onProgress } = {}) => {
    const ep = episode.book_range ? episode : await getEpisodeById(episode.id);
    if (!ep?.local_audio_path) throw new Error('Audio file not found');
    const words = await episodeWords(ep);
    if (!words?.length) return null;
    const range = parseRange(ep.book_range);

    // Far too many words for the chapter's length, or far too few: this audio
    // is not reading this part of the book, and no amount of decoding will
    // change that. Mark it so the chapter says so and stops offering a match,
    // and leave the words at an ordinary reading pace meanwhile.
    const misfits = async (wpm) => {
        const rows = estimateRows(words, words.length * (60000 / FALLBACK_WPM));
        await replaceEpisodeTranscript(ep.id, rows, { source: 'book', aligned: TIMED_MISFIT, range });
        const err = new Error(`This chapter's audio does not read this part of the book — the words would have to go by at ${wpm} a minute. Use Edit to change the part it reads.`);
        err.code = 'TEXT_DOES_NOT_FIT';
        throw err;
    };
    const claimed = paceIfImpossible(words.length, (ep.duration || 0) * 1000);
    if (claimed) await misfits(claimed);

    // The decoder can come up short — starved of memory, or interrupted — and
    // a scan that stopped early looks exactly like a chapter whose pauses all
    // fall in the first few minutes. Timing the text against it silently puts
    // the whole chapter out of step (user: "this chapter is not sync"), so the
    // scan has to account for the chapter's own length before it is believed.
    const claimedMs = (ep.duration || 0) * 1000;
    let scan = await scanPauses(ep.local_audio_path, onProgress);
    if (!covers(scan, claimedMs)) {
        log('SERVICE', 'Pause scan came up short, reading again', {
            id: ep.id, scanned: Math.round(scan?.durationMs || 0), chapter: claimedMs,
        });
        scan = await scanPauses(ep.local_audio_path, onProgress);
        if (!covers(scan, claimedMs)) {
            const err = new Error('The audio could not be read all the way through. Try matching it again.');
            err.code = 'SCAN_INCOMPLETE';
            throw err;
        }
    }
    const spanMs = Math.max(0, (scan?.speechEndMs || scan?.durationMs || 0) - (scan?.speechStartMs || 0));
    const measured = paceIfImpossible(words.length, spanMs);
    if (measured) await misfits(measured);

    const { rows, stats } = alignBookToSilences(words, scan);
    if (!rows) {
        // A chapter of a few seconds, or one read without a pause worth the
        // name, has nothing to pin the text to. On a short one the guessed
        // pace is as good as it gets, so let it stand as the final timing
        // instead of asking again; on a long one, leave it to be retried.
        if (spanMs > SHORT_CHAPTER_MS) {
            const err = new Error(`Too few pauses to go on (${stats.pauses} found)`);
            err.code = 'TOO_FEW_PAUSES';
            throw err;
        }
        const estimate = estimateRows(words, spanMs || (ep.duration || 0) * 1000);
        await replaceEpisodeTranscript(ep.id, estimate, { source: 'book', aligned: TIMED_VOICE, range });
        log('SERVICE', 'Book text kept at its guessed pace (short chapter)', { id: ep.id, spanMs, ...stats });
        return { ...stats, kept: true };
    }
    await replaceEpisodeTranscript(ep.id, rows, { source: 'book', aligned: TIMED_VOICE, range });
    log('SERVICE', 'Book matched to the voice', { id: ep.id, ...stats });
    return stats;
};

// Queue book requests one at a time through the shared speech worker, which
// serialises model use with podcast transcription and reports its progress.
const _syncQueue = [];
let _syncActive = null;
let _syncRunning = false;
const _syncListeners = new Set();
const _notifySync = () => { [..._syncListeners].forEach((fn) => { try { fn(); } catch (_) {} }); };

export const onBookSyncChange = (fn) => { _syncListeners.add(fn); return () => _syncListeners.delete(fn); };
export const getSyncingId = () => _syncActive;
export const getSyncQueueIds = () => _syncQueue.map((e) => e.id);
export const isSyncing = (id) => _syncActive === id || _syncQueue.some((e) => e.id === id);

const _runSync = async () => {
    if (_syncRunning || !_syncQueue.length) return;
    _syncRunning = true;
    const entry = _syncQueue.shift();
    _syncActive = entry.id;
    _notifySync();
    try {
        // Resolve at job time: whisperService uses alignEpisodeWithAsr when
        // it completes, so loading it at module initialisation creates a cycle.
        const { enqueueTranscription } = require('./whisperService');
        const ep = await getEpisodeById(entry.id);
        if (!ep?.local_audio_path) throw new Error('Audio file not found');
        await enqueueTranscription(ep.id, ep.local_audio_path,
            (percent) => notifyLibraryChange({ type: 'book-sync-progress', episodeId: ep.id, percent }),
            null, ep.duration || 0, { align: true });
        notifyLibraryChange({ type: 'book-sync-done', episodeId: entry.id });
    } catch (e) {
        log('SERVICE', 'Book sync failed', { id: entry.id, code: e?.code, error: e?.message || String(e) });
        notifyLibraryChange({
            type: 'book-sync-error', episodeId: entry.id, error: e?.message || String(e), code: e?.code, ask: !!entry.ask,
        });
    } finally {
        _syncActive = null;
        _syncRunning = false;
        _notifySync();
        if (_syncQueue.length) setTimeout(_runSync, 0);
    }
};

/** Queue chapters (rows with id, local_audio_path, book_range) for matching. */
export const queueVoiceSync = (episodes, { ask = false, again = false } = {}) => {
    let added = 0;
    for (const ep of episodes || []) {
        if (!ep?.id || isSyncing(ep.id)) continue;
        // `ask` marks a match a listener pressed for: that one reports back
        // when it cannot be done. A whole book queued by the import stays
        // quiet, or it would interrupt sixty times over.
        _syncQueue.push({ id: ep.id, episode: ep, ask, again });
        added++;
    }
    if (added) {
        _notifySync();
        setTimeout(_runSync, 0);
    }
    return added;
};

/** Drop a chapter from the queue (the one being decoded runs to its end). */
export const dequeueVoiceSync = (id) => {
    const i = _syncQueue.findIndex((e) => e.id === id);
    if (i >= 0) { _syncQueue.splice(i, 1); _notifySync(); }
};

/**
 * The exact path: the recogniser's rows ({start, end, text}, ms) for a
 * book-sourced chapter → the same book words at the narrator's times. Throws
 * when the audio and the text do not match, leaving what was there in place.
 */
export const alignEpisodeWithAsr = async (episodeId, asrRows) => {
    const ep = await getEpisodeById(episodeId);
    if (!ep) throw new Error('Episode not found');
    const range = parseRange(ep.book_range);
    if (!range) throw new Error('This chapter has no book text to sync');
    const all = await episodeWords(ep);
    if (!all) throw new Error('The book text is missing');
    const words = all.map((w) => w.text);
    const { rows, stats } = alignBookToAsr(words, asrRows, (ep.duration || 0) * 1000);
    log('SERVICE', 'Book aligned', { id: episodeId, ...stats });
    if (stats.matchedRatio < MIN_MATCH_RATIO) {
        throw new Error(`The audio does not read this text (${Math.round(stats.matchedRatio * 100)}% of the words were heard)`);
    }
    await replaceEpisodeTranscript(episodeId, rows, { source: 'book', aligned: TIMED_SPEECH, range });
    return stats;
};
