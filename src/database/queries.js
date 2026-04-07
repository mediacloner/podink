import { openDatabaseContext } from './db';

const byDateDesc = (a, b) => new Date(b.release_date) - new Date(a.release_date);

const EPISODE_WITH_IMAGE = `
  SELECT e.*, p.image_url
  FROM Episodes e
  LEFT JOIN Podcasts p ON p.feed_url = e.podcast_feed_url
`;

export const getDownloadedEpisodes = async () => {
  const db = await openDatabaseContext();
  const rows = await db.getAllAsync(`${EPISODE_WITH_IMAGE} WHERE e.is_downloaded = 1`);
  return rows.sort(byDateDesc);
};

export const getSubscribedEpisodes = async () => {
  const db = await openDatabaseContext();
  const rows = await db.getAllAsync(EPISODE_WITH_IMAGE);
  return rows.sort(byDateDesc);
};

export const saveEpisode = async (episode) => {
  const db = await openDatabaseContext();
  // INSERT OR IGNORE preserves is_new, is_downloaded, local_audio_path, etc. for existing episodes
  await db.runAsync(
    `INSERT OR IGNORE INTO Episodes (id, title, description, podcast_title, podcast_feed_url, release_date, audio_url, is_downloaded, is_new, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      episode.id,
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
  await db.runAsync('DELETE FROM Podcasts WHERE feed_url = ?', [feedUrl]);
  await db.runAsync('DELETE FROM Episodes WHERE podcast_feed_url = ?', [feedUrl]);
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
  await db.withTransactionAsync(async () => {
    for (const segment of segments) {
      await db.runAsync(
        `INSERT INTO Transcripts (episode_id, start_time, end_time, text) VALUES (?, ?, ?, ?)`,
        [episodeId, segment.start, segment.end, segment.text]
      );
    }
    await db.runAsync(`UPDATE Episodes SET has_transcript = 1 WHERE id = ?`, [episodeId]);
  });
};

/** Insert segments without setting has_transcript flag (used for incremental saves). */
export const saveTranscriptsIncremental = async (episodeId, segments) => {
  if (!segments.length) return;
  const db = await openDatabaseContext();
  await db.withTransactionAsync(async () => {
    for (const segment of segments) {
      await db.runAsync(
        `INSERT INTO Transcripts (episode_id, start_time, end_time, text) VALUES (?, ?, ?, ?)`,
        [episodeId, segment.start, segment.end, segment.text]
      );
    }
  });
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
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM Transcripts WHERE episode_id = ?`, [id]);
    await db.runAsync(`UPDATE Episodes SET has_transcript = 0 WHERE id = ?`, [id]);
  });
};

export const deleteEpisodeLocalData = async (id) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `UPDATE Episodes SET local_audio_path = NULL, is_downloaded = 0, has_transcript = 0 WHERE id = ?`,
    [id]
  );
  await db.runAsync(`DELETE FROM Transcripts WHERE episode_id = ?`, [id]);
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
