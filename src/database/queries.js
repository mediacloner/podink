import { openDatabaseContext } from './db';

const byDateDesc = (a, b) => new Date(b.release_date) - new Date(a.release_date);

export const getDownloadedEpisodes = async () => {
  const db = await openDatabaseContext();
  const rows = await db.getAllAsync('SELECT * FROM Episodes WHERE is_downloaded = 1');
  return rows.sort(byDateDesc);
};

export const getSubscribedEpisodes = async () => {
  const db = await openDatabaseContext();
  const rows = await db.getAllAsync('SELECT * FROM Episodes');
  return rows.sort(byDateDesc);
};

export const saveEpisode = async (episode) => {
  const db = await openDatabaseContext();
  await db.runAsync(
    `INSERT OR REPLACE INTO Episodes (id, title, description, podcast_title, podcast_feed_url, release_date, audio_url, is_downloaded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      episode.id,
      episode.title,
      episode.description || '',
      episode.podcast_title,
      episode.podcast_feed_url || '',
      episode.release_date,
      episode.audio_url || episode.enclosure,
      episode.is_downloaded ? 1 : 0,
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
  await db.runAsync(
    `UPDATE Episodes SET local_audio_path = NULL, is_downloaded = 0 WHERE podcast_feed_url = ?`,
    [feedUrl]
  );
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

export const getTranscriptsForEpisode = async (episodeId) => {
  const db = await openDatabaseContext();
  return db.getAllAsync(
    'SELECT * FROM Transcripts WHERE episode_id = ? ORDER BY start_time ASC',
    [episodeId]
  );
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

export const getEpisodeById = async (id) => {
  const db = await openDatabaseContext();
  return db.getFirstAsync(
    'SELECT * FROM Episodes WHERE id = ? LIMIT 1',
    [id]
  );
};
