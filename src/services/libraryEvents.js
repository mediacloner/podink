/**
 * libraryEvents — pub-sub fired whenever an action in any tab mutates the
 * Library (downloads, deletes, transcript add/remove, episode metadata
 * updates). DownloadedTimeline subscribes and reloads on every event.
 *
 * notifyLibraryChange(payload?) — payload is undefined (legacy callers) or
 * { type, episodeId?, percent? } with type one of:
 * 'download-complete' | 'episode-delete' | 'transcript-progress' |
 * 'transcript-complete' | 'transcript-error' | 'transcript-delete' |
 * 'subscribe' | 'unsubscribe' | 'playback-complete' | 'playback-progress' |
 * 'playback-reset' (an episode marked not-played again from Listening).
 * Subscribers must tolerate an undefined payload.
 *
 * 'playback-progress' fires on every persisted play position (~5s while
 * something plays). Like 'transcript-progress' it is a high-frequency tick —
 * list screens should skip their full reload for it unless they show
 * progress (the Listening tab does).
 */
const _listeners = new Set();

export const onLibraryChange = (fn) => {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
};

export const notifyLibraryChange = (payload) => {
    [..._listeners].forEach(fn => {
        try { fn(payload); } catch (_) {}
    });
};
