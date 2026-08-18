use crate::{Capabilities, PolicyStatus, ProviderAdapter, ProviderError, Result, TrackCandidate};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "aiff", "m4a", "ogg", "opus"];

/// PROVIDER_POLICY.md: a user-supplied direct link they assert they are
/// authorized to fetch. OpenDJ verifies the response looks like audio; it
/// does not and cannot verify off-platform authorization.
pub struct DirectUrlProvider {
    client: reqwest::Client,
}

impl DirectUrlProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent(concat!("OpenDJ/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("reqwest client"),
        }
    }
}

impl Default for DirectUrlProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn has_audio_extension(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    AUDIO_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

#[async_trait]
impl ProviderAdapter for DirectUrlProvider {
    fn id(&self) -> &'static str {
        "direct_url"
    }

    fn display_name(&self) -> &'static str {
        "Direct URL"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            metadata: true,
            download: true,
        }
    }

    fn policy_status(&self) -> PolicyStatus {
        PolicyStatus::Permitted
    }

    fn validate_input(&self, raw: &str) -> bool {
        let lower = raw.to_ascii_lowercase();
        (lower.starts_with("http://") || lower.starts_with("https://"))
            && has_audio_extension(&lower)
    }

    async fn resolve_metadata(&self, raw: &str) -> Result<Vec<TrackCandidate>> {
        let resp = self.client.head(raw).send().await;
        // HEAD isn't universally supported; a failure here doesn't rule the
        // link out, it just means we can't preview content-type up front.
        let looks_like_audio = match resp {
            Ok(r) => r
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|ct| ct.starts_with("audio/") || ct == "application/octet-stream")
                .unwrap_or(true),
            Err(_) => true,
        };
        if !looks_like_audio && !has_audio_extension(raw) {
            return Err(ProviderError::NoMatch);
        }

        let file_name = Path::new(raw)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.to_string());

        Ok(vec![TrackCandidate {
            id: raw.to_string(),
            title: file_name,
            artist: None,
            album: None,
            duration_ms: None,
            provider: self.id().to_string(),
            source_url: raw.to_string(),
            confidence: 0.6,
            downloadable: true,
        }])
    }

    async fn fetch(&self, candidate: &TrackCandidate, dest_dir: &Path) -> Result<PathBuf> {
        let resp = self.client.get(&candidate.source_url).send().await?;
        let resp = resp.error_for_status()?;
        let bytes = resp.bytes().await?;

        tokio::fs::create_dir_all(dest_dir).await?;
        let file_name = Path::new(&candidate.source_url)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}.audio", candidate.id));
        let dest_path = dest_dir.join(file_name);
        tokio::fs::write(&dest_path, &bytes).await?;
        Ok(dest_path)
    }
}
