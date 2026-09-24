/**
 * Which episodes are being enriched: the work that follows a finished
 * transcript on its own — the punctuation repair, the summary, chapters and
 * corrections, the names and books, the tag pass — until the last of it is
 * done. The episode row shows "Enriching…" meanwhile (components/EpisodeItem.js;
 * user: "a new state of button … something like enrichment podcast until
 * finish"). In memory only: after a restart nothing is running.
 */
const _active = new Set();
const _listeners = new Set();

const emit = (episodeId) => {
    for (const fn of _listeners) { try { fn(episodeId); } catch (_) {} }
};

export const isEnriching = (episodeId) => _active.has(String(episodeId));

/** Marks the episode while `work` runs; resolves or rejects as `work` does. */
export const whileEnriching = async (episodeId, work) => {
    const id = String(episodeId);
    _active.add(id);
    emit(id);
    try {
        return await work();
    } finally {
        _active.delete(id);
        emit(id);
    }
};

/** `fn(episodeId)` on every start and end. Returns the unsubscribe. */
export const onEnrichmentChange = (fn) => {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
};
