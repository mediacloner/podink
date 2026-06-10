/**
 * libraryEvents — pub-sub fired whenever an action in any tab mutates the
 * Library (downloads, deletes, transcript add/remove, episode metadata
 * updates). DownloadedTimeline subscribes and reloads on every event.
 *
 * Whisper-queue changes are already broadcast via whisperService.onQueueChange
 * — this hook covers the gap where downloads happen with no queue activity.
 */
const _listeners = new Set();

export const onLibraryChange = (fn) => {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
};

export const notifyLibraryChange = () => {
    [..._listeners].forEach(fn => {
        try { fn(); } catch (_) {}
    });
};
