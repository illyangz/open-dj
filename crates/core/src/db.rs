use rusqlite::Connection;

/// FR-013: queue and journal persistence. Schema is applied idempotently so
/// startup is safe to run against an existing database.
pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS inputs (
            id              TEXT PRIMARY KEY,
            raw_value       TEXT NOT NULL,
            kind            TEXT NOT NULL,
            provider_id     TEXT,
            created_at      TEXT NOT NULL,
            provenance      TEXT NOT NULL,
            parse_status    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id                  TEXT PRIMARY KEY,
            input_id            TEXT NOT NULL REFERENCES inputs(id),
            candidate_id        TEXT,
            state               TEXT NOT NULL,
            progress            REAL NOT NULL DEFAULT 0,
            title               TEXT,
            artist              TEXT,
            provider_id         TEXT,
            requested_format    TEXT,
            destination         TEXT,
            error_class         TEXT,
            error_message       TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
        CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);
        CREATE INDEX IF NOT EXISTS idx_inputs_created_at ON inputs(created_at);

        CREATE TABLE IF NOT EXISTS file_records (
            id                  TEXT PRIMARY KEY,
            path                TEXT NOT NULL UNIQUE,
            checksum            TEXT NOT NULL,
            codec               TEXT,
            bitrate_kbps        INTEGER,
            sample_rate_hz      INTEGER,
            duration_ms         INTEGER,
            tags_json           TEXT NOT NULL,
            artwork_present     INTEGER NOT NULL,
            scanned_at          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS mutation_journal (
            id                      TEXT PRIMARY KEY,
            job_id                  TEXT,
            original_path           TEXT NOT NULL,
            backup_path             TEXT NOT NULL,
            original_checksum       TEXT NOT NULL,
            replacement_checksum    TEXT,
            state                   TEXT NOT NULL,
            created_at              TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key     TEXT PRIMARY KEY,
            value   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS provider_config (
            provider_id     TEXT PRIMARY KEY,
            enabled         INTEGER NOT NULL DEFAULT 1,
            config_json     TEXT NOT NULL DEFAULT '{}'
        );

        -- Hot cues and crates key off the track's own file path rather than
        -- a job id: a track's DJ-relevant identity is the audio file on
        -- disk, and not every track a user has necessarily arrived via a
        -- download job (folder-scanned library tracks have no job at all).
        CREATE TABLE IF NOT EXISTS cue_points (
            id              TEXT PRIMARY KEY,
            track_path      TEXT NOT NULL,
            slot            INTEGER NOT NULL,
            position_ms     INTEGER NOT NULL,
            label           TEXT,
            color           TEXT,
            created_at      TEXT NOT NULL,
            UNIQUE(track_path, slot)
        );
        CREATE INDEX IF NOT EXISTS idx_cue_points_track_path ON cue_points(track_path);

        CREATE TABLE IF NOT EXISTS crates (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS crate_tracks (
            crate_id        TEXT NOT NULL REFERENCES crates(id),
            track_path      TEXT NOT NULL,
            position         INTEGER NOT NULL,
            PRIMARY KEY (crate_id, track_path)
        );
        CREATE INDEX IF NOT EXISTS idx_crate_tracks_crate_id ON crate_tracks(crate_id);
        "#,
    )
}
