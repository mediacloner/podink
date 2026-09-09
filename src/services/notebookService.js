/**
 * notebookService — the notebook (4.5.0): sentences kept from a transcript,
 * each with a note in the listener's own words. VocabWords keeps words; this
 * keeps ideas. Pure DB module over the `Notebook` table (schema v10).
 *
 * A sentence is the chunk the Player shows, identified by its episode and
 * its first word's time, so saving the same sentence again reopens the
 * existing entry instead of duplicating it.
 */
import { openDatabaseContext } from '../database/db';

const now = () => new Date().toISOString();

/** Upsert by (episode_id, start_ms); returns the row (existing note kept). */
export const saveNotebookEntry = async ({
    episode_id, episode_title, podcast_title, sentence, translation, start_ms,
}) => {
    const db = await openDatabaseContext();
    const ts = now();
    await db.runAsync(
        `INSERT INTO Notebook (episode_id, episode_title, podcast_title, sentence, translation, note, start_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)
         ON CONFLICT(episode_id, start_ms) DO UPDATE SET
            sentence = excluded.sentence,
            episode_title = COALESCE(excluded.episode_title, Notebook.episode_title),
            podcast_title = COALESCE(excluded.podcast_title, Notebook.podcast_title),
            translation = COALESCE(excluded.translation, Notebook.translation)`,
        [
            episode_id ?? null,
            episode_title ?? null,
            podcast_title ?? null,
            String(sentence ?? '').trim(),
            translation || null,
            Math.round(start_ms ?? 0),
            ts,
            ts,
        ]
    );
    return getNotebookEntry(episode_id, start_ms);
};

export const getNotebookEntry = async (episode_id, start_ms) => {
    const db = await openDatabaseContext();
    const row = await db.getFirstAsync(
        'SELECT * FROM Notebook WHERE episode_id IS ? AND start_ms = ? LIMIT 1',
        [episode_id ?? null, Math.round(start_ms ?? 0)]
    );
    return row ?? null;
};

export const updateNotebookNote = async (id, note) => {
    const db = await openDatabaseContext();
    await db.runAsync(
        'UPDATE Notebook SET note = ?, updated_at = ? WHERE id = ?',
        [String(note ?? ''), now(), id]
    );
};

/** Fills in the translation once it arrives; never overwrites one already kept. */
export const updateNotebookTranslation = async (id, translation) => {
    const t = String(translation ?? '').trim();
    if (!t) return;
    const db = await openDatabaseContext();
    await db.runAsync(
        `UPDATE Notebook SET translation = ? WHERE id = ? AND (translation IS NULL OR translation = '')`,
        [t, id]
    );
};

export const removeNotebookEntry = async (id) => {
    const db = await openDatabaseContext();
    await db.runAsync('DELETE FROM Notebook WHERE id = ?', [id]);
};

/** Every entry, newest first (the screen regroups them by episode). */
export const getNotebookEntries = async () => {
    const db = await openDatabaseContext();
    return db.getAllAsync('SELECT * FROM Notebook ORDER BY created_at DESC, id DESC');
};

export const getNotebookCount = async () => {
    const db = await openDatabaseContext();
    const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM Notebook');
    return row?.n ?? 0;
};

// ─── Grouping + export ───────────────────────────────────────────────────────

/**
 * Entries grouped by episode, the episode with the newest entry first and,
 * inside an episode, in the order they were said — so an episode's notes
 * read like a summary of it. Entries whose episode is unknown share a group.
 */
export const groupNotebookByEpisode = (entries) => {
    const groups = new Map();
    for (const e of entries) {
        const key = e.episode_id ?? '∅';
        let g = groups.get(key);
        if (!g) {
            g = {
                key,
                episode_id: e.episode_id ?? null,
                episode_title: e.episode_title || 'Unknown episode',
                podcast_title: e.podcast_title || '',
                latest: e.created_at || '',
                entries: [],
            };
            groups.set(key, g);
        }
        g.entries.push(e);
        if ((e.created_at || '') > g.latest) g.latest = e.created_at || '';
    }
    const out = [...groups.values()];
    for (const g of out) g.entries.sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
    out.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
    return out;
};

export const formatNotebookTime = (ms) => {
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

/**
 * Plain text for the share sheet: one block per episode, each sentence as a
 * timed quote with the note under it — for a notes app, a study sheet, or an
 * assistant asked to turn the notes into a summary.
 */
export const buildNotebookExport = (entries) => {
    const groups = groupNotebookByEpisode(entries);
    const blocks = groups.map((g) => {
        const head = g.podcast_title ? `${g.podcast_title} — ${g.episode_title}` : g.episode_title;
        const lines = g.entries.map((e) => {
            const quote = `[${formatNotebookTime(e.start_ms)}] “${e.sentence}”`;
            const note = (e.note || '').trim();
            return note ? `${quote}\n    ${note.replace(/\n/g, '\n    ')}` : quote;
        });
        return `${head}\n${'─'.repeat(Math.min(head.length, 40))}\n${lines.join('\n\n')}`;
    });
    return blocks.join('\n\n\n');
};
