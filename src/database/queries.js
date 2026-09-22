import { openDatabaseContext } from './db';

// expo-sqlite's withTransactionAsync has no mutex (it is just BEGIN/COMMIT on
// the shared connection), so two overlapping transactions cross-rollback each
// other ("cannot start a transaction within a transaction"). Serialize every
// write transaction through this module-level promise chain. The tail always
// advances to a non-rejecting promise so one failing txn can't poison the
// chain, while the caller still sees the real rejection via the returned `p`.
let _txTail = Promise.resolve();
const runInTxn = (db, task) => {
  const p = _txTail.then(() => db.withTransactionAsync(task));
  _txTail = p.catch(() => {});
  return p;
};

/** Podcasts.kind for an imported collection (audiobook / local audio files,
 *  3.5.0). Every other row is an RSS subscription ('rss'). */
export const LOCAL_KIND = 'local';
export const isLocalFeedUrl = (feedUrl) => typeof feedUrl === 'string' && feedUrl.startsWith('local://');

/** Podcasts.kind for a live radio station (4.0.0). Its "episodes" are
 *  listening sessions: one row per time the user tunes in, gone when the
 *  session ends or the app next starts. They never appear in the Feed,
 *  My Podcasts, Library or Listening — the Radio tab is their only home. */
export const RADIO_KIND = 'radio';
export const isRadioFeedUrl = (feedUrl) => typeof feedUrl === 'string' && feedUrl.startsWith('radio://');

/** Podcasts.kind for a YouTube channel whose videos were imported one at a
 *  time (4.1.0). feed_url is `youtube://channel/<channelId>`; each episode is
 *  one video's audio, downloaded at import — id `youtube://<videoId>`,
 *  audio_url the watch page (nothing streams it: like a chapter of an imported
 *  collection, the file *is* the episode). Unlike collections the rows live in
 *  the Feed, the accordion and every Listening segment: one video is one
 *  episode, not sixty chapters. */
export const YOUTUBE_KIND = 'youtube';
export const isYouTubeFeedUrl = (feedUrl) => typeof feedUrl === 'string' && feedUrl.startsWith('youtube://');

// Every episode row carries its collection's kind and author, so screens can
// tell a chapter of an imported book (no feed, no re-download, its file *is*
// the episode) from a podcast episode without a second query.
const EPISODE_WITH_IMAGE = `
  SELECT e.*, p.image_url, p.kind AS podcast_kind, p.author AS podcast_author,
         (SELECT COUNT(*) FROM EpisodeBooks b WHERE b.episode_id = e.id AND b.first_ms IS NOT NULL) AS books_count
  FROM Episodes e
  LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
`;
const NOT_LOCAL = `COALESCE(p.kind, 'rss') != '${LOCAL_KIND}'`;
// Imported audio of either kind: the file is the episode, nothing re-fetches it.
const NOT_IMPORTED = `COALESCE(p.kind, 'rss') NOT IN ('${LOCAL_KIND}', '${YOUTUBE_KIND}')`;
const NOT_RADIO = `COALESCE(p.kind, 'rss') != '${RADIO_KIND}'`;

/** The Library: downloads still to hear. A finished episode leaves it (user,
 *  4.5.0: "if an episode is completely played it should not appear in the
 *  Library") and lives in Listening → Finished until its file goes; replaying
 *  it clears is_played and brings it back. */
export const getDownloadedEpisodes = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `${EPISODE_WITH_IMAGE} WHERE e.is_downloaded = 1 AND COALESCE(e.is_played, 0) = 0 ORDER BY e.release_date DESC`
  );
};

/** The Feed: every subscription's episodes. Chapters of imported collections
 *  stay out — a 60-chapter audiobook would bury the podcasts; they live in
 *  My Podcasts → the collection, and in Listening once started. */
export const getSubscribedEpisodes = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(`${EPISODE_WITH_IMAGE} WHERE ${NOT_LOCAL} AND ${NOT_RADIO} ORDER BY e.release_date DESC`);
};

// INSERT OR IGNORE preserves is_new, is_downloaded, local_audio_path, etc. for existing episodes.
// A row arrives "new" unless the caller says otherwise (is_new: 0) — an old
// episode the listener went looking for in the back catalogue is not news.
const insertEpisodeRow = (runner, episode) => {
  // A NULL primary key (guid-less feed item) inserts as a distinct NULL row on
  // every refresh (SQLite allows multiple NULLs in a TEXT PRIMARY KEY), poisons
  // NOT IN prune/cap queries, and crashes keyExtractor's id.toString(). Fall
  // back to a stable key (enclosure URL) and skip un-keyable items entirely.
  const id = episode.id ?? episode.audio_url ?? episode.enclosure;
  if (!id) return Promise.resolve();
  return runner.runAsync(
  `INSERT OR IGNORE INTO Episodes (id, title, description, podcast_title, podcast_feed_url, release_date, audio_url, is_downloaded, is_new, duration)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    id,
    episode.title,
    episode.description || '',
    episode.podcast_title,
    episode.podcast_feed_url || '',
    episode.release_date,
    episode.audio_url || episode.enclosure,
    episode.is_downloaded ? 1 : 0,
    episode.is_new === 0 ? 0 : 1,
    episode.duration || 0,
  ]
  );
};

export const saveEpisode = async (episode) => {
  const db = await openDatabaseContext();
  await insertEpisodeRow(db, episode);
};

export const saveEpisodesBatch = async (episodes) => {
  if (!episodes?.length) return;
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    for (const episode of episodes) {
      await insertEpisodeRow(db, episode);
    }
  });
};

export const savePodcast = async (podcast) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `INSERT OR IGNORE INTO Podcasts (title, description, feed_url, image_url, subscribed_at)
     VALUES (?, ?, ?, ?, ?)`,
    [podcast.title, podcast.description || '', podcast.feed_url, podcast.image_url || '', new Date().toISOString()]
  );
};

/** Refresh a subscription's cover from its feed. savePodcast is INSERT OR
 *  IGNORE, so a cover missed at subscribe time (or changed since) would
 *  otherwise stay wrong forever; feeds that send no artwork leave the stored
 *  one alone. */
export const updatePodcastImage = async (feedUrl, imageUrl) => {
  if (!imageUrl) return;
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Podcasts SET image_url = ? WHERE feed_url = ? AND (image_url IS NULL OR image_url != ?)`,
    [imageUrl, feedUrl, imageUrl]
  );
};

/** Subscriptions for My Podcasts: the ones with episodes not yet seen (the
 *  red badge) first, then the rest, each group with the newest episode
 *  first, so a show that just published rises to the top (user, 4.7.0: "my
 *  podcasts have to be ordered by the new ones"). release_date is ISO-8601,
 *  so string order is date order; a podcast with no episodes yet sorts last
 *  (NULL is smallest in SQLite), then by subscription date. */
export const getPodcasts = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(`
    SELECT p.*,
           (SELECT MAX(e.release_date) FROM Episodes e WHERE e.podcast_feed_url = p.feed_url) AS latest_episode_at,
           (SELECT COUNT(*) FROM Episodes e WHERE e.podcast_feed_url = p.feed_url) AS episode_count,
           EXISTS (SELECT 1 FROM Episodes e WHERE e.podcast_feed_url = p.feed_url AND e.is_new = 1) AS has_new
    FROM Podcasts p
    WHERE COALESCE(p.kind, 'rss') != '${RADIO_KIND}'
    ORDER BY has_new DESC, latest_episode_at DESC, p.subscribed_at DESC
  `);
};

/** The double check in the Feed and My Podcasts headers: every new episode
 *  seen at once — no red dot, no red count anywhere. */
export const markAllEpisodesAsSeen = async () => {
  const db = await openDatabaseContext();
  await db.runAsync('UPDATE Episodes SET is_new = 0 WHERE is_new = 1');
};

export const getPodcastByFeedUrl = async (feedUrl) => {
  const db = await openDatabaseContext();
  return db.getFirstAsync(
    `SELECT p.*,
            (SELECT COUNT(*) FROM Episodes e WHERE e.podcast_feed_url = p.feed_url) AS episode_count
     FROM Podcasts p WHERE p.feed_url = ? LIMIT 1`,
    [feedUrl]
  );
};

// ─── Local collections (imported audiobooks / audio files) ───────────────────

/** A new imported collection. feed_url is a synthetic `local://<id>` key so
 *  every per-podcast query works unchanged; nothing ever fetches it. */
export const saveLocalCollection = async ({ feed_url, title, author, description, image_url }) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `INSERT INTO Podcasts (title, description, feed_url, image_url, subscribed_at, kind, author)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [title, description || '', feed_url, image_url || '', new Date().toISOString(), LOCAL_KIND, author || '']
  );
};

/** Edit a collection's metadata. Only the keys present in `fields` change;
 *  a new title is copied onto its episodes' podcast_title (the Player header,
 *  the track's artist and the Library folder all read that). */
export const updateCollection = async (feedUrl, fields) => {
  const allowed = ['title', 'author', 'description', 'image_url', 'book_path'];
  const keys = allowed.filter(k => fields[k] !== undefined);
  if (!keys.length) return;
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(
      `UPDATE Podcasts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE feed_url = ?`,
      [...keys.map(k => fields[k] ?? ''), feedUrl]
    );
    if (fields.title !== undefined) {
      await db.runAsync(
        `UPDATE Episodes SET podcast_title = ? WHERE podcast_feed_url = ?`,
        [fields.title, feedUrl]
      );
    }
  });
};

/** Chapters of an imported collection, in one transaction. They are born
 *  downloaded (the file is the episode), never "new" (no badge for a book
 *  you just chose yourself) and keep their book order in track_number. */
export const insertLocalEpisodes = async (rows) => {
  if (!rows?.length) return;
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    for (const r of rows) {
      await db.runAsync(
        `INSERT OR IGNORE INTO Episodes
           (id, title, description, podcast_title, podcast_feed_url, release_date, audio_url,
            local_audio_path, is_downloaded, downloaded_at, is_new, duration, track_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
        [
          r.id, r.title, r.description || '', r.podcast_title, r.podcast_feed_url, r.release_date,
          r.local_audio_path, r.local_audio_path, Date.now(), r.duration || 0, r.track_number || 0,
        ]
      );
    }
  });
};

/** Every chapter of a collection in reading order. */
export const getEpisodesForCollection = async (feedUrl) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `${EPISODE_WITH_IMAGE} WHERE e.podcast_feed_url = ?
     ORDER BY COALESCE(e.track_number, 0) ASC, e.release_date DESC, e.title ASC`,
    [feedUrl]
  );
};

export const getMaxTrackNumber = async (feedUrl) => {
  const db = await openDatabaseContext();
  const row = await db.getFirstAsync(
    'SELECT MAX(track_number) AS max_track FROM Episodes WHERE podcast_feed_url = ?',
    [feedUrl]
  );
  return row?.max_track ?? 0;
};

export const updateEpisodeTitle = async (id, title) => {
  const db = await openDatabaseContext();
  await db.runAsync('UPDATE Episodes SET title = ? WHERE id = ?', [title, id]);
};

/** Remove one episode row outright (a chapter of an imported collection —
 *  there is no feed to re-list it from). Transcripts first, for the FTS
 *  triggers. The caller deletes the audio file. */
export const deleteEpisodeRow = async (id) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync('DELETE FROM Transcripts WHERE episode_id = ?', [id]);
    await db.runAsync('DELETE FROM Episodes WHERE id = ?', [id]);
  });
};

export const deletePodcast = async (feedUrl) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    // Explicit Transcripts delete (before Episodes) so the FTS triggers fire
    // regardless of the foreign_keys cascade state on this connection.
    await db.runAsync(
      `DELETE FROM Transcripts WHERE episode_id IN (
         SELECT id FROM Episodes WHERE podcast_feed_url = ?
       )`,
      [feedUrl]
    );
    await db.runAsync('DELETE FROM Episodes WHERE podcast_feed_url = ?', [feedUrl]);
    await db.runAsync('DELETE FROM Podcasts WHERE feed_url = ?', [feedUrl]);
  });
};

/** The audio is on the device. downloaded_at (epoch ms) is the start of the
 *  week the automatic cleanup gives a finished download (see
 *  getStaleFinishedDownloads); re-stamped on every (re-)download. */
export const updateEpisodeLocalPath = async (id, localPath) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Episodes SET local_audio_path = ?, is_downloaded = 1, downloaded_at = ? WHERE id = ?`,
    [localPath, Date.now(), id]
  );
};

export const saveTranscripts = async (episodeId, segments) => {
  const db = await openDatabaseContext();
  // Single transaction: all inserts commit together, ~100x faster than one await per row.
  // OR IGNORE + UNIQUE(episode_id, start_time, end_time) makes re-saves idempotent.
  await runInTxn(db, async () => {
    for (const segment of segments) {
      await db.runAsync(
        `INSERT OR IGNORE INTO Transcripts (episode_id, start_time, end_time, text) VALUES (?, ?, ?, ?)`,
        [episodeId, segment.start, segment.end, segment.text]
      );
    }
    await db.runAsync(`UPDATE Episodes SET has_transcript = 1 WHERE id = ?`, [episodeId]);
  });
};

/** Insert segments without setting has_transcript flag (used for incremental saves).
 *  Idempotent: re-running a window must not duplicate rows. */
export const saveTranscriptsIncremental = async (episodeId, segments) => {
  if (!segments.length) return;
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    for (const segment of segments) {
      await db.runAsync(
        `INSERT OR IGNORE INTO Transcripts (episode_id, start_time, end_time, text) VALUES (?, ?, ?, ?)`,
        [episodeId, segment.start, segment.end, segment.text]
      );
    }
  });
};

// SQLite allows 999 bound variables by default; four per row leaves room.
const TRANSCRIPT_INSERT_BATCH = 200;

/** End of the last saved transcript segment, in the stored time unit (ms). 0 if none. */
export const getTranscriptLastEndMs = async (episodeId) => {
  const db = await openDatabaseContext();
  const row = await db.getFirstAsync(
    'SELECT MAX(end_time) AS last_end FROM Transcripts WHERE episode_id = ?',
    [episodeId]
  );
  return row?.last_end ?? 0;
};

/** Mark episode as having a complete transcript. */
export const finalizeTranscript = async (episodeId) => {
  const db = await openDatabaseContext();
  await db.runAsync(`UPDATE Episodes SET has_transcript = 1 WHERE id = ?`, [episodeId]);
};

/** `text` is the repaired wording when the punctuation pass has written one
 *  (services/repunctuate.js), the recogniser's otherwise; `text_raw` is always
 *  what the recogniser wrote, which is what the search index holds. */
export const getTranscriptsForEpisode = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT id, episode_id, start_time, end_time,
            COALESCE(text_fixed, text) AS text, text AS text_raw
       FROM Transcripts WHERE episode_id = ? ORDER BY start_time ASC`,
    [episodeId]
  );
};

/** The punctuation pass's answer: one repaired wording per row it changed.
 *  Transcripts.text keeps the recogniser's words either way. */
export const saveRepunctuation = async (episodeId, rows) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    for (const r of rows) {
      await db.runAsync('UPDATE Transcripts SET text_fixed = ? WHERE id = ? AND episode_id = ?',
        [r.text, r.id, episodeId]);
    }
    await db.runAsync('UPDATE Episodes SET repunctuated_at = ? WHERE id = ?', [Date.now(), episodeId]);
  });
};

/** Back to the recogniser's own punctuation. */
export const clearRepunctuation = async (episodeId) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync('UPDATE Transcripts SET text_fixed = NULL WHERE episode_id = ?', [episodeId]);
    await db.runAsync('UPDATE Episodes SET repunctuated_at = NULL WHERE id = ?', [episodeId]);
  });
};

/** A completed cloud comparison is swapped atomically; failed runs leave the
 * previous result and the on-device transcript untouched. */
export const saveMaiTranscript = async (episodeId, segments, { costUsd = null, audioSeconds = null } = {}) => {
  if (!segments.length) throw new Error('MAI returned no speech');
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync('DELETE FROM MaiTranscriptSegments WHERE episode_id = ?', [episodeId]);
    for (let i = 0; i < segments.length; i += TRANSCRIPT_INSERT_BATCH) {
      const block = segments.slice(i, i + TRANSCRIPT_INSERT_BATCH);
      const params = [];
      for (const r of block) params.push(episodeId, r.start, r.end, r.text);
      await db.runAsync(
        `INSERT INTO MaiTranscriptSegments (episode_id, start_time, end_time, text) VALUES ${block.map(() => '(?, ?, ?, ?)').join(', ')}`,
        params
      );
    }
    await db.runAsync(
      `INSERT OR REPLACE INTO MaiTranscriptRuns (episode_id, model, created_at, cost_usd, audio_seconds)
       VALUES (?, 'microsoft/mai-transcribe-2', ?, ?, ?)`,
      [episodeId, Date.now(), costUsd, audioSeconds]
    );
  });
};

/**
 * The cloud transcript becomes the episode's own text: the recogniser's rows
 * are replaced by it, and everything that was read out of them — the names,
 * the assistant's corrections, chapters, summary, the books scan — is cleared
 * so the passes run again on what is now there. The cloud copy stays in its
 * own table: it was paid for, while the phone's can be made again for
 * nothing. Resolves the number of rows written.
 */
/** What the episode names, newest scan replacing the last (entityIndex.js). */
export const replaceEpisodeEntities = async (episodeId, entities) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync('DELETE FROM EpisodeEntities WHERE episode_id = ?', [episodeId]);
    for (const e of entities) {
      await db.runAsync(
        `INSERT INTO EpisodeEntities (episode_id, type, surface, canonical, hint, context, count, first_ms,
                                      source, source_url, image_url, subtitle, facts, blurb, rating, ratings_count, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [episodeId, e.type, e.surface, e.canonical, e.hint || null, e.context || null,
         e.count || 1, e.firstMs ?? null, e.source || null, e.sourceUrl || null, e.imageUrl || null,
         e.subtitle || null, e.facts || null, e.blurb || null,
         e.rating ?? null, e.ratingsCount ?? null, e.resolvedAt ?? null]
      );
    }
    await db.runAsync('UPDATE Episodes SET entities_indexed_at = ? WHERE id = ?', [Date.now(), episodeId]);
  });
};

export const getEpisodeEntities = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    'SELECT * FROM EpisodeEntities WHERE episode_id = ? ORDER BY first_ms IS NULL, first_ms',
    [episodeId]
  );
};

/** One entity's catalogue answer, written when its lookup comes back. */
export const saveEntityResolution = async (id, r = {}) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE EpisodeEntities SET source = ?, source_url = ?, image_url = ?, subtitle = ?,
            facts = ?, blurb = ?, rating = ?, ratings_count = ?, resolved_at = ?
       WHERE id = ?`,
    [r.source || null, r.sourceUrl || null, r.imageUrl || null, r.subtitle || null,
     r.facts || null, r.blurb || null, r.rating ?? null, r.ratingsCount ?? null, Date.now(), id]
  );
};

export const promoteMaiTranscript = async (episodeId) => {
  const db = await openDatabaseContext();
  const source = await db.getAllAsync(
    'SELECT start_time, end_time, text FROM MaiTranscriptSegments WHERE episode_id = ? ORDER BY start_time',
    [episodeId]
  );
  if (!source.length) throw new Error('There is no cloud transcript for this episode.');
  // Transcripts is unique on (episode_id, start_time, end_time), so a repeated
  // start is nudged a millisecond along rather than dropping the line.
  let last = -1;
  const rows = [];
  for (const r of source) {
    const text = String(r.text || '').trim();
    if (!text) continue;
    const start = Math.max(Number(r.start_time) || 0, last + 1);
    last = start;
    rows.push({ start, end: Math.max(start + 1, Number(r.end_time) || 0), text });
  }
  if (!rows.length) throw new Error('The cloud transcript is empty.');
  await runInTxn(db, async () => {
    await db.runAsync('DELETE FROM Transcripts WHERE episode_id = ?', [episodeId]);
    for (let i = 0; i < rows.length; i += TRANSCRIPT_INSERT_BATCH) {
      const block = rows.slice(i, i + TRANSCRIPT_INSERT_BATCH);
      const params = [];
      for (const r of block) params.push(episodeId, r.start, r.end, r.text);
      await db.runAsync(
        `INSERT INTO Transcripts (episode_id, start_time, end_time, text) VALUES ${block.map(() => '(?, ?, ?, ?)').join(', ')}`,
        params
      );
    }
    for (const table of ['EpisodeNames', 'EpisodeFixes', 'EpisodeChapters', 'EpisodeBooks', 'EpisodeEntities']) {
      await db.runAsync(`DELETE FROM ${table} WHERE episode_id = ?`, [episodeId]);
    }
    await db.runAsync(
      `UPDATE Episodes SET has_transcript = 1, transcript_source = 'cloud', transcript_aligned = 0,
              names_indexed_at = NULL, books_indexed_at = NULL, summary = NULL, entities_indexed_at = NULL,
              ai_indexed_at = NULL, ai_model = NULL, repunctuated_at = NULL
         WHERE id = ?`,
      [episodeId]
    );
  });
  return rows.length;
};

/** Throws the paid-for copy away, without touching the episode's own text. */
export const deleteMaiTranscript = async (episodeId) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync('DELETE FROM MaiTranscriptSegments WHERE episode_id = ?', [episodeId]);
    await db.runAsync('DELETE FROM MaiTranscriptRuns WHERE episode_id = ?', [episodeId]);
  });
};

export const getMaiTranscript = async (episodeId) => {
  const db = await openDatabaseContext();
  const [run, segments] = await Promise.all([
    db.getFirstAsync('SELECT * FROM MaiTranscriptRuns WHERE episode_id = ?', [episodeId]),
    db.getAllAsync('SELECT * FROM MaiTranscriptSegments WHERE episode_id = ? ORDER BY start_time', [episodeId]),
  ]);
  return { run, segments };
};

export const deleteEpisodeTranscript = async (id, { includeMai = false } = {}) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM Transcripts WHERE episode_id = ?`, [id]);
    if (includeMai) {
      await db.runAsync(`DELETE FROM MaiTranscriptSegments WHERE episode_id = ?`, [id]);
      await db.runAsync(`DELETE FROM MaiTranscriptRuns WHERE episode_id = ?`, [id]);
    }
    await db.runAsync(`DELETE FROM EpisodeBooks WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeNames WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeChapters WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeEntities WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeFixes WHERE episode_id = ?`, [id]);
    await db.runAsync(
      `UPDATE Episodes SET has_transcript = 0, books_indexed_at = NULL, names_indexed_at = NULL,
              summary = NULL, ai_indexed_at = NULL, ai_model = NULL, repunctuated_at = NULL,
              transcript_source = NULL, transcript_aligned = 0, entities_indexed_at = NULL
       WHERE id = ?`,
      [id]
    );
  });
};

// ─── The book's text as a transcript (services/bookService.js, 4.8.0) ───────

/**
 * Replace an episode's transcript wholesale with `rows` ({start, end, text},
 * ms) — the book's words at estimated times, or at the recogniser's after a
 * sync. Whatever an earlier recognition left behind about the *heard* text
 * goes with it (names, fixes, books); the names pass is marked done, since
 * the author's spelling needs no correcting, and the books scan runs again
 * on the real text. `range` is the bookMap range the rows came from.
 */
export const replaceEpisodeTranscript = async (episodeId, rows, { source = 'book', aligned = 0, range = null } = {}) => {
  // `aligned` is a state, not a flag: 0 the pace is guessed, 1 it came from
  // the narrator's pauses, 2 the text cannot be what this audio reads,
  // 3 the words have been matched to recognised speech
  // (services/bookService.js). Storing it as a boolean turned "cannot fit"
  // into "matched", and the chapter claimed a timing it never had.
  const timing = Math.max(0, Math.min(3, Math.round(Number(aligned) || 0)));
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM Transcripts WHERE episode_id = ?`, [episodeId]);
    await db.runAsync(`DELETE FROM EpisodeBooks WHERE episode_id = ?`, [episodeId]);
    await db.runAsync(`DELETE FROM EpisodeNames WHERE episode_id = ?`, [episodeId]);
    await db.runAsync(`DELETE FROM EpisodeFixes WHERE episode_id = ?`, [episodeId]);
    // A book chapter is one row per word — three thousand of them, and a
    // sixty-chapter book is a hundred and seventy thousand. One statement per
    // row means as many trips across the bridge, so they go in blocks.
    for (let i = 0; i < rows.length; i += TRANSCRIPT_INSERT_BATCH) {
      const block = rows.slice(i, i + TRANSCRIPT_INSERT_BATCH);
      const values = block.map(() => '(?, ?, ?, ?)').join(', ');
      const params = [];
      for (const r of block) params.push(episodeId, r.start, r.end, r.text);
      await db.runAsync(
        `INSERT OR IGNORE INTO Transcripts (episode_id, start_time, end_time, text) VALUES ${values}`,
        params
      );
    }
    await db.runAsync(
      `UPDATE Episodes SET has_transcript = ?, transcript_source = ?, transcript_aligned = ?, book_range = ?,
              names_indexed_at = ?, books_indexed_at = NULL
       WHERE id = ?`,
      [rows.length ? 1 : 0, source, timing, range ? JSON.stringify(range) : null, Date.now(), episodeId]
    );
  });
};

/** Which part of the book an episode reads (JSON range or null), without touching its rows. */
export const updateEpisodeBookRange = async (episodeId, range) => {
  const db = await openDatabaseContext();
  await db.runAsync(`UPDATE Episodes SET book_range = ? WHERE id = ?`, [range ? JSON.stringify(range) : null, episodeId]);
};

// ─── Books mentioned in an episode (services/bookIndex.js) ───────────────────

export const getEpisodeBooks = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT * FROM EpisodeBooks WHERE episode_id = ? ORDER BY first_ms ASC, id ASC`,
    [episodeId]
  );
};

/** Replaces the episode's books and stamps the scan time in one transaction. */
export const replaceEpisodeBooks = async (episodeId, books, indexedAt = Date.now()) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM EpisodeBooks WHERE episode_id = ?`, [episodeId]);
    for (const b of books || []) {
      await db.runAsync(
        `INSERT INTO EpisodeBooks
           (episode_id, title, author, description, rating, ratings_count, cover_url, year, pages,
            openlibrary_url, goodreads_url, source, heard_as, first_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          episodeId, b.title, b.author || null, b.description || null,
          b.rating ?? null, b.ratingsCount || 0, b.coverUrl || null, b.year || null, b.pages || null,
          b.openlibraryUrl || null, b.goodreadsUrl || null, b.source || null,
          JSON.stringify(b.heardAs || []), b.firstMs ?? null,
        ]
      );
    }
    await db.runAsync(`UPDATE Episodes SET books_indexed_at = ? WHERE id = ?`, [indexedAt, episodeId]);
  });
};

/** Ids of transcribed episodes never scanned for books, or scanned before
 *  `staleBefore` (epoch ms — an older detector), the ones listened to most
 *  recently first; radio sessions excluded. (services/bookIndex.js backlog) */
export const getEpisodesNeedingBookScan = async (staleBefore = 0) => {
  const db = await openDatabaseContext();
  const rows = await db.getAllAsync(
    `SELECT e.id FROM Episodes e
     LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
     WHERE e.has_transcript = 1 AND (e.books_indexed_at IS NULL OR e.books_indexed_at < ?) AND ${NOT_RADIO}
     ORDER BY COALESCE(e.last_played_at, 0) DESC, COALESCE(e.downloaded_at, 0) DESC`,
    [staleBefore]
  );
  return rows.map(r => r.id).filter(Boolean);
};

// ─── People's names corrected in an episode (services/nameIndex.js) ─────────

/** [{ heard, canonical, count, first_ms }] for the episode, most frequent first. */
export const getEpisodeNames = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT heard, canonical, count, first_ms FROM EpisodeNames WHERE episode_id = ? ORDER BY count DESC, heard ASC`,
    [episodeId]
  );
};

export const replaceEpisodeNames = async (episodeId, names, indexedAt = Date.now()) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM EpisodeNames WHERE episode_id = ?`, [episodeId]);
    for (const n of names || []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO EpisodeNames (episode_id, heard, canonical, count, first_ms) VALUES (?, ?, ?, ?, ?)`,
        [episodeId, n.heard, n.canonical, n.count || 0, n.firstMs ?? null]
      );
    }
    await db.runAsync(`UPDATE Episodes SET names_indexed_at = ? WHERE id = ?`, [indexedAt, episodeId]);
  });
};

/** Transcribed episodes never scanned for names, most recently listened first. */
export const getEpisodesNeedingNameScan = async () => {
  const db = await openDatabaseContext();
  const rows = await db.getAllAsync(
    `SELECT e.id FROM Episodes e
     LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
     WHERE e.has_transcript = 1 AND e.names_indexed_at IS NULL AND ${NOT_RADIO}
     ORDER BY COALESCE(e.last_played_at, 0) DESC, COALESCE(e.downloaded_at, 0) DESC`
  );
  return rows.map(r => r.id).filter(Boolean);
};

// ─── The episode assistant (services/aiService.js) ───────────────────────────

export const getEpisodeChapters = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT id, start_ms, end_ms, title, blurb, source FROM EpisodeChapters WHERE episode_id = ? ORDER BY start_ms ASC`,
    [episodeId]
  );
};

export const getEpisodeFixes = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT heard, correct, kind, context, confidence, count, first_ms, applied
     FROM EpisodeFixes WHERE episode_id = ? ORDER BY COALESCE(first_ms, 0) ASC, heard ASC`,
    [episodeId]
  );
};

/** One analysis replaces the last: summary, chapters and fixes together. */
export const replaceEpisodeAnalysis = async (episodeId, { summary, chapters, fixes, model }, indexedAt = Date.now()) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM EpisodeChapters WHERE episode_id = ?`, [episodeId]);
    for (const c of chapters || []) {
      await db.runAsync(
        `INSERT INTO EpisodeChapters (episode_id, start_ms, end_ms, title, blurb, source) VALUES (?, ?, ?, ?, ?, ?)`,
        [episodeId, Math.round(c.startMs), c.endMs != null ? Math.round(c.endMs) : null, c.title, c.blurb || null, c.source || 'ai']
      );
    }
    await db.runAsync(`DELETE FROM EpisodeFixes WHERE episode_id = ?`, [episodeId]);
    for (const f of fixes || []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO EpisodeFixes (episode_id, heard, correct, kind, context, confidence, count, first_ms, applied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [episodeId, f.heard, f.correct, f.kind || null, f.context || null, f.confidence || null,
         f.count || 0, f.firstMs ?? null, f.applied === false ? 0 : 1]
      );
    }
    await db.runAsync(
      `UPDATE Episodes SET summary = ?, ai_indexed_at = ?, ai_model = ? WHERE id = ?`,
      [summary || null, indexedAt, model || null, episodeId]
    );
  });
};

export const clearEpisodeAnalysis = async (episodeId) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM EpisodeChapters WHERE episode_id = ?`, [episodeId]);
    await db.runAsync(`DELETE FROM EpisodeFixes WHERE episode_id = ?`, [episodeId]);
    await db.runAsync(`UPDATE Episodes SET summary = NULL, ai_indexed_at = NULL, ai_model = NULL WHERE id = ?`, [episodeId]);
  });
};

export const clearEpisodeBooks = async (episodeId) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM EpisodeBooks WHERE episode_id = ?`, [episodeId]);
    await db.runAsync(`UPDATE Episodes SET books_indexed_at = NULL WHERE id = ?`, [episodeId]);
  });
};

export const deleteEpisodeLocalData = async (id) => {
  const db = await openDatabaseContext();
  // Transactional like deleteEpisodeTranscript: an interruption between the two
  // statements would leave has_transcript=0 while Transcripts (and TranscriptsFTS)
  // rows survive, so vocabulary search keeps returning hits for an episode the
  // UI says has no transcript. Delete Transcripts first (FTS delete trigger).
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM Transcripts WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM MaiTranscriptSegments WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM MaiTranscriptRuns WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeBooks WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeNames WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeChapters WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeEntities WHERE episode_id = ?`, [id]);
    await db.runAsync(`DELETE FROM EpisodeFixes WHERE episode_id = ?`, [id]);
    await db.runAsync(
      `UPDATE Episodes SET local_audio_path = NULL, is_downloaded = 0, has_transcript = 0, downloaded_at = NULL,
              books_indexed_at = NULL, names_indexed_at = NULL, summary = NULL, ai_indexed_at = NULL, ai_model = NULL
       WHERE id = ?`,
      [id]
    );
  });
};

export const savePlayPosition = async (id, positionSeconds) => {
  const db = await openDatabaseContext();
  // last_played_at orders the Listening tab; stamped on every write
  // (including the reset to 0 on completion) so it always means "last heard".
  // A real position also clears is_played: replaying a finished episode makes
  // it "in progress" again (Played tag gone, back under In progress) and
  // lets markEpisodePlayed's 0→1 transition fire once more when it re-ends.
  // The completion path saves 0 and must NOT touch is_played, or every tick
  // inside the final-stretch window would re-emit 'playback-complete'.
  if (positionSeconds > 0) {
    await db.runAsync(
      `UPDATE Episodes SET play_position = ?, last_played_at = ?, is_played = 0 WHERE id = ?`,
      [positionSeconds, Date.now(), id]
    );
  } else {
    await db.runAsync(
      `UPDATE Episodes SET play_position = ?, last_played_at = ? WHERE id = ?`,
      [positionSeconds, Date.now(), id]
    );
  }
};

/** Back to a never-started row (Listening → Finished → "Unplayed"): not
 *  played, no position, no listening timestamp — it reappears under New. */
export const clearPlayProgress = async (id) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Episodes SET play_position = 0, is_played = 0, last_played_at = NULL WHERE id = ?`,
    [id]
  );
};

/** Episodes by listening state, for the Listening tab — a pipeline:
 *    downloaded   on the device, not started      newest release first
 *                 (is_downloaded 1, is_played 0, position 0)
 *    in-progress  is_played 0, position > 0       most recently heard first
 *    finished     is_played 1                     most recently finished first
 *  Not-started episodes that are not downloaded belong to the Feed, not here.
 *  Completion resets play_position to 0, so the segments are disjoint. Rows
 *  last heard before last_played_at existed (NULL) sort after the stamped
 *  ones, newest release first. */
const LISTENING_STATE_SQL = {
  // Chapters of imported collections are "downloaded" by construction; they
  // would swamp this segment, so only podcast downloads are listed. Started
  // and finished chapters do appear in the two segments below.
  'downloaded':
    `WHERE e.is_downloaded = 1 AND e.is_played = 0 AND COALESCE(e.play_position, 0) = 0
       AND ${NOT_LOCAL}
     ORDER BY e.release_date DESC`,
  'in-progress':
    `WHERE e.is_played = 0 AND e.play_position > 0 AND ${NOT_RADIO}
     ORDER BY (e.last_played_at IS NULL), e.last_played_at DESC, e.release_date DESC`,
  'finished':
    `WHERE e.is_played = 1 AND ${NOT_RADIO}
     ORDER BY (e.last_played_at IS NULL), e.last_played_at DESC, e.release_date DESC`,
};

export const getEpisodesByListeningState = async (state) => {
  const clause = LISTENING_STATE_SQL[state];
  if (!clause) throw new Error(`Unknown listening state: ${state}`);
  const db = await openDatabaseContext();
  return db.getAllAsync(`${EPISODE_WITH_IMAGE} ${clause}`);
};

/** Manual "mark as played" (Listening tab swipe). Same end state as a
 *  natural finish — played, position back at the top, last_played_at = now
 *  (the Finished segment is "most recently finished first", and the week
 *  the automatic cleanup allows a finished download counts from here) —
 *  regardless of the current is_played value, unlike markEpisodePlayed's
 *  0→1 guard. */
export const markEpisodeFinished = async (id) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Episodes SET is_played = 1, play_position = 0, last_played_at = ? WHERE id = ?`,
    [Date.now(), id]
  );
};

/** Finished episodes whose download has outlived its use: heard to the end
 *  (or marked Done) before `cutoffMs`, not replayed since — a replay clears
 *  is_played (savePlayPosition) and so drops the row out of here until it
 *  ends again with a fresh stamp — and downloaded before `cutoffMs` too, so
 *  a re-download for a read-along gets its own week. Finished rows from
 *  before last_played_at existed (NULL) count as old; their downloaded_at
 *  was stamped at the v6 upgrade, which is what gives them a week's grace.
 *  A NULL downloaded_at (never expected on a downloaded row) is left alone. */
export const getStaleFinishedDownloads = async (cutoffMs) => {
  const db = await openDatabaseContext();
  // Imported audio is excluded — collections and YouTube videos alike: their
  // file is the episode, with no feed to stream it from again; the sweep
  // would destroy the book or the video's only copy.
  return db.getAllAsync(
    `${EPISODE_WITH_IMAGE}
     WHERE e.is_played = 1
       AND e.is_downloaded = 1 AND e.local_audio_path IS NOT NULL
       AND COALESCE(e.last_played_at, 0) < ?
       AND e.downloaded_at IS NOT NULL AND e.downloaded_at < ?
       AND ${NOT_IMPORTED}
     ORDER BY e.last_played_at ASC`,
    [cutoffMs, cutoffMs]
  );
};

/** Feeds without <itunes:duration> leave duration at 0; once the player
 *  knows the real length, keep it so lists can show a total time. Only
 *  fills the gap — a feed-supplied duration is never overwritten. */
export const setEpisodeDurationIfMissing = async (id, seconds) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Episodes SET duration = ? WHERE id = ? AND (duration IS NULL OR duration <= 0)`,
    [seconds, id]
  );
};

/** Mark an episode as fully listened. Returns true only on the 0→1
 *  transition so callers can skip redundant change notifications. */
export const markEpisodePlayed = async (id) => {
  const db = await openDatabaseContext();
  const res = await db.runAsync(
    `UPDATE Episodes SET is_played = 1 WHERE id = ? AND is_played = 0`,
    [id]
  );
  return (res?.changes ?? 0) > 0;
};

export const getTotalNewEpisodesCount = async () => {
  const db = await openDatabaseContext();
  const row = await db.getFirstAsync(
    'SELECT COUNT(*) as count FROM Episodes WHERE is_new = 1'
  );
  return row?.count ?? 0;
};

export const getNewEpisodesCountForPodcast = async (feedUrl) => {
  const db = await openDatabaseContext();
  const row = await db.getFirstAsync(
    'SELECT COUNT(*) as count FROM Episodes WHERE podcast_feed_url = ? AND is_new = 1',
    [feedUrl]
  );
  return Math.min(row?.count ?? 0, 5);
};

export const getLatestEpisodesForPodcast = async (feedUrl, limit = 5) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(`
    ${EPISODE_WITH_IMAGE}
    WHERE e.podcast_feed_url = ?
    ORDER BY e.release_date DESC
    LIMIT ?
  `, [feedUrl, limit]);
};

/** Every row of a podcast on the device, newest first — the back-catalogue
 *  screen shows these at once (and alone, offline) while the feed loads. */
export const getStoredEpisodesForPodcast = async (feedUrl) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(`
    ${EPISODE_WITH_IMAGE}
    WHERE e.podcast_feed_url = ?
    ORDER BY e.release_date DESC
  `, [feedUrl]);
};

/** One episode drops out of the "new" count — the user acted on it
 *  (downloaded it, or tapped the check that sits on a new row), so it no
 *  longer needs the red dot. */
export const markEpisodeSeen = async (id) => {
  const db = await openDatabaseContext();
  await db.runAsync('UPDATE Episodes SET is_new = 0 WHERE id = ? AND is_new = 1', [id]);
};

// Keep only the latest maxNew episodes marked as new; mark the rest as seen
export const capNewEpisodes = async (feedUrl, maxNew = 5) => {
  const db = await openDatabaseContext();
  await db.runAsync(`
    UPDATE Episodes SET is_new = 0
    WHERE podcast_feed_url = ?
      AND is_new = 1
      AND id NOT IN (
        SELECT id FROM Episodes
        WHERE podcast_feed_url = ? AND is_new = 1
        ORDER BY release_date DESC
        LIMIT ?
      )
  `, [feedUrl, feedUrl, maxNew]);
};

/** Trim a feed's list to its latest maxKeep rows. Kept regardless of age:
 *  downloads, transcripts, and anything the listener started or finished —
 *  an episode opened from the back catalogue (4.5.1) would otherwise lose
 *  its position, or drop out of Listening → Finished, on the next visit to
 *  My Podcasts. */
export const pruneOldEpisodesForPodcast = async (feedUrl, maxKeep) => {
  const db = await openDatabaseContext();
  await db.runAsync(`
    DELETE FROM Episodes
    WHERE podcast_feed_url = ?
      AND is_downloaded = 0
      AND has_transcript = 0
      AND COALESCE(play_position, 0) = 0
      AND COALESCE(is_played, 0) = 0
      AND id NOT IN (
        SELECT id FROM Episodes
        WHERE podcast_feed_url = ?
        ORDER BY release_date DESC
        LIMIT ?
      )
  `, [feedUrl, feedUrl, maxKeep]);
};

export const getEpisodeById = async (id) => {
  const db = await openDatabaseContext();
  return db.getFirstAsync(
    `${EPISODE_WITH_IMAGE} WHERE e.id = ? LIMIT 1`,
    [id]
  );
};

// Episodes of a feed that have an on-disk audio file — used to delete the
// orphaned mp3s before deletePodcast removes the rows (and their paths).
export const getDownloadedEpisodesForPodcast = async (feedUrl) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    'SELECT id, local_audio_path FROM Episodes WHERE podcast_feed_url = ? AND local_audio_path IS NOT NULL',
    [feedUrl]
  );
};

/** Every episode of a feed (id + audio path, NULL when streamed) — what
 *  unsubscribing has to dequeue, stop, delete and forget. */
export const getEpisodesForPodcastFeed = async (feedUrl) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    'SELECT id, local_audio_path FROM Episodes WHERE podcast_feed_url = ?',
    [feedUrl]
  );
};

/** Every audio path a row still refers to — the orphan sweep keeps these. */
export const getAllLocalAudioPaths = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync('SELECT local_audio_path FROM Episodes WHERE local_audio_path IS NOT NULL');
};

/** feed_url of every imported collection — its imports/<id> folder is live. */
export const getLocalCollectionFeedUrls = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync('SELECT feed_url FROM Podcasts WHERE kind = ?', [LOCAL_KIND]);
};

// ─── YouTube imports (4.1.0) ─────────────────────────────────────────────────

/** A channel row (kind 'youtube'), created by the first video imported from
 *  it. Upsert: the channel's name and avatar follow the latest import; a
 *  description is only written once (the user may have edited nothing, but
 *  the text is ours either way). */
export const saveYouTubeChannel = async ({ feed_url, title, description, image_url, author }) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `INSERT INTO Podcasts (title, description, feed_url, image_url, subscribed_at, kind, author)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(feed_url) DO UPDATE SET
       title = excluded.title,
       author = excluded.author,
       image_url = CASE WHEN excluded.image_url != '' THEN excluded.image_url ELSE Podcasts.image_url END`,
    [title, description || '', feed_url, image_url || '', new Date().toISOString(), YOUTUBE_KIND, author || '']
  );
};

/** One imported video: born downloaded (the file is the episode), never
 *  "new" (the user just chose it). Importing a video again — after its file
 *  was deleted, say — refreshes the file, title, notes and length but keeps
 *  the listening state (position, played, last heard). */
export const insertYouTubeEpisode = async (r) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `INSERT INTO Episodes
       (id, title, description, podcast_title, podcast_feed_url, release_date, audio_url,
        local_audio_path, is_downloaded, downloaded_at, is_new, duration, track_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       podcast_title = excluded.podcast_title,
       podcast_feed_url = excluded.podcast_feed_url,
       release_date = excluded.release_date,
       audio_url = excluded.audio_url,
       local_audio_path = excluded.local_audio_path,
       is_downloaded = 1,
       downloaded_at = excluded.downloaded_at,
       has_transcript = 0,
       duration = excluded.duration`,
    [
      r.id, r.title, r.description || '', r.podcast_title, r.podcast_feed_url, r.release_date,
      r.audio_url, r.local_audio_path, Date.now(), r.duration || 0,
    ]
  );
};

// ─── Live radio (4.0.0) ──────────────────────────────────────────────────────

/** A station row (kind 'radio'), created the first time it is tuned in.
 *  INSERT OR IGNORE: a second session re-uses it. */
export const saveRadioStation = async ({ feed_url, title, description, image_url }) => {
  const db = await openDatabaseContext();
  // Upsert: the station's name / blurb follow the catalog across versions.
  await db.runAsync(
    `INSERT INTO Podcasts (title, description, feed_url, image_url, subscribed_at, kind)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(feed_url) DO UPDATE SET title = excluded.title, description = excluded.description`,
    [title, description || '', feed_url, image_url || '', new Date().toISOString(), RADIO_KIND]
  );
};

/** One listening session. `local_audio_path` is the local HLS playlist when
 *  the session records for a transcript, NULL when it plays the stream
 *  directly; is_downloaded stays 0 either way so the Library never lists it. */
export const insertRadioEpisode = async ({ id, title, description, podcast_title, podcast_feed_url, audio_url, local_audio_path }) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `INSERT OR REPLACE INTO Episodes
       (id, title, description, podcast_title, podcast_feed_url, release_date, audio_url,
        local_audio_path, is_downloaded, is_new, duration, play_position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
    [id, title, description || '', podcast_title, podcast_feed_url, new Date().toISOString(), audio_url, local_audio_path || null]
  );
};

/** The programme changed on air: the session row follows (Player header,
 *  MiniPlayer). */
export const updateRadioEpisodeProgramme = async (id, title, description) => {
  const db = await openDatabaseContext();
  await db.runAsync('UPDATE Episodes SET title = ?, description = ? WHERE id = ?', [title, description || '', id]);
};

/** The session stopped recording and plays the stream directly (recorder
 *  failure): the row loses its playlist so the Player shows live controls. */
export const updateRadioEpisodeLocalPath = async (id, localPath) => {
  const db = await openDatabaseContext();
  await db.runAsync('UPDATE Episodes SET local_audio_path = ? WHERE id = ?', [localPath || null, id]);
};

/** Every session row (with transcripts) — at launch, nothing can be resumed. */
export const deleteAllRadioEpisodes = async () => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(
      `DELETE FROM Transcripts WHERE episode_id IN (
         SELECT id FROM Episodes WHERE podcast_feed_url LIKE 'radio://%'
       )`
    );
    await db.runAsync(`DELETE FROM Episodes WHERE podcast_feed_url LIKE 'radio://%'`);
  });
};

// ─── Statistics (5.1.0) ──────────────────────────────────────────────────────
// Two ledgers behind screens/StatsScreen.js: ListeningLog, added to while
// something plays (services/statsService.js), and ApiSpend, one row per paid
// request. Neither has a foreign key — both outlive the episode they are
// about — so the titles are copied into them as they are written.

/** The moment measuring began (schema v15). Everything before it can only be
 *  estimated from the library, so the screen keeps the two apart. */
export const getStatsSince = async () => {
  const db = await openDatabaseContext();
  const row = await db.getFirstAsync(`SELECT value FROM StatsMeta WHERE key = 'since'`);
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Adds a spell of listening to its day's row. Called every half minute or so
 *  while audio plays, and whenever it stops, so a process killed mid-episode
 *  loses at most that much. */
export const addListeningTime = async ({
  day, itemId, kind = 'rss', title = null, source = null, feedUrl = null,
  seconds = 0, realSeconds = 0, at = Date.now(),
}) => {
  if (!day || !itemId || (seconds <= 0 && realSeconds <= 0)) return;
  const db = await openDatabaseContext();
  await db.runAsync(
    `INSERT INTO ListeningLog (day, item_id, kind, title, source, feed_url, seconds, real_seconds, first_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, item_id) DO UPDATE SET
       seconds      = ListeningLog.seconds + excluded.seconds,
       real_seconds = ListeningLog.real_seconds + excluded.real_seconds,
       title        = COALESCE(excluded.title, ListeningLog.title),
       source       = COALESCE(excluded.source, ListeningLog.source),
       last_at      = excluded.last_at`,
    [day, itemId, kind, title, source, feedUrl, seconds, realSeconds, at, at]
  );
};

/** Every day with listening in it, oldest first. Small — one row per thing
 *  heard per day — so the screen reads the lot and slices it itself. */
export const getListeningLog = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT day, item_id, kind, title, source, feed_url, seconds, real_seconds, last_at
       FROM ListeningLog ORDER BY day ASC`
  );
};

/** What the library remembers of the listening done before measuring began:
 *  an episode heard to the end counts its length, one in progress its
 *  position, both on the day they were last played. Radio sessions are left
 *  out — their rows are deleted at every launch, so nothing survives to
 *  count. Excludes anything last played since `since`, which the log has. */
export const getEstimatedListeningHistory = async (since) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT strftime('%Y-%m-%d', e.last_played_at / 1000, 'unixepoch', 'localtime') AS day,
            COALESCE(p.kind, 'rss') AS kind,
            e.podcast_title AS source,
            SUM(CASE WHEN e.is_played = 1 THEN COALESCE(e.duration, 0) ELSE COALESCE(e.play_position, 0) END) AS seconds,
            COUNT(*) AS items
       FROM Episodes e
       LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
      WHERE e.last_played_at IS NOT NULL AND e.last_played_at < ?
        AND COALESCE(p.kind, 'rss') != '${RADIO_KIND}'
      GROUP BY day, kind, source
     HAVING seconds > 0
      ORDER BY day ASC`,
    [since]
  );
};

/** Episodes heard to the end, by the day they finished. */
export const getFinishedByDay = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT strftime('%Y-%m-%d', e.last_played_at / 1000, 'unixepoch', 'localtime') AS day,
            COUNT(*) AS episodes
       FROM Episodes e
       LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
      WHERE e.is_played = 1 AND e.last_played_at IS NOT NULL
        AND COALESCE(p.kind, 'rss') != '${RADIO_KIND}'
      GROUP BY day ORDER BY day ASC`
  );
};

/** One paid request. `cost` is what it came to in dollars — the provider's
 *  own figure where it gives one (OpenRouter bills the transcription by the
 *  second of audio), the published price of the tokens used otherwise. The
 *  day is worked out here, in the device's own time, so no caller has to
 *  agree with the statistics screen about where a day ends. Never throws:
 *  a bookkeeping failure must not fail the pass that did the work. */
export const recordApiSpend = async ({
  at = Date.now(), provider, service, model = null, episodeId = null, episodeTitle = null,
  source = null, tokensIn = 0, tokensCached = 0, tokensOut = 0, audioSeconds = null, cost = 0,
}) => {
  if (!provider || !service) return;
  try {
    const db = await openDatabaseContext();
    await db.runAsync(
      `INSERT INTO ApiSpend (at, day, provider, service, model, episode_id, episode_title, source,
                             tokens_in, tokens_cached, tokens_out, audio_seconds, cost_usd)
       VALUES (?, strftime('%Y-%m-%d', ? / 1000, 'unixepoch', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [at, at, provider, service, model, episodeId, episodeTitle, source,
       Math.round(tokensIn) || 0, Math.round(tokensCached) || 0, Math.round(tokensOut) || 0,
       audioSeconds == null ? null : Number(audioSeconds), Number(cost) || 0]
    );
  } catch (_) {}
};

/** Every paid request, newest first. A handful a week at most. */
export const getApiSpend = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(`SELECT * FROM ApiSpend ORDER BY at DESC`);
};

/** The assistant runs made before the ledger existed: the model that wrote
 *  them and the length of the episode are all that is left to price them by
 *  (services/aiService.estimateEpisodeDollars does the arithmetic). */
export const getEstimatedAssistantRuns = async (since) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `SELECT e.id AS episode_id, e.title AS episode_title, e.podcast_title AS source,
            e.ai_model AS model, e.ai_indexed_at AS at, COALESCE(e.duration, 0) AS duration,
            strftime('%Y-%m-%d', e.ai_indexed_at / 1000, 'unixepoch', 'localtime') AS day
       FROM Episodes e
      WHERE e.ai_indexed_at IS NOT NULL AND e.ai_indexed_at < ?
      ORDER BY e.ai_indexed_at DESC`,
    [since]
  );
};
