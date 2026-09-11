/**
 * The names pass: people the episode's own text spells right, written that
 * way into what the reader shows (services/nameText.js has the matching).
 *
 * Offline and quick — a few hundred milliseconds for an hour of speech — so
 * it runs in place: when a transcription finishes (before the book scan, which
 * then reads the corrected authors), when the Player opens an episode that
 * was never scanned, and at launch for every transcript from before this
 * existed. Corrections live in EpisodeNames and are applied on read by
 * `getCorrectedTranscript`; Transcripts keeps the recogniser's text.
 */
import {
    getEpisodeById, getEpisodeFixes, getEpisodeNames, getEpisodesNeedingNameScan, getTranscriptsForEpisode,
    replaceEpisodeNames,
} from '../database/queries';
import { applyNameCorrections, findNameCorrections, nameCandidates } from './nameText';
import { showNotesPlainText } from './showNotes';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

const _running = new Map();   // episodeId → Promise, so two callers share one scan

/** Transcript rows with the episode's name corrections written in, and
 *  after them the fixes the episode assistant proposed (EpisodeFixes,
 *  services/aiService.js) — the assistant read the text with the names
 *  already corrected, so its "heard" spellings are matched on that text. */
export const getCorrectedTranscript = async (episodeId) => {
    const [rows, names, fixes] = await Promise.all([
        getTranscriptsForEpisode(episodeId), getEpisodeNames(episodeId), getEpisodeFixes(episodeId),
    ]);
    const named = applyNameCorrections(rows, names);
    const applied = (fixes || []).filter(f => f.applied !== 0).map(f => ({ heard: f.heard, canonical: f.correct }));
    return applied.length ? applyNameCorrections(named, applied) : named;
};

/** The same rows with only the name corrections — what the assistant reads. */
export const getNameCorrectedTranscript = async (episodeId) => {
    const [rows, names] = await Promise.all([getTranscriptsForEpisode(episodeId), getEpisodeNames(episodeId)]);
    return applyNameCorrections(rows, names);
};

/**
 * Scans the episode's transcript for the names its title, notes and author
 * field carry, and stores the corrections. Resolves to the corrections, or
 * null when nothing was scanned (no transcript, or already scanned and not
 * `force`). Never throws.
 */
export const indexEpisodeNames = (episodeId, { force = false } = {}) => {
    const active = _running.get(episodeId);
    if (active) return active;
    const p = (async () => {
        try {
            const ep = await getEpisodeById(episodeId);
            if (!ep || (ep.names_indexed_at && !force)) return null;
            const rows = await getTranscriptsForEpisode(episodeId);
            if (!rows.length) return null;
            const cands = nameCandidates({
                title: ep.title || '', author: ep.podcast_author || '', notes: showNotesPlainText(ep.description || ''),
            });
            const t0 = Date.now();
            const names = cands.length ? findNameCorrections(rows, cands) : [];
            await replaceEpisodeNames(episodeId, names);
            log('SYSTEM', 'Name scan finished', {
                id: episodeId, title: ep.title, candidates: cands.map(c => c.canonical), ms: Date.now() - t0,
                corrections: names.map(n => `${n.heard} → ${n.canonical} ×${n.count}`).slice(0, 40),
            });
            try { notifyLibraryChange({ type: 'names-indexed', episodeId, count: names.length }); } catch (_) {}
            return names;
        } catch (e) {
            log('SYSTEM', 'Name scan failed', { id: episodeId, error: e?.message || String(e) });
            return null;
        } finally {
            _running.delete(episodeId);
        }
    })();
    _running.set(episodeId, p);
    return p;
};

/** Every transcribed episode never scanned for names, one after another. */
export const backfillNameIndex = async () => {
    try {
        const ids = await getEpisodesNeedingNameScan();
        if (!ids.length) return;
        log('SYSTEM', 'Name scan backlog', { episodes: ids.length });
        for (const id of ids) await indexEpisodeNames(id);
    } catch (e) {
        log('SYSTEM', 'Name scan backlog failed', { error: e?.message || String(e) });
    }
};
