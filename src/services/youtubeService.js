/**
 * youtubeService — a YouTube video as an episode (4.1.0).
 *
 * Paste (or share) a link; the app reads the video page on the device with
 * NewPipe Extractor (android/…/YouTubeModule.kt), downloads the best audio-only
 * stream — the original-language track, M4A (AAC) before WebM (Opus) — into
 *
 *   Paths.document/youtube/<videoId>.m4a
 *
 * and files it as an episode of the channel:
 *
 *   Podcasts   kind 'youtube', feed_url `youtube://channel/<channelId>`,
 *              title / avatar / author = the channel (upserted per import)
 *   Episodes   id `youtube://<videoId>`, audio_url = the watch page (nothing
 *              streams it — like an imported chapter, the file is the
 *              episode), release_date = the import moment (so it tops the
 *              Feed; the upload date is in the notes), is_downloaded 1,
 *              is_new 0, then the usual automatic transcription.
 *
 * The row behaves like a podcast episode everywhere it is listed (Feed, the
 * My Podcasts accordion, Library, every Listening segment) and like imported
 * audio where the download axis matters (episodeService.isImportedEpisode:
 * delete = gone for good, no weekly sweep, no end-of-episode prompt).
 *
 * One import runs at a time; its state lives here (getYouTubeImport /
 * useYouTubeImport) so the import screen can be left and re-opened, and a
 * share that arrives while one runs is refused with code 'BUSY'.
 * Android only — isYouTubeImportSupported() gates the UI.
 */
import { useEffect, useState } from 'react';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Directory, File, Paths } from 'expo-file-system';
import { getEpisodeById, insertYouTubeEpisode, saveYouTubeChannel } from '../database/queries';
import { reportTranscriptionError, transcribeEpisode } from './episodeService';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

const Native = Platform.OS === 'android' ? NativeModules.YouTube : null;
const emitter = Native ? new NativeEventEmitter(Native) : null;
const PROGRESS_EVENT = 'YouTubeDownloadProgress';

export const isYouTubeImportSupported = () => !!Native;

// ─── Links ──────────────────────────────────────────────────────────────────

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The first thing in `text` that looks like a web address ('' if none). */
const firstUrl = (text) => {
    const m = /(?:https?:\/\/|www\.|youtu\.be\/|youtube\.com\/|youtube-nocookie\.com\/)[^\s<>"']+/i.exec(String(text || ''));
    return m ? m[0] : '';
};

/**
 * The 11-character video id in a YouTube link, or null. Understands
 * youtube.com/watch?v=…, youtu.be/…, /shorts/…, /live/…, /embed/…, the
 * m. / music. / www. hosts and youtube-nocookie.com, with or without a
 * scheme, anywhere inside a shared message. (RN has no working URL parser —
 * `URL#searchParams` and `hostname` throw — hence the regexes.)
 */
export const parseYouTubeVideoId = (text) => {
    const raw = firstUrl(text);
    if (!raw) return null;
    const m = /^(?:https?:\/\/)?([^/?#]+)([^?#]*)(?:\?([^#]*))?/i.exec(raw);
    if (!m) return null;
    const host = m[1].toLowerCase().replace(/^(www|m|music)\./, '');
    const path = m[2] || '';
    const query = m[3] || '';
    let id = null;
    if (host === 'youtu.be') {
        id = path.split('/')[1] || null;
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        const v = /(?:^|&)v=([^&]+)/.exec(query);
        if (v) {
            try { id = decodeURIComponent(v[1]); } catch (_) { id = v[1]; }
        } else {
            const p = /^\/(?:shorts|live|embed|v)\/([^/]+)/.exec(path);
            if (p) id = p[1];
        }
    } else {
        return null;
    }
    return id && VIDEO_ID.test(id) ? id : null;
};

export const isYouTubeUrl = (text) => !!parseYouTubeVideoId(text);
export const watchUrlFor = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
export const episodeIdFor = (videoId) => `youtube://${videoId}`;

/** `youtube://channel/<UC… or @handle>` from the uploader's page URL. */
const channelFeedUrl = (video) => {
    const seg = String(video.uploaderUrl || '').replace(/\/+$/, '').split('/').pop();
    const key = seg && !/youtube\.com$/i.test(seg) ? seg : (video.uploaderName || 'unknown');
    return `youtube://channel/${key.replace(/[^\w@.\-]+/g, '_')}`;
};

// ─── Storage ────────────────────────────────────────────────────────────────

const youtubeDir = () => {
    const d = new Directory(Paths.document, 'youtube');
    if (!d.exists) d.create({ intermediates: true });
    return d;
};
const fileExists = (uri) => { try { return new File(uri).exists; } catch (_) { return false; } };
const fileSize = (uri) => { try { return new File(uri).size || 0; } catch (_) { return 0; } };

// ─── Show notes ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textToHtml = (t) => escapeHtml(t).trim().split(/\n{2,}/)
    .filter(Boolean).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const formatDate = (iso, textual) => {
    const d = iso ? new Date(iso) : null;
    if (d && !Number.isNaN(d.getTime())) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    return textual || '';
};
const formatCount = (n) => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(n);
};

/** The episode's notes: a first line with the link back to YouTube, the
 *  upload date and the view count, then the video's own description (HTML
 *  as YouTube sends it, plain text turned into paragraphs). */
const buildDescription = (video, watchUrl) => {
    const bits = [];
    const date = formatDate(video.uploadDate, video.textualUploadDate);
    if (date) bits.push(`Published ${date}`);
    if (video.viewCount > 0) bits.push(`${formatCount(video.viewCount)} views`);
    const head = `<p><a href="${watchUrl}">Watch on YouTube</a>${bits.length ? ` · ${escapeHtml(bits.join(' · '))}` : ''}</p>`;
    // Description.HTML = 1, MARKDOWN = 2, PLAIN_TEXT = 3 (NewPipe Extractor).
    const body = video.descriptionType === 1 ? (video.description || '') : textToHtml(video.description || '');
    return head + body;
};

// ─── Import state ───────────────────────────────────────────────────────────

/** The one import (null when none has run since launch, or after
 *  clearYouTubeImport):
 *  { videoId, url, stage: 'resolving' | 'downloading' | 'saving' | 'done' | 'error',
 *    progress 0-1, downloaded, total (bytes), video (resolved metadata),
 *    stream {format, bitrate, codec}, episode (the row, once saved),
 *    already (the video was in the library with its file), error {title, message} } */
let _job = null;
let _seq = 0;
const _listeners = new Set();
export const onYouTubeImportChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };
const _notify = () => {
    const snap = _job ? { ..._job } : null;
    [..._listeners].forEach(fn => { try { fn(snap); } catch (_) {} });
};
export const useYouTubeImport = () => {
    const [s, setS] = useState(_job ? { ..._job } : null);
    useEffect(() => onYouTubeImportChange(setS), []);
    return s;
};
export const getYouTubeImport = () => (_job ? { ..._job } : null);
const setJob = (patch) => { if (!_job) return; Object.assign(_job, patch); _notify(); };
const isActive = (j) => !!j && j.stage !== 'done' && j.stage !== 'error';
export const isYouTubeImportActive = () => isActive(_job);

const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };

/** Forget a finished or failed import (the screen's "Import another"). */
export const clearYouTubeImport = () => {
    if (_job && !isActive(_job)) { _job = null; _notify(); }
};

/** Abort the running download; the job is cleared (nothing was saved). */
export const cancelYouTubeImport = () => {
    if (!isActive(_job)) return;
    _job.cancelled = true;
    if (_job.jobId && Native) Native.cancel(_job.jobId);
    _notify();
};

// ─── Errors ─────────────────────────────────────────────────────────────────

/** { title, message } for the import screen; null for a cancel. */
export const describeYouTubeImportError = (e) => {
    const code = e?.code || '';
    if (code === 'CANCELLED') return null;
    const reason = String(e?.message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const withReason = (text) => (reason ? `${text}\n\nReason: ${reason}` : text);
    switch (code) {
        case 'NOT_YOUTUBE':
            return { title: 'Not a YouTube link', message: 'Paste a link to a YouTube video — youtube.com/watch?v=…, youtu.be/…, a Short or a live replay.' };
        case 'UNSUPPORTED':
            return { title: 'Not available', message: 'Importing from YouTube is only available on Android.' };
        case 'OFFLINE':
            return { title: 'Offline', message: 'You need an internet connection to import a video.' };
        case 'BUSY':
            return { title: 'Import in progress', message: 'Wait for the current video to finish, then try again.' };
        case 'LIVE':
            return { title: 'Live stream', message: 'Only finished videos can be imported. Come back once the stream has ended and YouTube has the replay.' };
        case 'AGE_RESTRICTED':
            return { title: 'Age-restricted video', message: 'YouTube only serves this video to a signed-in adult account, which Podink cannot provide.' };
        case 'PRIVATE':
            return { title: 'Private video', message: 'This video is private.' };
        case 'PAID':
            return { title: 'Paid content', message: 'This video needs a purchase or a channel membership.' };
        case 'GEO_BLOCKED':
            return { title: 'Not available here', message: 'YouTube blocks this video in your country.' };
        case 'NOT_AVAILABLE':
            return { title: 'Video not available', message: withReason('YouTube says this video is unavailable — removed, private, or the link is wrong.') };
        case 'RECAPTCHA':
            return { title: 'YouTube wants a CAPTCHA', message: 'YouTube is asking this connection to prove it is not a bot. Try again in a few minutes, or on another network.' };
        case 'NETWORK':
            return { title: 'Connection problem', message: withReason('YouTube could not be reached. Check the connection and try again.') };
        case 'NO_AUDIO':
            return { title: 'No audio stream', message: 'YouTube offered no audio-only stream for this video.' };
        case 'DOWNLOAD_FAILED':
            return { title: 'Download failed', message: withReason('The audio could not be saved.') };
        default:
            if (/^HTTP_/.test(code)) {
                return {
                    title: 'Download refused',
                    message: `YouTube's media server refused the audio (${code.replace('HTTP_', 'HTTP ')}). Try again; if it keeps happening, the built-in extractor needs an update.`,
                };
            }
            return {
                title: 'Could not read the video',
                message: withReason('YouTube changed something the built-in extractor does not understand yet; an app update will be needed.'),
            };
    }
};

// ─── Resolve + download ─────────────────────────────────────────────────────

/** Metadata and audio streams of a video, from the native extractor. */
export const resolveYouTubeVideo = async (url) => {
    if (!Native) throw fail('UNSUPPORTED', 'Importing from YouTube is only available on Android.');
    const info = await Native.resolve(url);
    return { ...info, audio: Array.isArray(info?.audio) ? info.audio : [] };
};

const downloadStream = (stream, dest, onProgress) => {
    const jobId = `yt${++_seq}`;
    setJob({ jobId });
    const sub = emitter.addListener(PROGRESS_EVENT, (e) => {
        if (e?.jobId === jobId) onProgress(e.downloaded || 0, e.total || 0);
    });
    return Native.download({
        jobId,
        url: stream.url,
        dest: dest.uri,
        contentLength: stream.contentLength > 0 ? stream.contentLength : null,
    }).finally(() => sub.remove());
};

/**
 * Try the streams best-first (at most three). A 4xx from the media server
 * usually means the URL expired or was tied to another client: the video is
 * resolved once more for fresh URLs and the attempts start over.
 */
const downloadAudio = async (video, videoId, dir) => {
    let candidates = video.audio;
    let reResolved = false;
    let lastErr = null;
    for (let i = 0; i < Math.min(candidates.length, 3); i++) {
        const stream = candidates[i];
        const ext = String(stream.format || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '') || 'm4a';
        const dest = new File(dir, `${videoId}.${ext}`);
        setJob({
            stage: 'downloading', progress: 0, downloaded: 0,
            total: stream.contentLength > 0 ? stream.contentLength : 0,
            stream: { format: ext, bitrate: stream.bitrate, codec: stream.codec, itag: stream.itag },
        });
        try {
            await downloadStream(stream, dest, (done, total) => {
                setJob({ downloaded: done, total, progress: total > 0 ? Math.min(1, done / total) : 0 });
            });
            return { uri: dest.uri, stream, ext };
        } catch (e) {
            if (e?.code === 'CANCELLED' || _job?.cancelled) throw fail('CANCELLED', 'Cancelled');
            lastErr = e;
            log('SERVICE', 'YouTube: stream download failed', {
                videoId, itag: stream.itag, format: ext, code: e?.code, error: e?.message || String(e),
            });
            if (/^HTTP_4/.test(e?.code || '') && !reResolved) {
                reResolved = true;
                try {
                    const fresh = await resolveYouTubeVideo(video.url || watchUrlFor(videoId));
                    if (fresh.audio.length) { candidates = fresh.audio; i = -1; continue; }
                } catch (e2) {
                    log('SERVICE', 'YouTube: re-resolve failed', { videoId, error: e2?.message || String(e2) });
                }
            }
        }
    }
    throw lastErr || fail('NO_AUDIO', 'No audio stream could be downloaded.');
};

/**
 * Import the video behind `input` (a link, or a message containing one).
 * Resolves with { episode, already } — `already` when the video was in the
 * library with its file, in which case nothing is fetched. Rejects with a
 * coded error (see describeYouTubeImportError); 'CANCELLED' is quiet.
 * State for the screen is in getYouTubeImport / useYouTubeImport.
 */
export const importYouTubeVideo = async (input) => {
    if (!Native) throw fail('UNSUPPORTED', 'Importing from YouTube is only available on Android.');
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) throw fail('NOT_YOUTUBE', 'That is not a link to a YouTube video.');
    if (isActive(_job)) throw fail('BUSY', 'Another video is still being imported.');
    try {
        const net = await NetInfo.fetch();
        if (net?.isConnected === false) throw fail('OFFLINE', 'Offline');
    } catch (e) {
        if (e?.code === 'OFFLINE') throw e; // a NetInfo failure itself must not block the import
    }

    const watchUrl = watchUrlFor(videoId);
    const episodeId = episodeIdFor(videoId);
    _job = {
        videoId, url: watchUrl, stage: 'resolving', progress: 0, downloaded: 0, total: 0,
        video: null, stream: null, episode: null, already: false, error: null, cancelled: false, jobId: null,
        startedAt: Date.now(),
    };
    _notify();
    log('UI', 'YouTube import', { videoId });

    try {
        const existing = await getEpisodeById(episodeId);
        if (existing?.local_audio_path && fileExists(existing.local_audio_path)) {
            log('UI', 'YouTube import: already in the library', { videoId });
            setJob({
                stage: 'done', episode: existing, already: true, progress: 1,
                video: { title: existing.title, uploaderName: existing.podcast_title, durationSec: existing.duration, thumbnail: '' },
            });
            return { episode: existing, already: true };
        }

        const video = await resolveYouTubeVideo(watchUrl);
        if (_job.cancelled) throw fail('CANCELLED', 'Cancelled');
        setJob({ video });
        log('SERVICE', 'YouTube: resolved', {
            videoId, title: video.title, channel: video.uploaderName, durationSec: video.durationSec,
            streams: video.audio.map(a => `${a.format} ${a.bitrate} ${a.trackType || 'ORIGINAL'}`),
        });
        if (!video.audio.length) throw fail('NO_AUDIO', 'YouTube offered no audio-only stream for this video.');

        const file = await downloadAudio(video, videoId, youtubeDir());
        setJob({ stage: 'saving', progress: 1 });

        const feedUrl = channelFeedUrl(video);
        const channelTitle = (video.uploaderName || '').trim() || 'YouTube';
        await saveYouTubeChannel({
            feed_url: feedUrl,
            title: channelTitle,
            description: `Videos imported from ${channelTitle} on YouTube — each one's audio, transcribed on this device.`,
            image_url: video.uploaderAvatar || '',
            author: channelTitle,
        });
        await insertYouTubeEpisode({
            id: episodeId,
            title: (video.title || '').trim() || 'YouTube video',
            description: buildDescription(video, watchUrl),
            podcast_title: channelTitle,
            podcast_feed_url: feedUrl,
            release_date: new Date().toISOString(),
            audio_url: watchUrl,
            local_audio_path: file.uri,
            duration: Math.round(video.durationSec || 0),
        });
        const episode = await getEpisodeById(episodeId);
        notifyLibraryChange({ type: 'subscribe' });
        notifyLibraryChange({ type: 'download-complete', episodeId });
        log('UI', 'YouTube import complete', {
            videoId, channel: channelTitle, format: file.ext, bitrate: file.stream.bitrate,
            mb: Math.round(fileSize(file.uri) / 1024 / 1024),
        });
        setJob({ stage: 'done', episode, already: false });
        // Like a podcast download: the transcription queues itself; its
        // progress shows in the Feed / Library rows and the import screen.
        transcribeEpisode(episode).catch(e => reportTranscriptionError(e, episode));
        return { episode, already: false };
    } catch (e) {
        const cancelled = e?.code === 'CANCELLED' || _job?.cancelled;
        log('UI', cancelled ? 'YouTube import cancelled' : 'YouTube import failed', {
            videoId, code: e?.code, error: e?.message || String(e),
        });
        if (cancelled) {
            _job = null;
            _notify();
            throw fail('CANCELLED', 'Cancelled');
        }
        setJob({ stage: 'error', error: describeYouTubeImportError(e) });
        throw e;
    }
};
