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
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { Directory, File, Paths } from 'expo-file-system';
import { buildDraft, parseNfo, pickCoverCandidate, stripExtension } from './importMeta';
import {
    deletePodcast, getEpisodesForCollection, getMaxTrackNumber, getPodcastByFeedUrl,
    insertLocalEpisodes, saveLocalCollection, updateCollection, updateEpisodeTitle,
} from '../database/queries';
import { dequeueTranscription } from './whisperService';
import { notifyUserStop } from './trackPlayer';
import { persistProgress } from './playbackService';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

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
    if (!audio.length) {
        const err = new Error('No audio files in the selection');
        err.code = 'NO_AUDIO';
        throw err;
    }
    clearCoverCache();

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
        items.push({ ...audio[i], tags });
    }
    onProgress?.({ done: audio.length, total: audio.length });

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
    const draft = buildDraft({ items, nfo, folderName, context });
    draft.cover = pickCoverCandidate(images, draft.chapters);
    draft.images = images;
    log('SERVICE', 'Import: analysed', {
        files: audio.length, images: images.length, nfo: !!nfo, title: draft.title, author: draft.author,
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
const copyWithProgress = (srcUri, destFile, onFraction) => {
    const jobId = `imp${++_jobSeq}`;
    const sub = emitter?.addListener(PROGRESS_EVENT, (e) => {
        if (e?.jobId !== jobId || !onFraction) return;
        onFraction(e.total > 0 ? Math.min(1, e.copied / e.total) : 0);
    });
    return Native.copyToFile(srcUri, destFile.uri, jobId).finally(() => sub?.remove());
};

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
const copyChapters = async (feedUrl, dir, { title, chapters }, { startTrack, baseMs, onProgress }) => {
    const total = chapters.length;
    for (let i = 0; i < total; i++) {
        const ch = chapters[i];
        const track = startTrack + i + 1;
        const dest = new File(dir, `${String(track).padStart(3, '0')}-${safeFileName(stripExtension(ch.name))}${extOf(ch.name)}`);
        try { if (dest.exists) dest.delete(); } catch (_) {}
        const report = (f) => onProgress?.({ index: i, total, fileFraction: f, overall: (i + f) / total, title: ch.title });
        report(0);
        await copyWithProgress(ch.uri, dest, report);
        await insertLocalEpisodes([{
            id: `${feedUrl}/${String(track).padStart(4, '0')}-${baseMs.toString(36)}`,
            title: (ch.title || '').trim() || `Track ${track}`,
            description: '',
            podcast_title: title,
            podcast_feed_url: feedUrl,
            release_date: new Date(baseMs - i * 1000).toISOString(),
            local_audio_path: dest.uri,
            duration: ch.durationSec || 0,
            track_number: track,
        }]);
        report(1);
    }
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
    // The list can show the new (empty) collection while files stream in.
    notifyLibraryChange({ type: 'subscribe' });
    try {
        await copyChapters(feedUrl, dir, { title, chapters: draft.chapters }, {
            startTrack: 0, baseMs: Date.now(), onProgress,
        });
    } finally {
        notifyLibraryChange({ type: 'subscribe' });
    }
    log('UI', 'Import complete', { id, chapters: draft.chapters.length });
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
    try {
        await copyChapters(feedUrl, dir, { title: podcast.title, chapters: draft.chapters }, {
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
 * null to remove it) and renamed chapters (`[{id, title}]`).
 */
export const saveCollectionEdits = async (feedUrl, { title, author, description, coverUri, chapters }) => {
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
    log('UI', 'Collection edited', { feedUrl, title: fields.title, coverChanged: fields.image_url !== undefined });
    notifyLibraryChange({ type: 'subscribe' });
};

/** Delete a collection: its rows, its files, and the player if it is playing
 *  one of its chapters. */
export const deleteCollection = async (feedUrl) => {
    const episodes = await getEpisodesForCollection(feedUrl);
    const ids = new Set(episodes.map(e => e.id));
    for (const id of ids) dequeueTranscription(id);
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
