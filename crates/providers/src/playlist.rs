use crate::yt_dlp_bin;
use serde::Deserialize;

/// A single entry from a playlist/album resolved by yt-dlp.
#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistEntry {
    pub url: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub duration_ms: Option<u64>,
    pub index: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum PlaylistError {
    #[error("yt-dlp not found: {0}")]
    BinaryNotFound(String),
    #[error("yt-dlp failed: {0}")]
    YtdlpFailed(String),
    #[error("failed to parse yt-dlp output: {0}")]
    ParseError(String),
}

/// Check if a URL looks like a playlist or album (vs a single track).
/// Uses yt-dlp's `--flat-playlist --dump-json` to resolve entries.
/// Returns a vec of entries — single tracks return one entry, playlists
/// return multiple.
pub async fn expand_playlist(url: &str) -> std::result::Result<Vec<PlaylistEntry>, PlaylistError> {
    let ytdlp = yt_dlp_bin::find_ytdlp().ok_or_else(|| {
        PlaylistError::BinaryNotFound("yt-dlp not found. Install with: brew install yt-dlp".into())
    })?;

    let output = tokio::process::Command::new(&ytdlp)
        .args([
            "--flat-playlist",
            "--dump-json",
            "--no-download",
            "--no-warnings",
            url,
        ])
        .env("PATH", yt_dlp_bin::augmented_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| PlaylistError::YtdlpFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(PlaylistError::YtdlpFailed(stderr.to_string()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        #[derive(Deserialize)]
        #[allow(dead_code)]
        struct FlatEntry {
            url: Option<String>,
            id: Option<String>,
            title: Option<String>,
            uploader: Option<String>,
            artist: Option<String>,
            duration: Option<f64>,
            playlist_index: Option<u32>,
            webpage_url: Option<String>,
            #[serde(rename = "ie_key")]
            ie_key: Option<String>,
        }

        let flat: FlatEntry = serde_json::from_str(line)
            .map_err(|e| PlaylistError::ParseError(e.to_string()))?;

        // The entry URL can be in `url`, `webpage_url`, or we construct it from `id`
        let entry_url = flat
            .url
            .or(flat.webpage_url)
            .or_else(|| {
                flat.id.map(|id| {
                    // Construct a YouTube URL from the ID
                    format!("https://www.youtube.com/watch?v={id}")
                })
            })
            .unwrap_or_default();

        let duration_ms = flat.duration.map(|d| (d * 1000.0) as u64);

        entries.push(PlaylistEntry {
            url: entry_url,
            title: flat.title,
            artist: flat.artist.or(flat.uploader),
            duration_ms,
            index: flat.playlist_index,
        });
    }

    // Sort by playlist index if available
    entries.sort_by_key(|e| e.index.unwrap_or(u32::MAX));

    Ok(entries)
}

/// Quick check: does this URL look like it could be a playlist?
/// This is a heuristic — the real check is running yt-dlp.
pub fn looks_like_playlist(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("/playlist") || lower.contains("&list=") || lower.contains("?list=")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_playlist_urls() {
        assert!(looks_like_playlist(
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
        ));
        assert!(looks_like_playlist(
            "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
        ));
        assert!(looks_like_playlist(
            "https://www.youtube.com/watch?v=abc&list=PLxyz"
        ));
    }

    #[test]
    fn single_track_not_detected_as_playlist() {
        assert!(!looks_like_playlist(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ));
        assert!(!looks_like_playlist(
            "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"
        ));
    }
}
