use crate::adapters::{DirectUrlProvider, LocalFileProvider, YtdlpAdapter};
use crate::{ProviderAdapter, ProviderInfo};
use std::sync::Arc;

pub struct ProviderRegistry {
    providers: Vec<Arc<dyn ProviderAdapter>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        let providers: Vec<Arc<dyn ProviderAdapter>> = vec![
            Arc::new(LocalFileProvider),
            Arc::new(YtdlpAdapter::new()),
            Arc::new(DirectUrlProvider::new()),
        ];
        Self { providers }
    }

    pub fn list(&self) -> Vec<ProviderInfo> {
        self.providers
            .iter()
            .map(|p| ProviderInfo {
                id: p.id().to_string(),
                display_name: p.display_name().to_string(),
                capabilities: p.capabilities(),
                policy_status: p.policy_status(),
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.providers.iter().find(|p| p.id() == id).cloned()
    }

    /// Broadcast a YouTube cookies setting change to every adapter (only
    /// the yt-dlp adapter acts on either — see its trait overrides).
    pub fn set_cookies_browser(&self, browser: Option<String>) {
        for p in &self.providers {
            p.set_cookies_browser(browser.clone());
        }
    }

    pub fn set_cookies_file(&self, file: Option<String>) {
        for p in &self.providers {
            p.set_cookies_file(file.clone());
        }
    }

    /// Best-effort match for a raw input string, used when an input record
    /// doesn't already carry a provider guess from the ingest router.
    /// Local files are checked first (more specific), then yt-dlp (catches
    /// all URLs), then direct URL (audio file links).
    pub fn detect_for(&self, raw: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.providers
            .iter()
            .find(|p| p.validate_input(raw))
            .cloned()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_provider_from_raw_url() {
        let registry = ProviderRegistry::new();
        let p = registry
            .detect_for("https://soundcloud.com/artist/track")
            .unwrap();
        assert_eq!(p.id(), "ytdlp");
    }

    #[test]
    fn detects_local_file() {
        let registry = ProviderRegistry::new();
        // Create a temp file to test local file detection
        let dir = std::env::temp_dir();
        let file = dir.join("opendj_test_detect.mp3");
        std::fs::write(&file, b"fake").ok();
        let path_str = file.to_string_lossy().to_string();
        let p = registry.detect_for(&path_str);
        assert!(p.is_some());
        assert_eq!(p.unwrap().id(), "local_file");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn list_includes_all_providers() {
        let registry = ProviderRegistry::new();
        let ids: Vec<_> = registry.list().into_iter().map(|p| p.id).collect();
        assert!(ids.contains(&"local_file".to_string()));
        assert!(ids.contains(&"ytdlp".to_string()));
        assert!(ids.contains(&"direct_url".to_string()));
    }
}
