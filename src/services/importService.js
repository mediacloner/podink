/**
 * importService — local audio as a collection (3.5.0).
 *
 * An audiobook or any set of audio files becomes a Podcasts row of kind
 * 'local' (feed_url `local://<id>`, no feed to refresh) whose episodes are
 * files copied into the app's own storage:
 *
 *   Paths.document/imports/<id>/001-<file>.m4b   one per chapter
 *   Paths.document/imports/<id>/cover_<ts>.jpg   the cover, if any
 *
 * Copying (rather than keeping the picker's content:// grant) is what makes
 * the files playable, transcribable and deletable exactly like a downloaded
 * episode: local_audio_path is a file:// URI, is_downloaded = 1.
 *
 * Pickers, tags and the copy itself come from the native AudioImport module
 * (android/…/AudioImportModule.kt): Android's system picker (which lists
 * Google Drive and any other document provider), a folder tree, an image;
 * MediaMetadataRetriever for tags, duration and embedded art; a streaming
 * copy with progress events. Android only — isImportSupported() gates the UI.
 *
 * 4.8.0 — the book itself: an .epub among the picked files (or attached
 * later) is staged, parsed and kept with the collection, and each chapter
 * mapped to a part of it gets the book's words as its transcript at once
 * (bookService / bookMap). A single .m4b with chapter markers is cut into
 * one file per chapter (AudioImport.splitAudio), so the book's chapters
 * and the audio's line up one to one.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { Directory, File, Paths } from 'expo-file-system';
import { buildDraft, parseNfo, pickCoverCandidate, stripExtension } from './importMeta';
import {
    deletePodcast, getEpisodesForCollection, getMaxTrackNumber, getPodcastByFeedUrl,
    insertLocalEpisodes, saveLocalCollection, updateCollection, updateEpisodeTitle,
} from '../database/queries';
import { forgetTranscription } from './whisperService';
import { notifyUserStop } from './trackPlayer';
import { persistProgress } from './playbackService';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';
import {
    applyBookText, attachBook, clearBookCache, forgetBookCache, loadBook, parseRange, queueVoiceSync, stageBook,
} from './bookService';
import { autoMapChapters } from './bookMap';

const Native = Platform.OS === 'android' ? NativeModules.AudioImport : null;
const emitter = Native ? new NativeEventEmitter(Native) : null;

const COVER_MAX_PX = 1024;
const PROGRESS_EVENT = 'AudioImportProgress';

export const isImportSupported = () => !!Native;

// ─── Storage layout ──────────────────────────────────────────────────────────

const importsRoot = () => new Directory(Paths.document, 'imports');
const collectionId = (feedUrl) => String(feedUrl).replace(/^local:\/\//, '');
const collectionDir = (feedUrl) => new Directory(importsRoot(), collectionId(feedUrl));
const coverCache = () => new Directory(Paths.cache, 'import-covers');
const ensure = (d) => { if (!d.exists) d.create({ intermediates: true }); return d; };

const safeFileName = (name) =>
    String(name || '').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'audio';
const extOf = (name) => {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
    return m ? `.${m[1].toLowerCase()}` : '.mp3';
};
/** Previews left by an abandoned import / edit (the chosen one is moved out). */
const clearCoverCache = () => {
    try {
        const d = coverCache();
        if (d.exists) for (const f of d.list()) { try { f.delete(); } catch (_) {} }
    } catch (_) {}
};
const removeFileQuietly = (uri) => {
    try {
        const f = new File(uri);
        if (f.exists) f.delete();
    } catch (_) {}
};

// ─── Pickers ────────────────────────────────────────────────────────────────

/** Android's document picker, multi-select. Resolves to the chosen entries
 *  (`{uri, name, mimeType, size, kind}`), or null when the user backs out. */
export const pickAudioFiles = async () => {
    const res = await Native.pickAudio(true);
    return Array.isArray(res) && res.length ? res : null;
};

/** Folder picker, then a recursive listing of its audio, image and text
 *  files. `{ name, entries }` or null when cancelled. */
export const pickFolder = async () => {
    const folder = await Native.pickFolder();
    if (!folder?.uri) return null;
    const entries = await Native.listFolder(folder.uri);
    return { name: folder.name || 'Folder', entries: Array.isArray(entries) ? entries : [] };
};

/** Image picker for a cover. `{uri, name}` or null. */
export const pickImage = () => Native.pickImage();

/** Document picker for one EPUB. `{uri, name, kind}` or null. */
export const pickBook = async () => {
    const res = await Native.pickBook();
    return res?.uri ? res : null;
};

/** Copy a picked EPUB into the cache and parse it: `{ uri, name, book }` (bookService.stageBook). */
export const stageBookFile = (entry) => stageBook(entry);

/** bookMap.autoMapChapters, for the editor to redo the mapping when the chapter list changes. */
export const mapChaptersToBook = (chapters, book) => autoMapChapters(chapters, book);

// Files whose container can carry chapter markers (AudioImport.readChapters).
const MP4_FAMILY = /\.(m4b|m4a|mp4)$/i;
// A file cut at its markers: one editor chapter per marker, sharing the source uri.
const MIN_MARKER_MS = 1000; // a marker at the very end of the file names no audio
// How many chapters have their text matched to the voice as part of the
// import itself — enough that the beginning of a book is exact at once.
const PREMATCH_CHAPTERS = 3;
const expandEmbedded = (chapters) => chapters.flatMap((ch) => {
    if (!ch.embeddedChapters?.length) return [ch];
    const stem = stripExtension(ch.name);
    return ch.embeddedChapters.filter((m) => m.endMs - m.startMs >= MIN_MARKER_MS).map((m, k) => {
        const title = (m.title || '').trim() || `Chapter ${k + 1}`;
        return {
            uri: ch.uri,
            name: `${stem} - ${String(k + 1).padStart(2, '0')} ${title}.m4a`,
            size: -1,
            title,
            track: k + 1,
            durationSec: Math.max(0, Math.round((m.endMs - m.startMs) / 1000)),
            hasCover: ch.hasCover,
            clip: { startMs: m.startMs, endMs: m.endMs },
            sourceName: ch.name,
        };
    });
});

// ─── Analysis ───────────────────────────────────────────────────────────────

// Document providers that serve files from the device itself; anything else
// (Drive is com.google.android.apps.docs.storage) has to download on open.
const LOCAL_AUTHORITIES = new Set([
    'com.android.externalstorage.documents',
    'com.android.providers.media.documents',
    'com.android.providers.downloads.documents',
]);
export const isCloudDocument = (uri) => {
    const m = /^content:\/\/([^/]+)\//.exec(uri || '');
    return !!m && !LOCAL_AUTHORITIES.has(m[1]);
};

/**
 * Read every chosen audio file's tags and any .nfo / .txt companion, and
 * build the editable draft (see importMeta.buildDraft) plus `cover`, the
 * suggested cover source. onProgress({done, total}) ticks per file;
 * `context` = { title, stems } of an existing collection when appending.
 * Throws `code 'NO_AUDIO'` when nothing in the selection is audio.
 */
export const analyzeSelection = async (entries, { folderName = '', onProgress, context = null } = {}) => {
    const audio = entries.filter(e => e.kind === 'audio');
    const images = entries.filter(e => e.kind === 'image');
    const texts = entries.filter(e => e.kind === 'text' && /\.(nfo|txt)$/i.test(e.name || ''));
    const bookFiles = entries.filter(e => e.kind === 'book' || /\.epub$/i.test(e.name || ''));
    if (!audio.length) {
        const err = new Error('No audio files in the selection');
        err.code = 'NO_AUDIO';
        throw err;
    }
    clearCoverCache();
    clearBookCache();

    // Opening a cloud document (Google Drive, OneDrive…) makes its provider
    // download the whole file first, so reading 60 chapters' tags would pull
    // the whole book down before the copy pulls it again. For those, only the
    // first file is opened — for the album, author and cover — and chapter
    // names come from the file names; durations arrive on first play.
    const remote = audio.some(e => isCloudDocument(e.uri));
    const items = [];
    for (let i = 0; i < audio.length; i++) {
        onProgress?.({ done: i, total: audio.length });
        let tags = {};
        if (!remote || i === 0) {
            try {
                tags = (await Native.readMetadata(audio[i].uri)) || {};
            } catch (e) {
                log('SERVICE', 'Import: tags unreadable', { name: audio[i].name, error: e?.message || String(e) });
            }
            // The one file read on a cloud import must not name its chapter
            // differently from the rest (which fall back to file names).
            if (remote && audio.length > 1) tags = { ...tags, title: null, track: null, disc: null };
        }
        // Chapter markers inside the file (a whole audiobook as one .m4b):
        // two or more make it a candidate for splitting (expandEmbedded).
        let embeddedChapters = null;
        if (MP4_FAMILY.test(audio[i].name || '') && (!remote || i === 0)) {
            try {
                const marks = await Native.readChapters(audio[i].uri);
                if (Array.isArray(marks) && marks.length >= 2) embeddedChapters = marks;
            } catch (e) {
                log('SERVICE', 'Import: chapter markers unreadable', { name: audio[i].name, error: e?.message || String(e) });
            }
        }
        items.push({ ...audio[i], tags, embeddedChapters });
    }
    onProgress?.({ done: audio.length, total: audio.length });

    // The book (4.8.0): the first EPUB in the selection, staged in the cache
    // and parsed now so the form can show which part each chapter reads.
    let staged = null;
    if (bookFiles.length) {
        onProgress?.({ done: audio.length, total: audio.length, note: 'Reading the book…' });
        try {
            staged = await stageBook(bookFiles[0]);
        } catch (e) {
            log('SERVICE', 'Import: book unreadable', { name: bookFiles[0].name, error: e?.message || String(e) });
        }
    }

    // A .nfo describes the book; a .txt only counts when it does too.
    let nfo = null;
    const byPreference = texts.slice().sort((a, b) =>
        (/\.nfo$/i.test(b.name) ? 1 : 0) - (/\.nfo$/i.test(a.name) ? 1 : 0));
    for (const t of byPreference) {
        try {
            const parsed = parseNfo(await Native.readText(t.uri));
            if (parsed.title || parsed.author || parsed.description) { nfo = parsed; break; }
        } catch (e) {
            log('SERVICE', 'Import: sidecar unreadable', { name: t.name, error: e?.message || String(e) });
        }
    }

    // `context` (Add files): the collection's title and its chapters' file
    // names, so a single new file is named like its siblings were.
    const draft = buildDraft({ items, nfo, folderName, context, book: staged?.book || null });
    draft.cover = pickCoverCandidate(images, draft.chapters);
    draft.images = images;

    // Embedded markers ride along on the chapter they belong to; the split
    // list is what the form shows by default when any file has them.
    const byUri = new Map(items.map(it => [it.uri, it]));
    draft.chapters = draft.chapters.map(ch => ({ ...ch, embeddedChapters: byUri.get(ch.uri)?.embeddedChapters || null }));
    draft.wholeChapters = draft.chapters;
    draft.hasEmbedded = draft.chapters.some(ch => ch.embeddedChapters);
    draft.splitChapters = draft.hasEmbedded ? expandEmbedded(draft.chapters) : draft.chapters;
    if (draft.hasEmbedded) draft.chapters = draft.splitChapters;

    draft.book = staged?.book || null;
    draft.bookUri = staged?.uri || null;
    draft.bookName = staged?.name || null;
    draft.bookRanges = draft.book ? autoMapChapters(draft.chapters, draft.book) : null;

    log('SERVICE', 'Import: analysed', {
        files: audio.length, images: images.length, nfo: !!nfo, title: draft.title, author: draft.author,
        book: draft.book ? draft.book.title : null, embedded: draft.hasEmbedded ? draft.splitChapters.length : 0,
    });
    return draft;
};

/**
 * Materialise a cover source (`{type: 'embedded' | 'image', uri}`) as a
 * bounded JPEG in the cache, for the editor's preview. Returns its file://
 * URI, or null when the source has no usable picture. importCollection /
 * saveCollectionEdits move it into the collection's folder.
 */
export const prepareCover = async (source) => {
    if (!source?.uri) return null;
    const dest = new File(ensure(coverCache()), `cover_${Date.now().toString(36)}.jpg`);
    const ok = source.type === 'embedded'
        ? await Native.saveEmbeddedCover(source.uri, dest.uri, COVER_MAX_PX)
        : await Native.saveImage(source.uri, dest.uri, COVER_MAX_PX);
    return ok ? dest.uri : null;
};

// ─── Import ─────────────────────────────────────────────────────────────────

let _jobSeq = 0;
const withProgress = (onFraction, run) => {
    const jobId = `imp${++_jobSeq}`;
    const sub = emitter?.addListener(PROGRESS_EVENT, (e) => {
        if (e?.jobId !== jobId || !onFraction) return;
        onFraction(e.total > 0 ? Math.min(1, e.copied / e.total) : 0);
    });
    return run(jobId).finally(() => sub?.remove());
};
const copyWithProgress = (srcUri, destFile, onFraction) =>
    withProgress(onFraction, (jobId) => Native.copyToFile(srcUri, destFile.uri, jobId));
/** One source file → its chapter files (AudioImport.splitAudio); `specs` = [{startMs, endMs, name}]. */
const splitWithProgress = (srcUri, dir, specs, onFraction) =>
    withProgress(onFraction, (jobId) => Native.splitAudio(srcUri, dir.uri, specs, jobId));

/** Move a prepared cover into the collection folder; '' when there is none. */
const placeCover = (dir, coverUri) => {
    if (!coverUri) return '';
    const dest = new File(dir, `cover_${Date.now().toString(36)}.jpg`);
    const src = new File(coverUri);
    if (src.uri === dest.uri) return dest.uri;
    src.move(dest);
    return dest.uri;
};

/**
 * Copy `chapters` into `dir` one by one and insert each row as soon as its
 * file is complete, so an interrupted import leaves a usable partial
 * collection rather than files without rows. Track numbers continue from
 * `startTrack`; release_date counts *down* from `baseMs` so chapter 1 is the
 * "newest" and comes first in every release-date-sorted list.
 */
const copyChapters = async (feedUrl, dir, { title, chapters, book = null, ranges = null }, { startTrack, baseMs, onProgress }) => {
    const total = chapters.length;
    const synced = [];
    const fileName = (track, ch, ext) => `${String(track).padStart(3, '0')}-${safeFileName(stripExtension(ch.name))}${ext}`;
    // The row, then — when the collection has its book and this chapter a
    // part of it — the book's words as the chapter's transcript.
    const insertRow = async (i, ch, destUri, durationSec) => {
        const track = startTrack + i + 1;
        const id = `${feedUrl}/${String(track).padStart(4, '0')}-${baseMs.toString(36)}`;
        await insertLocalEpisodes([{
            id,
            title: (ch.title || '').trim() || `Track ${track}`,
            description: '',
            podcast_title: title,
            podcast_feed_url: feedUrl,
            release_date: new Date(baseMs - i * 1000).toISOString(),
            local_audio_path: destUri,
            duration: durationSec || 0,
            track_number: track,
        }]);
        const range = book && ranges ? ranges[i] : null;
        if (range) {
            onProgress?.({ index: i, total, fileFraction: 1, overall: (i + 1) / total, title: ch.title, phase: 'text' });
            try {
                const { misfit } = await applyBookText({ id, duration: durationSec || 0 }, book, range);
                // The text is there to read at once, at a guessed pace; the
                // narrator's own timing follows in the background, chapter by
                // chapter (bookService.queueVoiceSync). A chapter whose text
                // cannot be what it reads is left out of that — there is
                // nothing to match it to.
                if (!misfit) {
                    synced.push({ id, local_audio_path: destUri, book_range: JSON.stringify(range), podcast_feed_url: feedUrl, duration: durationSec || 0 });
                } else {
                    log('SERVICE', 'Import: text does not fit this chapter', { id, wpm: misfit });
                }
            } catch (e) {
                log('SERVICE', 'Import: book text not applied', { id, error: e?.message || String(e) });
            }
        }
    };

    let i = 0;
    while (i < total) {
        const ch = chapters[i];
        if (ch.clip) {
            // Consecutive markers of one source file: a single native pass
            // writes every chapter file, then the rows follow in order.
            let j = i;
            while (j < total && chapters[j].clip && chapters[j].uri === ch.uri) j++;
            const group = chapters.slice(i, j);
            const specs = group.map((c, k) => ({
                startMs: c.clip.startMs, endMs: c.clip.endMs, name: fileName(startTrack + i + k + 1, c, '.m4a'),
            }));
            const at = i;
            const report = (f) => onProgress?.({
                index: at, total, fileFraction: f, overall: (at + f * group.length) / total, title: ch.sourceName || ch.title, phase: 'split',
            });
            report(0);
            const results = await splitWithProgress(ch.uri, dir, specs, report);
            const byIndex = new Map((results || []).map(r => [r.index, r]));
            for (let k = 0; k < group.length; k++) {
                const r = byIndex.get(k);
                if (!r) continue; // a marker with no audio in it
                const dest = new File(dir, specs[k].name);
                await insertRow(i + k, group[k], dest.uri, Math.round((r.durationMs || 0) / 1000) || group[k].durationSec || 0);
            }
            i = j;
            continue;
        }
        const track = startTrack + i + 1;
        const dest = new File(dir, fileName(track, ch, extOf(ch.name)));
        try { if (dest.exists) dest.delete(); } catch (_) {}
        const at = i;
        const report = (f) => onProgress?.({ index: at, total, fileFraction: f, overall: (at + f) / total, title: ch.title, phase: 'copy' });
        report(0);
        await copyWithProgress(ch.uri, dest, report);
        await insertRow(i, ch, dest.uri, ch.durationSec || 0);
        report(1);
        i++;
    }
    // Only the chapters about to be read. Matching costs roughly a twelfth of
    // the playing time, so a fifteen-hour book would decode for an hour if it
    // all went in at once; the rest is matched as each chapter is opened
    // (PlayerScreen), or in one go from the collection's Match all.
    if (synced.length) queueVoiceSync(synced.slice(0, PREMATCH_CHAPTERS));
};

/**
 * Create the collection from an edited draft: `{ title, author, description,
 * coverUri (from prepareCover, or null), chapters: [{uri, name, title,
 * durationSec}] }`. onProgress({index, total, fileFraction, overall, title}).
 * Resolves with the new feed_url; on failure the rows and files that made it
 * stay (deletable from My Podcasts) and the error propagates.
 */
export const importCollection = async (draft, { onProgress } = {}) => {
    const id = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const feedUrl = `local://${id}`;
    const title = (draft.title || '').trim() || 'Imported audio';
    const dir = ensure(collectionDir(feedUrl));
    log('UI', 'Import collection', { id, title, chapters: draft.chapters.length });

    const imageUrl = placeCover(dir, draft.coverUri);
    await saveLocalCollection({
        feed_url: feedUrl,
        title,
        author: (draft.author || '').trim(),
        description: draft.description || '',
        image_url: imageUrl,
    });
    // The book first, so every chapter row can take its text as it lands.
    let book = null;
    if (draft.bookUri && draft.book) {
        try {
            await attachBook(feedUrl, draft.bookUri, draft.book);
            book = draft.book;
        } catch (e) {
            log('UI', 'Import: book not attached', { id, error: e?.message || String(e) });
        }
    }
    // The list can show the new (empty) collection while files stream in.
    notifyLibraryChange({ type: 'subscribe' });
    try {
        await copyChapters(feedUrl, dir, { title, chapters: draft.chapters, book, ranges: book ? draft.bookRanges : null }, {
            startTrack: 0, baseMs: Date.now(), onProgress,
        });
    } finally {
        notifyLibraryChange({ type: 'subscribe' });
    }
    log('UI', 'Import complete', { id, chapters: draft.chapters.length, book: !!book });
    return feedUrl;
};

/** Add more files to an existing collection (same draft shape, chapters
 *  appended after the last track). A cover is taken only if it had none. */
export const appendToCollection = async (feedUrl, draft, { onProgress } = {}) => {
    const podcast = await getPodcastByFeedUrl(feedUrl);
    if (!podcast) throw new Error('Collection not found');
    const dir = ensure(collectionDir(feedUrl));
    const startTrack = await getMaxTrackNumber(feedUrl);
    const existing = await getEpisodesForCollection(feedUrl);
    const oldest = existing.reduce((m, e) => {
        const t = Date.parse(e.release_date);
        return Number.isFinite(t) && t < m ? t : m;
    }, Date.now());
    log('UI', 'Append to collection', { feedUrl, adding: draft.chapters.length, startTrack });
    if (!podcast.image_url && draft.coverUri) {
        await updateCollection(feedUrl, { image_url: placeCover(dir, draft.coverUri) });
    }
    // New files can read parts of the collection's book the editor mapped.
    const book = draft.bookRanges ? await loadBook(feedUrl) : null;
    try {
        await copyChapters(feedUrl, dir, { title: podcast.title, chapters: draft.chapters, book, ranges: book ? draft.bookRanges : null }, {
            startTrack, baseMs: oldest - 1000, onProgress,
        });
    } finally {
        notifyLibraryChange({ type: 'subscribe' });
    }
};

// ─── Edit / delete ──────────────────────────────────────────────────────────

/**
 * Save the editor: title / author / description, the cover (`coverUri` is
 * the current image_url to keep it, a prepareCover file to replace it, or
 * null to remove it), renamed chapters (`[{id, title}]`) and, since 4.8.0,
 * the book: `bookUri` + `book` attach a newly staged EPUB, `bookRanges`
 * (one per chapter, from the editor) rewrite the chapters whose part of
 * the book changed. onProgress({index, total, title, phase: 'text'}).
 */
export const saveCollectionEdits = async (feedUrl, { title, author, description, coverUri, chapters, book = null, bookUri = null, bookRanges = null, onProgress }) => {
    const podcast = await getPodcastByFeedUrl(feedUrl);
    if (!podcast) throw new Error('Collection not found');
    const fields = {
        title: (title || '').trim() || podcast.title,
        author: (author || '').trim(),
        description: description || '',
    };
    const current = podcast.image_url || '';
    if ((coverUri || '') !== current) {
        fields.image_url = coverUri ? placeCover(ensure(collectionDir(feedUrl)), coverUri) : '';
        if (current) removeFileQuietly(current);
    }
    await updateCollection(feedUrl, fields);
    for (const ch of chapters || []) {
        const t = (ch.title || '').trim();
        if (ch.id && t && t !== ch.originalTitle) await updateEpisodeTitle(ch.id, t);
    }
    let attached = false;
    if (bookUri && book) {
        await attachBook(feedUrl, bookUri, book);
        attached = true;
    }
    if (book && bookRanges) {
        const list = chapters || [];
        const retimed = [];
        for (let i = 0; i < list.length; i++) {
            const ch = list[i];
            if (!ch.id) continue;
            const range = bookRanges[i] || null;
            const before = parseRange(ch.originalRange);
            const changed = attached || JSON.stringify(range) !== JSON.stringify(before);
            if (!changed) continue;
            onProgress?.({ index: i, total: list.length, title: ch.title, phase: 'text' });
            const applied = await applyBookText(
                { id: ch.id, duration: ch.durationSec || 0, transcript_source: ch.transcriptSource }, book, range,
            );
            if (range && ch.localPath && !applied.misfit) {
                retimed.push({ id: ch.id, local_audio_path: ch.localPath, book_range: JSON.stringify(range), podcast_feed_url: feedUrl, duration: ch.durationSec || 0 });
            }
        }
        if (retimed.length) queueVoiceSync(retimed);
    }
    log('UI', 'Collection edited', { feedUrl, title: fields.title, coverChanged: fields.image_url !== undefined, book: attached });
    notifyLibraryChange({ type: 'subscribe' });
};

/** Delete a collection: its rows, its files, and the player if it is playing
 *  one of its chapters. */
export const deleteCollection = async (feedUrl) => {
    forgetBookCache(feedUrl);
    const episodes = await getEpisodesForCollection(feedUrl);
    const ids = new Set(episodes.map(e => e.id));
    for (const id of ids) forgetTranscription(id);
    try {
        const track = await TrackPlayer.getActiveTrack();
        if (track && ids.has(track.id)) {
            const { position, duration } = await TrackPlayer.getProgress();
            await persistProgress(track.id, position, duration);
            await TrackPlayer.reset();
            notifyUserStop();
        }
    } catch (_) {}
    await deletePodcast(feedUrl);
    try {
        const d = collectionDir(feedUrl);
        if (d.exists) d.delete();
    } catch (e) {
        log('UI', 'Collection folder not removed', { feedUrl, error: e?.message || String(e) });
    }
    log('UI', 'Collection deleted', { feedUrl, chapters: ids.size });
    notifyLibraryChange({ type: 'unsubscribe' });
};

/** Free space used by the collection's files (bytes), for the header. */
export const collectionSize = (feedUrl) => {
    try {
        const d = collectionDir(feedUrl);
        if (!d.exists) return 0;
        return d.list().reduce((s, f) => s + (f instanceof File ? (f.size || 0) : 0), 0);
    } catch (_) {
        return 0;
    }
};
