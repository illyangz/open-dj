use crate::{Capabilities, PolicyStatus, ProviderAdapter, ProviderError, Result, TrackCandidate};
use async_trait::async_trait;
use std::path::Path;

/// Represents inputs that are already local files (FR-002). Deep tag/codec
/// inspection for these lives in `opendj-metadata` + `opendj-file-ops`, used
/// directly by the Repair workspace commands — this adapter exists so the
/// provider registry and Queue workspace can classify and display local
/// inputs consistently with network providers.
pub struct LocalFileProvider;

#[async_trait]
impl ProviderAdapter for LocalFileProvider {
    fn id(&self) -> &'static str {
        "local_file"
    }

    fn display_name(&self) -> &'static str {
        "Local files"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            metadata: true,
            download: false,
        }
    }

    fn policy_status(&self) -> PolicyStatus {
        PolicyStatus::Permitted
    }

    fn validate_input(&self, raw: &str) -> bool {
        Path::new(raw).is_absolute() && Path::new(raw).exists()
    }

    async fn resolve_metadata(&self, raw: &str) -> Result<Vec<TrackCandidate>> {
        let path = Path::new(raw);
        if !path.exists() {
            return Err(ProviderError::NoMatch);
        }
        let title = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.to_string());
        Ok(vec![TrackCandidate {
            id: raw.to_string(),
            title,
            artist: None,
            album: None,
            duration_ms: None,
            provider: self.id().to_string(),
            source_url: raw.to_string(),
            confidence: 1.0,
            downloadable: false,
        }])
    }
}
