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
    #[error("{0}")]
    Http(String),
}

/// True for a Spotify playlist or album URL — the two collection shapes
/// yt-dlp refuses outright (DRM) but whose public embed page still lists
/// every track. A Spotify *track* URL is handled per-track downstream and
/// must not match here.
pub fn is_spotify_collection(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.contains("open.spotify.com/playlist/") || lower.contains("open.spotify.com/album/"))
        || lower.starts_with("spotify:playlist:")
        || lower.starts_with("spotify:album:")
}

/// Expand a Spotify playlist or album into its tracks by scraping the
/// public embed page (`open.spotify.com/embed/<kind>/<id>`) — same
/// no-login, no-API-key approach the yt-dlp adapter already uses for
/// single Spotify tracks. Each returned entry points at the individual
/// track URL, so the normal per-track Spotify→YouTube resolution runs for
/// it. The embed page lists up to ~50 tracks; longer playlists are
/// truncated to that (Spotify doesn't expose the rest without auth).
pub async fn expand_spotify_collection(
    url: &str,
) -> std::result::Result<Vec<PlaylistEntry>, PlaylistError> {
    let (kind, id) = parse_spotify_collection(url)
        .ok_or_else(|| PlaylistError::Http("not a Spotify playlist or album URL".into()))?;

    let embed = format!("https://open.spotify.com/embed/{kind}/{id}");
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| PlaylistError::Http(e.to_string()))?;

    let html = client
        .get(&embed)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| PlaylistError::Http(e.to_string()))?
        .text()
        .await
        .map_err(|e| PlaylistError::Http(e.to_string()))?;

    const START: &str = "<script id=\"__NEXT_DATA__\" type=\"application/json\">";
    let json_str = html
        .split_once(START)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(json, _)| json)
        .ok_or_else(|| PlaylistError::ParseError("no __NEXT_DATA__ in Spotify embed".into()))?;

    let data: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| PlaylistError::ParseError(e.to_string()))?;

    let track_list = data["props"]["pageProps"]["state"]["data"]["entity"]["trackList"]
        .as_array()
        .ok_or_else(|| PlaylistError::ParseError("no trackList in Spotify embed".into()))?;

    let entries = track_list
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let uri = t["uri"].as_str()?;
            let track_id = uri.strip_prefix("spotify:track:")?;
            Some(PlaylistEntry {
                url: format!("https://open.spotify.com/track/{track_id}"),
                title: t["title"].as_str().map(str::to_string),
                artist: t["subtitle"].as_str().map(str::to_string),
                duration_ms: t["duration"].as_u64(),
                index: Some(i as u32 + 1),
            })
        })
        .collect();

    Ok(entries)
}

fn parse_spotify_collection(url: &str) -> Option<(&'static str, String)> {
    let id_after = |marker: &str| -> Option<String> {
        url.split(marker).nth(1).map(|rest| {
            rest.chars()
                .take_while(|c| c.is_alphanumeric())
                .collect::<String>()
        })
    };
    for (marker, kind) in [
        ("open.spotify.com/playlist/", "playlist"),
        ("spotify:playlist:", "playlist"),
        ("open.spotify.com/album/", "album"),
        ("spotify:album:", "album"),
    ] {
        if let Some(id) = id_after(marker) {
            if !id.is_empty() {
                return Some((kind, id));
            }
        }
    }
    None
}

/// Check if a URL looks like a playlist or album (vs a single track).
/// Uses yt-dlp's `--flat-playlist --dump-json` to resolve entries.
/// Returns a vec of entries — single tracks return one entry, playlists
/// return multiple.
pub async fn expand_playlist(url: &str) -> std::result::Result<Vec<PlaylistEntry>, PlaylistError> {
    let ytdlp = yt_dlp_bin::find_ytdlp().ok_or_else(|| {
        PlaylistError::BinaryNotFound(
            "yt-dlp not found. This shouldn't happen in an official build — try reinstalling OpenDJ. Running from source? brew install yt-dlp".into(),
        )
    })?;

    let output = yt_dlp_bin::hidden(tokio::process::Command::new(&ytdlp))
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

        let flat: FlatEntry =
            serde_json::from_str(line).map_err(|e| PlaylistError::ParseError(e.to_string()))?;

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

    #[test]
    fn detects_spotify_collections() {
        assert!(is_spotify_collection(
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
        ));
        assert!(is_spotify_collection(
            "https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=x"
        ));
        assert!(is_spotify_collection(
            "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"
        ));
        // A single track is resolved per-track, not as a collection.
        assert!(!is_spotify_collection(
            "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"
        ));
        assert!(!is_spotify_collection(
            "https://www.youtube.com/playlist?list=PLxyz"
        ));
    }

    #[tokio::test]
    #[ignore = "network: hits open.spotify.com"]
    async fn spotify_collection_expands_live() {
        let entries =
            expand_spotify_collection("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")
                .await
                .expect("expand");
        assert!(entries.len() > 10, "got {} entries", entries.len());
        assert!(entries[0]
            .url
            .starts_with("https://open.spotify.com/track/"));
        assert!(entries[0].title.is_some());
        assert!(entries[0].artist.is_some());
    }

    #[test]
    fn parses_spotify_collection_id() {
        assert_eq!(
            parse_spotify_collection(
                "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=a"
            ),
            Some(("playlist", "37i9dQZF1DXcBWIGoYBM5M".to_string()))
        );
        assert_eq!(
            parse_spotify_collection("spotify:album:4aawyAB9vmqN3uQ7FjRGTy"),
            Some(("album", "4aawyAB9vmqN3uQ7FjRGTy".to_string()))
        );
        assert_eq!(
            parse_spotify_collection("https://open.spotify.com/track/x"),
            None
        );
    }
}
