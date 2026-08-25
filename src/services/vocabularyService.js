/**
 * vocabularyService — pure DB module for saved vocabulary words, lookup
 * history and full-text transcript search (FTS5 with a LIKE fallback for
 * databases where the v2 migration has not produced TranscriptsFTS).
 */
import { openDatabaseContext } from '../database/db';

export const addVocabWord = async ({
    word,
    normalized,
    translation,
    definition,
    language,
    episode_id,
    episode_title,
    context_text,
    word_start_ms,
}) => {
    const db = await openDatabaseContext();
    await db.runAsync(
        `INSERT INTO VocabWords (word, normalized, translation, definition, language, episode_id, episode_title, context_text, word_start_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(normalized) DO UPDATE SET
            word = excluded.word,
            translation = COALESCE(excluded.translation, VocabWords.translation),
            definition = COALESCE(excluded.definition, VocabWords.definition),
            language = COALESCE(excluded.language, VocabWords.language),
            episode_id = COALESCE(excluded.episode_id, VocabWords.episode_id),
            episode_title = COALESCE(excluded.episode_title, VocabWords.episode_title),
            context_text = COALESCE(excluded.context_text, VocabWords.context_text),
            word_start_ms = COALESCE(excluded.word_start_ms, VocabWords.word_start_ms),
            lookup_count = VocabWords.lookup_count + 1`,
        [
            word,
            normalized,
            translation ?? null,
            definition ?? null,
            language ?? null,
            episode_id ?? null,
            episode_title ?? null,
            context_text ?? null,
            word_start_ms ?? null,
            new Date().toISOString(),
        ]
    );
    const row = await db.getFirstAsync(
        'SELECT id FROM VocabWords WHERE normalized = ?',
        [normalized]
    );
    return row?.id ?? null;
};

export const getVocabWords = async () => {
    const db = await openDatabaseContext();
    return db.getAllAsync('SELECT * FROM VocabWords ORDER BY created_at DESC, id DESC');
};

export const removeVocabWord = async (id) => {
    const db = await openDatabaseContext();
    await db.runAsync('DELETE FROM VocabWords WHERE id = ?', [id]);
};

export const isVocabWordSaved = async (normalized) => {
    const db = await openDatabaseContext();
    const row = await db.getFirstAsync(
        'SELECT 1 AS found FROM VocabWords WHERE normalized = ? LIMIT 1',
        [normalized]
    );
    return !!row;
};

export const recordLookup = async (word, normalized, episode_id) => {
    const db = await openDatabaseContext();
    await db.runAsync(
        `INSERT INTO LookupHistory (word, normalized, episode_id, looked_up_at)
         VALUES (?, ?, ?, ?)`,
        [word, normalized, episode_id ?? null, new Date().toISOString()]
    );
};

const tokenize = (query) => String(query ?? '').trim().split(/\s+/).filter(Boolean);

// Quote every token (neutralizes FTS5 operators); prefix-match the last one.
const toFtsMatch = (tokens) => tokens
    .map((t, i) => {
        const safe = t.replace(/"/g, '');
        if (!safe) return null;
        return i === tokens.length - 1 ? `"${safe}"*` : `"${safe}"`;
    })
    .filter(Boolean)
    .join(' ');

const buildExcerpt = (text, token) => {
    const idx = text.toLowerCase().indexOf(token.toLowerCase());
    if (idx < 0) return text.slice(0, 120) + (text.length > 120 ? '…' : '');
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + token.length + 80);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
};

const searchTranscriptsLike = async (db, tokens, limit) => {
    const where = tokens.map(() => `t.text LIKE ? ESCAPE '\\'`).join(' AND ');
    const params = tokens.map(t => `%${t.replace(/([\\%_])/g, '\\$1')}%`);
    const rows = await db.getAllAsync(
        `SELECT t.episode_id, COALESCE(e.title, '') AS episode_title, t.text, t.start_time
         FROM Transcripts t
         LEFT JOIN Episodes e ON e.id = t.episode_id
         WHERE ${where}
         ORDER BY t.episode_id, t.start_time
         LIMIT ?`,
        [...params, limit]
    );
    return rows.map(r => ({
        episode_id: r.episode_id,
        episode_title: r.episode_title,
        snippet: buildExcerpt(r.text || '', tokens[0]),
        start_time: r.start_time,
    }));
};

export const searchTranscripts = async (query, limit = 50) => {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const db = await openDatabaseContext();

    const match = toFtsMatch(tokens);
    if (match) {
        try {
            return await db.getAllAsync(
                `SELECT t.episode_id,
                        COALESCE(e.title, '') AS episode_title,
                        snippet(TranscriptsFTS, 0, '', '', '…', 14) AS snippet,
                        t.start_time
                 FROM TranscriptsFTS
                 JOIN Transcripts t ON t.id = TranscriptsFTS.rowid
                 LEFT JOIN Episodes e ON e.id = t.episode_id
                 WHERE TranscriptsFTS MATCH ?
                 ORDER BY TranscriptsFTS.rank
                 LIMIT ?`,
                [match, limit]
            );
        } catch (e) {
            console.warn('[vocabularyService] FTS search failed, falling back to LIKE:', e?.message);
        }
    }
    return searchTranscriptsLike(db, tokens, limit);
};
