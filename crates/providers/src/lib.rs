pub mod adapters;
pub mod playlist;
mod registry;
pub mod yt_dlp_bin;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub metadata: bool,
    pub download: bool,
}

/// FR-021: registry-reported status shown in the Provider workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyStatus {
    /// Downloads are permitted, subject to a per-request authorization
    /// check (see PROVIDER_POLICY.md).
    Permitted,
    /// This provider only ever resolves metadata/links; it never downloads
    /// audio, by design and by code (see individual adapters).
    MetadataOnly,
    /// Missing required credentials (e.g. an API client id).
    NotConfigured,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackCandidate {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub provider: String,
    pub source_url: String,
    pub confidence: f32,
    /// Whether the *source itself* currently reports this specific track as
    /// downloadable (e.g. SoundCloud's per-track flag). Distinct from the
    /// provider's general `capabilities().download` — PROVIDER_POLICY.md
    /// requires adapters to check this per request, not just at
    /// registration time.
    pub downloadable: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not supported by provider {0}: audio download is metadata-only for this source")]
    NotSupported(&'static str),
    #[error("provider not configured: missing {0}")]
    NotConfigured(&'static str),
    #[error("no match found for input")]
    NoMatch,
    #[error("track is not marked downloadable by the source")]
    NotDownloadable,
    #[error("input not recognized by this provider")]
    InputNotRecognized,
}

pub type Result<T> = std::result::Result<T, ProviderError>;

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;
    fn policy_status(&self) -> PolicyStatus;
    fn validate_input(&self, raw: &str) -> bool;
    async fn resolve_metadata(&self, raw: &str) -> Result<Vec<TrackCandidate>>;

    /// Default: not supported. Adapters with a real, policy-permitted
    /// download path override this explicitly.
    async fn fetch(&self, candidate: &TrackCandidate, dest_dir: &Path) -> Result<PathBuf> {
        let _ = (candidate, dest_dir);
        Err(ProviderError::NotSupported(self.id()))
    }

    /// FR-050: free-text artist/title search, distinct from
    /// `resolve_metadata` (which resolves a specific URL/path). Not every
    /// source exposes a text-search API without deeper integration; the
    /// default reflects that rather than guessing.
    async fn search(&self, query: &str) -> Result<Vec<TrackCandidate>> {
        let _ = query;
        Err(ProviderError::NotSupported(self.id()))
    }

    /// Only meaningful for the yt-dlp adapter (see its override) — a no-op
    /// default so `ProviderRegistry` can broadcast a settings change to
    /// every adapter without downcasting the trait object.
    fn set_cookies_browser(&self, _browser: Option<String>) {}

    /// Static `cookies.txt` path, an alternative to `set_cookies_browser`
    /// that takes priority when both are set (see the yt-dlp adapter for
    /// why). Same no-op-default pattern.
    fn set_cookies_file(&self, _file: Option<String>) {}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    pub capabilities: Capabilities,
    pub policy_status: PolicyStatus,
}

pub use registry::ProviderRegistry;
