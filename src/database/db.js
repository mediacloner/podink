import SQLite from 'react-native-sqlite-storage';

SQLite.enablePromise(true);

const database_name = "Podink.db";
const database_version = "1.0";
const database_displayname = "Podink Offline Database";
const database_size = 200000;

export const openDatabaseContext = async () => {
  console.log("Opening SQLite Database");
  const db = await SQLite.openDatabase(
    database_name,
    database_version,
    database_displayname,
    database_size
  );
  return db;
};

export const initDB = async () => {
    const db = await openDatabaseContext();
    
    // Create Episodes table
    await db.executeSql(
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
    await db.executeSql(
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
    await db.executeSql(
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
