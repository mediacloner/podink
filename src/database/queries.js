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

const EPISODE_WITH_IMAGE = `
  SELECT e.*, p.image_url
  FROM Episodes e
  LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
`;

export const getDownloadedEpisodes = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    `${EPISODE_WITH_IMAGE} WHERE e.is_downloaded = 1 ORDER BY e.release_date DESC`
  );
};

export const getSubscribedEpisodes = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync(`${EPISODE_WITH_IMAGE} ORDER BY e.release_date DESC`);
};

// INSERT OR IGNORE preserves is_new, is_downloaded, local_audio_path, etc. for existing episodes
const insertEpisodeRow = (runner, episode) => {
  // A NULL primary key (guid-less feed item) inserts as a distinct NULL row on
  // every refresh (SQLite allows multiple NULLs in a TEXT PRIMARY KEY), poisons
  // NOT IN prune/cap queries, and crashes keyExtractor's id.toString(). Fall
  // back to a stable key (enclosure URL) and skip un-keyable items entirely.
  const id = episode.id ?? episode.audio_url ?? episode.enclosure;
  if (!id) return Promise.resolve();
  return runner.runAsync(
  `INSERT OR IGNORE INTO Episodes (id, title, description, podcast_title, podcast_feed_url, release_date, audio_url, is_downloaded, is_new, duration)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  [
    id,
    episode.title,
    episode.description || '',
    episode.podcast_title,
    episode.podcast_feed_url || '',
    episode.release_date,
    episode.audio_url || episode.enclosure,
    episode.is_downloaded ? 1 : 0,
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

export const getPodcasts = async () => {
  const db = await openDatabaseContext();
  return db.getAllAsync('SELECT * FROM Podcasts ORDER BY subscribed_at DESC');
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

export const updateEpisodeLocalPath = async (id, localPath) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Episodes SET local_audio_path = ?, is_downloaded = 1 WHERE id = ?`,
    [localPath, id]
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

export const getTranscriptsForEpisode = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    'SELECT * FROM Transcripts WHERE episode_id = ? ORDER BY start_time ASC',
    [episodeId]
  );
};

export const deleteEpisodeTranscript = async (id) => {
  const db = await openDatabaseContext();
  await runInTxn(db, async () => {
    await db.runAsync(`DELETE FROM Transcripts WHERE episode_id = ?`, [id]);
    await db.runAsync(`UPDATE Episodes SET has_transcript = 0 WHERE id = ?`, [id]);
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
    await db.runAsync(
      `UPDATE Episodes SET local_audio_path = NULL, is_downloaded = 0, has_transcript = 0 WHERE id = ?`,
      [id]
    );
  });
};

export const savePlayPosition = async (id, positionSeconds) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Episodes SET play_position = ? WHERE id = ?`,
    [positionSeconds, id]
  );
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
    SELECT e.*, p.image_url
    FROM Episodes e
    LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
    WHERE e.podcast_feed_url = ?
    ORDER BY e.release_date DESC
    LIMIT ?
  `, [feedUrl, limit]);
};

export const markPodcastEpisodesAsSeen = async (feedUrl) => {
  const db = await openDatabaseContext();
  await db.runAsync('UPDATE Episodes SET is_new = 0 WHERE podcast_feed_url = ?', [feedUrl]);
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

export const pruneOldEpisodesForPodcast = async (feedUrl, maxKeep) => {
  const db = await openDatabaseContext();
  await db.runAsync(`
    DELETE FROM Episodes
    WHERE podcast_feed_url = ?
      AND is_downloaded = 0
      AND has_transcript = 0
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
