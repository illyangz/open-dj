use crate::error::{CoreError, Result};
use crate::model::{
    InputKind, InputRecord, Job, JobState, MutationJournal, MutationState, Settings,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// FR-013/FR-014: durable queue store. Wraps a single SQLite connection
/// behind a mutex — the job engine's concurrency limits are enforced by the
/// async scheduler above this layer, not by the store, so a coarse lock here
/// is not a bottleneck for the volumes this app targets (hundreds of jobs).
#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    pub fn insert_input(&self, input: &InputRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO inputs (id, raw_value, kind, provider_id, created_at, provenance, parse_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                input.id.to_string(),
                input.raw_value,
                input.kind.as_str(),
                input.provider_id,
                input.created_at.to_rfc3339(),
                input.provenance,
                input.parse_status,
            ],
        )?;
        Ok(())
    }

    pub fn get_input(&self, id: Uuid) -> Result<InputRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, raw_value, kind, provider_id, created_at, provenance, parse_status
             FROM inputs WHERE id = ?1",
        )?;
        stmt.query_row(params![id.to_string()], row_to_input)
            .optional()?
            .ok_or(CoreError::InputNotFound(id))
    }

    /// Creates a job in `Waiting` state for a previously-inserted input.
    pub fn create_job(&self, input_id: Uuid, provider_id: Option<&str>) -> Result<Job> {
        let now = Utc::now();
        let job = Job {
            id: Uuid::new_v4(),
            input_id,
            candidate_id: None,
            state: JobState::Waiting,
            progress: 0.0,
            title: None,
            artist: None,
            provider_id: provider_id.map(|s| s.to_string()),
            requested_format: None,
            destination: None,
            error_class: None,
            error_message: None,
            created_at: now,
            updated_at: now,
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO jobs (id, input_id, candidate_id, state, progress, title, artist,
                provider_id, requested_format, destination, error_class, error_message,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                job.id.to_string(),
                job.input_id.to_string(),
                job.candidate_id.map(|u| u.to_string()),
                job.state.as_str(),
                job.progress,
                job.title,
                job.artist,
                job.provider_id,
                job.requested_format,
                job.destination,
                job.error_class,
                job.error_message,
                job.created_at.to_rfc3339(),
                job.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(job)
    }

    pub fn list_jobs(&self) -> Result<Vec<Job>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, input_id, candidate_id, state, progress, title, artist, provider_id,
                    requested_format, destination, error_class, error_message, created_at, updated_at
             FROM jobs ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_job)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Permanently remove a job (and its input record) from the queue.
    /// Distinct from `cancel_job`, which just marks a job cancelled but
    /// keeps it visible — this is for clearing debris (e.g. old failed
    /// jobs) out of the list entirely.
    pub fn delete_job(&self, id: Uuid) -> Result<()> {
        let job = self.get_job(id)?;
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM jobs WHERE id = ?1", params![id.to_string()])?;
        conn.execute(
            "DELETE FROM inputs WHERE id = ?1",
            params![job.input_id.to_string()],
        )?;
        Ok(())
    }

    pub fn get_job(&self, id: Uuid) -> Result<Job> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, input_id, candidate_id, state, progress, title, artist, provider_id,
                    requested_format, destination, error_class, error_message, created_at, updated_at
             FROM jobs WHERE id = ?1",
        )?;
        stmt.query_row(params![id.to_string()], row_to_job)
            .optional()?
            .ok_or(CoreError::JobNotFound(id))
    }

    fn apply_transition(
        &self,
        id: Uuid,
        next: JobState,
        guard: impl Fn(&JobState) -> bool,
        action: &'static str,
    ) -> Result<Job> {
        let mut job = self.get_job(id)?;
        if !guard(&job.state) {
            return Err(CoreError::InvalidTransition(
                job.state.as_str().to_string(),
                action,
            ));
        }
        job.state = next;
        job.updated_at = Utc::now();
        self.save_job(&job)?;
        Ok(job)
    }

    pub fn pause_job(&self, id: Uuid) -> Result<Job> {
        self.apply_transition(id, JobState::Paused, JobState::can_pause, "pause")
    }

    pub fn resume_job(&self, id: Uuid) -> Result<Job> {
        self.apply_transition(id, JobState::Waiting, JobState::can_resume, "resume")
    }

    pub fn cancel_job(&self, id: Uuid) -> Result<Job> {
        self.apply_transition(id, JobState::Cancelled, JobState::can_cancel, "cancel")
    }

    /// FR-015: retries never resurrect a job the user explicitly cancelled
    /// unless they explicitly retry it (an intentional user action, distinct
    /// from automatic backoff retries which only apply to `Failed`).
    pub fn retry_job(&self, id: Uuid) -> Result<Job> {
        let mut job = self.get_job(id)?;
        if !JobState::can_retry(&job.state) {
            return Err(CoreError::InvalidTransition(
                job.state.as_str().to_string(),
                "retry",
            ));
        }
        job.state = JobState::Waiting;
        // Clear the previous failure — carrying it forward made a job that
        // succeeded on retry still show its old error in the inspector,
        // which read as "it worked but didn't really" even though it did.
        job.error_class = None;
        job.error_message = None;
        job.updated_at = Utc::now();
        self.save_job(&job)?;
        Ok(job)
    }

    pub fn set_progress(&self, id: Uuid, state: JobState, progress: f32) -> Result<()> {
        let mut job = self.get_job(id)?;
        job.state = state;
        job.progress = progress.clamp(0.0, 1.0);
        job.updated_at = Utc::now();
        self.save_job(&job)
    }

    pub fn fail_job(&self, id: Uuid, error_class: &str, message: &str) -> Result<()> {
        let mut job = self.get_job(id)?;
        job.state = JobState::Failed;
        job.error_class = Some(error_class.to_string());
        job.error_message = Some(message.to_string());
        job.updated_at = Utc::now();
        self.save_job(&job)
    }

    pub fn get_settings(&self) -> Result<Settings> {
        let conn = self.conn.lock().unwrap();
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'settings'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match value {
            Some(json) => serde_json::from_str(&json)?,
            None => Settings::default(),
        })
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let json = serde_json::to_string(settings)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json],
        )?;
        Ok(())
    }

    /// Provider credentials/config as an opaque JSON blob per provider id.
    /// NOTE: this is plaintext in the local SQLite file, not OS secure
    /// storage (NFR "Security" in product-requirements.md §8 calls for
    /// OS-keychain-backed storage) — tracked as a known gap, not shipped as
    /// if it were solved.
    pub fn get_provider_config(&self, provider_id: &str) -> Result<Option<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let value: Option<String> = conn
            .query_row(
                "SELECT config_json FROM provider_config WHERE provider_id = ?1",
                params![provider_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match value {
            Some(json) => Some(serde_json::from_str(&json)?),
            None => None,
        })
    }

    pub fn set_provider_config(&self, provider_id: &str, config: &serde_json::Value) -> Result<()> {
        let json = serde_json::to_string(config)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO provider_config (provider_id, enabled, config_json) VALUES (?1, 1, ?2)
             ON CONFLICT(provider_id) DO UPDATE SET config_json = excluded.config_json",
            params![provider_id, json],
        )?;
        Ok(())
    }

    pub fn insert_mutation_journal(&self, journal: &MutationJournal) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO mutation_journal (id, job_id, original_path, backup_path,
                original_checksum, replacement_checksum, state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                journal.id.to_string(),
                journal.job_id.map(|u| u.to_string()),
                journal.original_path,
                journal.backup_path,
                journal.original_checksum,
                journal.replacement_checksum,
                journal.state.as_str(),
                journal.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn list_mutation_journal(&self) -> Result<Vec<MutationJournal>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, job_id, original_path, backup_path, original_checksum,
                    replacement_checksum, state, created_at
             FROM mutation_journal ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_journal)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_mutation_journal(&self, id: Uuid) -> Result<MutationJournal> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, job_id, original_path, backup_path, original_checksum,
                    replacement_checksum, state, created_at
             FROM mutation_journal WHERE id = ?1",
        )?;
        stmt.query_row(params![id.to_string()], row_to_journal)
            .optional()?
            .ok_or_else(|| CoreError::InvalidTransition("mutation".to_string(), "find"))
    }

    pub fn set_mutation_state(&self, id: Uuid, state: MutationState) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE mutation_journal SET state = ?2 WHERE id = ?1",
            params![id.to_string(), state.as_str()],
        )?;
        Ok(())
    }

    pub fn save_job(&self, job: &Job) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET candidate_id=?2, state=?3, progress=?4, title=?5, artist=?6,
                provider_id=?7, requested_format=?8, destination=?9, error_class=?10,
                error_message=?11, updated_at=?12 WHERE id=?1",
            params![
                job.id.to_string(),
                job.candidate_id.map(|u| u.to_string()),
                job.state.as_str(),
                job.progress,
                job.title,
                job.artist,
                job.provider_id,
                job.requested_format,
                job.destination,
                job.error_class,
                job.error_message,
                job.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }
}

fn row_to_input(row: &rusqlite::Row) -> rusqlite::Result<InputRecord> {
    let id: String = row.get(0)?;
    let kind: String = row.get(2)?;
    let created_at: String = row.get(4)?;
    Ok(InputRecord {
        id: Uuid::parse_str(&id).unwrap(),
        raw_value: row.get(1)?,
        kind: InputKind::from_db_str(&kind),
        provider_id: row.get(3)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .unwrap()
            .with_timezone(&Utc),
        provenance: row.get(5)?,
        parse_status: row.get(6)?,
    })
}

fn row_to_journal(row: &rusqlite::Row) -> rusqlite::Result<MutationJournal> {
    let id: String = row.get(0)?;
    let job_id: Option<String> = row.get(1)?;
    let state: String = row.get(6)?;
    let created_at: String = row.get(7)?;
    Ok(MutationJournal {
        id: Uuid::parse_str(&id).unwrap(),
        job_id: job_id.map(|s| Uuid::parse_str(&s).unwrap()),
        original_path: row.get(2)?,
        backup_path: row.get(3)?,
        original_checksum: row.get(4)?,
        replacement_checksum: row.get(5)?,
        state: MutationState::from_db_str(&state),
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .unwrap()
            .with_timezone(&Utc),
    })
}

fn row_to_job(row: &rusqlite::Row) -> rusqlite::Result<Job> {
    let id: String = row.get(0)?;
    let input_id: String = row.get(1)?;
    let candidate_id: Option<String> = row.get(2)?;
    let state: String = row.get(3)?;
    let created_at: String = row.get(12)?;
    let updated_at: String = row.get(13)?;
    Ok(Job {
        id: Uuid::parse_str(&id).unwrap(),
        input_id: Uuid::parse_str(&input_id).unwrap(),
        candidate_id: candidate_id.map(|s| Uuid::parse_str(&s).unwrap()),
        state: JobState::from_db_str(&state),
        progress: row.get(4)?,
        title: row.get(5)?,
        artist: row.get(6)?,
        provider_id: row.get(7)?,
        requested_format: row.get(8)?,
        destination: row.get(9)?,
        error_class: row.get(10)?,
        error_message: row.get(11)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .unwrap()
            .with_timezone(&Utc),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
            .unwrap()
            .with_timezone(&Utc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::ingest::parse_inputs;

    fn store() -> Store {
        Store::new(db::open_in_memory().unwrap())
    }

    #[test]
    fn create_and_list_jobs_round_trips() {
        let store = store();
        let inputs = parse_inputs("Daft Punk - One More Time", "paste");
        store.insert_input(&inputs[0]).unwrap();
        let job = store.create_job(inputs[0].id, Some("spotify")).unwrap();
        assert_eq!(job.state, JobState::Waiting);

        let jobs = store.list_jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, job.id);
    }

    #[test]
    fn pause_resume_cancel_retry_state_machine() {
        let store = store();
        let inputs = parse_inputs("https://example.com/track.mp3", "paste");
        store.insert_input(&inputs[0]).unwrap();
        let job = store.create_job(inputs[0].id, Some("direct_url")).unwrap();

        let paused = store.pause_job(job.id).unwrap();
        assert_eq!(paused.state, JobState::Paused);

        // Cannot pause an already-paused job.
        assert!(store.pause_job(job.id).is_err());

        let resumed = store.resume_job(job.id).unwrap();
        assert_eq!(resumed.state, JobState::Waiting);

        let cancelled = store.cancel_job(job.id).unwrap();
        assert_eq!(cancelled.state, JobState::Cancelled);

        // FR-015: cancelled jobs only move again via an explicit retry.
        let retried = store.retry_job(job.id).unwrap();
        assert_eq!(retried.state, JobState::Waiting);
    }

    #[test]
    fn survives_reopen_by_reusing_the_same_db_file() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("queue.sqlite3");

        {
            let conn = db::open(&db_path).unwrap();
            let store = Store::new(conn);
            let inputs = parse_inputs("Daft Punk - One More Time", "paste");
            store.insert_input(&inputs[0]).unwrap();
            store.create_job(inputs[0].id, None).unwrap();
        }

        // Simulate relaunch: reopen the same file and confirm the job persisted.
        let conn = db::open(&db_path).unwrap();
        let store = Store::new(conn);
        assert_eq!(store.list_jobs().unwrap().len(), 1);
    }
}
