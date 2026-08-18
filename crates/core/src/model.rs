use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
    Url,
    Query,
    LocalPath,
    Unsupported,
}

impl InputKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            InputKind::Url => "url",
            InputKind::Query => "query",
            InputKind::LocalPath => "local_path",
            InputKind::Unsupported => "unsupported",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "url" => InputKind::Url,
            "query" => InputKind::Query,
            "local_path" => InputKind::LocalPath,
            _ => InputKind::Unsupported,
        }
    }
}

/// FR-003: an immutable record produced by the ingest router for a single
/// pasted line, dropped path, or dropped URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputRecord {
    pub id: Uuid,
    pub raw_value: String,
    pub kind: InputKind,
    pub provider_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub provenance: String,
    pub parse_status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Waiting,
    Resolving,
    AwaitingConfirmation,
    Downloading,
    Converting,
    Tagging,
    Organizing,
    Complete,
    Paused,
    Cancelled,
    Failed,
}

impl JobState {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobState::Waiting => "waiting",
            JobState::Resolving => "resolving",
            JobState::AwaitingConfirmation => "awaiting_confirmation",
            JobState::Downloading => "downloading",
            JobState::Converting => "converting",
            JobState::Tagging => "tagging",
            JobState::Organizing => "organizing",
            JobState::Complete => "complete",
            JobState::Paused => "paused",
            JobState::Cancelled => "cancelled",
            JobState::Failed => "failed",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "resolving" => JobState::Resolving,
            "awaiting_confirmation" => JobState::AwaitingConfirmation,
            "downloading" => JobState::Downloading,
            "converting" => JobState::Converting,
            "tagging" => JobState::Tagging,
            "organizing" => JobState::Organizing,
            "complete" => JobState::Complete,
            "paused" => JobState::Paused,
            "cancelled" => JobState::Cancelled,
            "failed" => JobState::Failed,
            _ => JobState::Waiting,
        }
    }

    /// FR-012: which states allow which user actions. Keeps the state
    /// machine centralized instead of scattered across UI and commands.
    pub fn can_pause(&self) -> bool {
        matches!(
            self,
            JobState::Waiting | JobState::Resolving | JobState::Downloading | JobState::Converting
        )
    }

    pub fn can_resume(&self) -> bool {
        matches!(self, JobState::Paused)
    }

    pub fn can_cancel(&self) -> bool {
        !matches!(self, JobState::Complete | JobState::Cancelled)
    }

    pub fn can_retry(&self) -> bool {
        matches!(self, JobState::Failed | JobState::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: Uuid,
    pub input_id: Uuid,
    pub candidate_id: Option<Uuid>,
    pub state: JobState,
    pub progress: f32,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub provider_id: Option<String>,
    pub requested_format: Option<String>,
    pub destination: Option<String>,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub id: Uuid,
    pub path: String,
    pub checksum: String,
    pub codec: Option<String>,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub duration_ms: Option<u64>,
    pub tags_json: String,
    pub artwork_present: bool,
    pub scanned_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationState {
    Prepared,
    BackedUp,
    Applied,
    RestoredFromBackup,
    Failed,
}

impl MutationState {
    pub fn as_str(&self) -> &'static str {
        match self {
            MutationState::Prepared => "prepared",
            MutationState::BackedUp => "backed_up",
            MutationState::Applied => "applied",
            MutationState::RestoredFromBackup => "restored_from_backup",
            MutationState::Failed => "failed",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "backed_up" => MutationState::BackedUp,
            "applied" => MutationState::Applied,
            "restored_from_backup" => MutationState::RestoredFromBackup,
            "failed" => MutationState::Failed,
            _ => MutationState::Prepared,
        }
    }
}

/// FR-036: a durable restore record for every file mutation OpenDJ performs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationJournal {
    pub id: Uuid,
    pub job_id: Option<Uuid>,
    pub original_path: String,
    pub backup_path: String,
    pub original_checksum: String,
    pub replacement_checksum: Option<String>,
    pub state: MutationState,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub download_root: String,
    pub folder_template: String,
    pub quality_policy: String,
    pub concurrency_network: u32,
    pub concurrency_file_mutation: u32,
    pub analytics_opt_in: bool,
    pub lawful_use_acknowledged: bool,
    /// Browser to pull YouTube auth cookies from ("safari", "chrome",
    /// "firefox", "edge", "brave"), empty for none. YouTube's bot-check can
    /// block yt-dlp entirely (even plain metadata lookups) once triggered;
    /// authenticating as a real browser session is the documented fix.
    /// `#[serde(default)]` so settings saved before this field existed
    /// still deserialize.
    #[serde(default)]
    pub youtube_cookies_browser: String,
    /// Path to a manually-exported `cookies.txt` file, empty for none.
    /// Takes priority over `youtube_cookies_browser` when both are set —
    /// a static file doesn't race with the browser's own cookie rotation
    /// the way live extraction can, so it's the more reliable option once
    /// browser-cookie extraction has proven flaky.
    #[serde(default)]
    pub youtube_cookies_file: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_root: String::new(),
            folder_template: "{artist}/{album}/{title}".to_string(),
            quality_policy: "best_permitted".to_string(),
            concurrency_network: 6,
            concurrency_file_mutation: 1,
            analytics_opt_in: false,
            lawful_use_acknowledged: false,
            youtube_cookies_browser: String::new(),
            youtube_cookies_file: String::new(),
        }
    }
}
