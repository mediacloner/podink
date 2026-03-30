import * as SQLite from 'expo-sqlite';

let _db = null;
let _dbPromise = null;

export const openDatabaseContext = () => {
  if (_db) return Promise.resolve(_db);
  if (!_dbPromise) {
    console.log("Opening SQLite Database");
    _dbPromise = SQLite.openDatabaseAsync('Podink.db').then(db => {
      _db = db;
      return db;
    });
  }
  return _dbPromise;
};

export const initDB = async () => {
    const db = await openDatabaseContext();
    
    // Create Episodes table
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS Episodes (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        podcast_title TEXT,
        podcast_feed_url TEXT,
        release_date TEXT,
        audio_url TEXT,
        local_audio_path TEXT,
        is_downloaded INTEGER DEFAULT 0,
        has_transcript INTEGER DEFAULT 0,
        play_position INTEGER DEFAULT 0
      );`
    );

    // Podcasts table to track subscribed feeds
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS Podcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        description TEXT,
        feed_url TEXT UNIQUE,
        image_url TEXT,
        subscribed_at TEXT
      );`
    );

    // Create Transcripts table (segments of an episode)
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS Transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id TEXT,
        start_time INTEGER,
        end_time INTEGER,
        text TEXT,
        FOREIGN KEY (episode_id) REFERENCES Episodes(id) ON DELETE CASCADE
      );`
    );

    return db;
};
