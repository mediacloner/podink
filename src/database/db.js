import * as SQLite from 'expo-sqlite';

let _db = null;
let _dbPromise = null;

const SCHEMA_VERSION = 3;

export const openDatabaseContext = () => {
    if (_db) return Promise.resolve(_db);
    if (!_dbPromise) {
        console.log('Opening SQLite Database');
        _dbPromise = SQLite.openDatabaseAsync('Podink.db').then(async (db) => {
            // Must run outside any transaction: journal_mode cannot change
            // inside a txn and foreign_keys is a silent no-op inside one.
            await db.execAsync('PRAGMA journal_mode = WAL;');
            await db.execAsync('PRAGMA foreign_keys = ON;');
            _db = db;
            return db;
        }).catch((e) => {
            // Don't cache a rejected promise forever (a transient I/O / low-disk
            // failure would otherwise leave the app DB-dead until restart). Clear
            // so the next call retries the open.
            _dbPromise = null;
            throw e;
        });
    }
    return _dbPromise;
};

// v1 = pre-2.0 baseline, made idempotent so fresh installs and legacy DBs
// (both report user_version 0) converge on the same schema.
const migrateToV1 = async (txn) => {
    await txn.execAsync(
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

    await txn.execAsync(
        `CREATE TABLE IF NOT EXISTS Podcasts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            description TEXT,
            feed_url TEXT UNIQUE,
            image_url TEXT,
            subscribed_at TEXT
        );`
    );

    const cols = await txn.getAllAsync(`PRAGMA table_info(Episodes)`);
    if (!cols.some(c => c.name === 'is_new')) {
        await txn.execAsync(`ALTER TABLE Episodes ADD COLUMN is_new INTEGER DEFAULT 0`);
    }
    if (!cols.some(c => c.name === 'duration')) {
        await txn.execAsync(`ALTER TABLE Episodes ADD COLUMN duration INTEGER DEFAULT 0`);
    }

    await txn.execAsync(
        `CREATE TABLE IF NOT EXISTS Transcripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            episode_id TEXT,
            start_time INTEGER,
            end_time INTEGER,
            text TEXT,
            FOREIGN KEY (episode_id) REFERENCES Episodes(id) ON DELETE CASCADE
        );`
    );
};

const migrateToV2 = async (txn) => {
    // One-time orphan sweep; must precede the FTS backfill so orphans never
    // enter the index, and the dedupe must precede the UNIQUE index because
    // historic incremental saves were blind INSERTs.
    // NULL-safe: a plain `NOT IN (subquery containing NULL)` is NULL for every
    // row, so the whole sweep would no-op the moment any guid-less episode
    // exists. NOT EXISTS handles NULLs and also removes NULL-episode_id orphans.
    await txn.execAsync(
        `DELETE FROM Transcripts
         WHERE NOT EXISTS (SELECT 1 FROM Episodes e WHERE e.id = Transcripts.episode_id)`
    );
    await txn.execAsync(
        `DELETE FROM Transcripts WHERE id NOT IN (
            SELECT MIN(id) FROM Transcripts GROUP BY episode_id, start_time, end_time
        )`
    );

    // idx_transcripts_episode is intentionally NOT created — it is an exact
    // left-prefix of the UNIQUE idx_transcripts_window below, so it serves no
    // query and only doubles index-maintenance writes on the hot transcript
    // insert path. v3 drops it for any device that already created it.
    // Makes window re-saves idempotent (saves use INSERT OR IGNORE).
    await txn.execAsync(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_window
         ON Transcripts(episode_id, start_time, end_time)`
    );

    await txn.execAsync(
        `CREATE TABLE IF NOT EXISTS VocabWords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT NOT NULL,
            normalized TEXT NOT NULL UNIQUE,
            translation TEXT,
            definition TEXT,
            language TEXT,
            episode_id TEXT,
            episode_title TEXT,
            context_text TEXT,
            word_start_ms INTEGER,
            created_at TEXT,
            lookup_count INTEGER DEFAULT 1
        );`
    );

    await txn.execAsync(
        `CREATE TABLE IF NOT EXISTS LookupHistory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT,
            normalized TEXT,
            episode_id TEXT,
            looked_up_at TEXT
        );`
    );
    await txn.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_lookup_history_normalized
         ON LookupHistory(normalized)`
    );

    // External-content FTS5: backfill BEFORE creating the delete trigger so
    // the index and content table can never disagree.
    await txn.execAsync(
        `CREATE VIRTUAL TABLE IF NOT EXISTS TranscriptsFTS
         USING fts5(text, content='Transcripts', content_rowid='id')`
    );
    await txn.execAsync(
        `INSERT INTO TranscriptsFTS(rowid, text) SELECT id, text FROM Transcripts`
    );
    await txn.execAsync(
        `CREATE TRIGGER IF NOT EXISTS transcripts_fts_ai AFTER INSERT ON Transcripts BEGIN
            INSERT INTO TranscriptsFTS(rowid, text) VALUES (new.id, new.text);
        END;`
    );
    await txn.execAsync(
        `CREATE TRIGGER IF NOT EXISTS transcripts_fts_ad AFTER DELETE ON Transcripts BEGIN
            INSERT INTO TranscriptsFTS(TranscriptsFTS, rowid, text) VALUES ('delete', old.id, old.text);
        END;`
    );
};

const migrateToV3 = async (txn) => {
    // Drop the redundant idx_transcripts_episode (left-prefix of the UNIQUE
    // idx_transcripts_window) on devices that ran v2 and created it.
    await txn.execAsync(`DROP INDEX IF EXISTS idx_transcripts_episode`);
    // Clean up NULL-primary-key episode rows accumulated from guid-less feeds
    // (and their transcripts) so prune/cap queries and keyExtractor recover.
    await txn.execAsync(`DELETE FROM Transcripts WHERE episode_id IS NULL`);
    await txn.execAsync(
        `DELETE FROM Transcripts
         WHERE NOT EXISTS (SELECT 1 FROM Episodes e WHERE e.id = Transcripts.episode_id)`
    );
    await txn.execAsync(`DELETE FROM Episodes WHERE id IS NULL`);
};

export const initDB = async () => {
    const db = await openDatabaseContext();

    const row = await db.getFirstAsync('PRAGMA user_version');
    if ((row?.user_version ?? 0) >= SCHEMA_VERSION) return db;

    // Single-connection migration: App gates first render on initDB, so no
    // other queries can interleave. withExclusiveTransactionAsync is avoided
    // deliberately — its separate connection's close path crashes natively
    // (double-free in expo-sqlite 55 closeDatabase, verified on device).
    // user_version is transactional: version bump, DDL and backfills commit
    // atomically.
    await db.execAsync('BEGIN IMMEDIATE');
    try {
        const cur = (await db.getFirstAsync('PRAGMA user_version'))?.user_version ?? 0;
        if (cur < 1) await migrateToV1(db);
        if (cur < 2) await migrateToV2(db);
        if (cur < 3) await migrateToV3(db);
        await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        await db.execAsync('COMMIT');
    } catch (e) {
        await db.execAsync('ROLLBACK').catch(() => {});
        throw e;
    }

    return db;
};
