use crate::yt_dlp_bin;
use crate::{Capabilities, PolicyStatus, ProviderAdapter, ProviderError, Result, TrackCandidate};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Default, Clone)]
struct CookieConfig {
    browser: Option<String>,
    file: Option<String>,
}

/// Universal adapter that wraps yt-dlp for YouTube and other video sites,
/// and uses direct SoundCloud API calls for SoundCloud (cleaner, no API key
/// needed — auto-detects client_id from the SoundCloud website).
pub struct YtdlpAdapter {
    http_client: reqwest::Client,
    /// YouTube auth for yt-dlp — either a browser to pull live cookies from
    /// ("safari", "chrome", ...) or a static exported `cookies.txt` file.
    /// YouTube's bot-check ("Sign in to confirm you're not a bot") blocks
    /// *all* yt-dlp requests — even plain metadata resolution — once
    /// triggered, and the only documented fix is authenticating as a real
    /// session. A static file takes priority when both are set: live
    /// browser extraction re-reads the browser's cookie store on every
    /// call, which can race with the browser's own cookie rotation and
    /// hand yt-dlp an already-stale cookie; a file is a fixed snapshot.
    /// Runtime-settable (via `set_cookies_browser`/`set_cookies_file`) so a
    /// Settings change takes effect without restarting the app.
    cookies: std::sync::RwLock<CookieConfig>,
    /// Browser that automatic probing last pulled a working YouTube
    /// session from. When a request hits an auth wall (age gate, bot
    /// check) and the user hasn't configured cookies themselves, we walk
    /// the browsers installed on this machine and hand yt-dlp
    /// `--cookies-from-browser` for each until one works — then remember
    /// it here so a run of age-gated downloads doesn't re-probe every
    /// browser (and, on macOS, re-hit the keychain prompt) every time.
    /// Not persisted: a cheap in-process cache, re-learned on demand.
    auto_cookie_browser: std::sync::RwLock<Option<String>>,
}

/// Shown when a YouTube request needs a signed-in account and nothing on
/// this machine could supply one — the one download failure the user can
/// actually act on, so it gets a plain-language message instead of raw
/// yt-dlp stderr.
const AUTH_HELP: &str = "This YouTube video needs a signed-in account — it's age-restricted, or YouTube flagged the request as automated. OpenDJ tried every browser profile on this computer and couldn't get a working YouTube session from any of them. Most common fix: fully quit your browser and retry — a running browser rotates its login cookies for security and OpenDJ only ever sees a stale copy. Otherwise: sign in to YouTube in a browser and play one age-restricted video to confirm the account's age; for Safari, grant OpenDJ Full Disk Access in System Settings › Privacy & Security; or export a cookies.txt (from a fresh private-window login) and set it under Settings.";

impl YtdlpAdapter {
    pub fn new() -> Self {
        Self {
            http_client: reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
                .build()
                .expect("reqwest client"),
            cookies: std::sync::RwLock::new(CookieConfig::default()),
            auto_cookie_browser: std::sync::RwLock::new(None),
        }
    }

    /// The yt-dlp flag + value the user has configured in Settings, if
    /// any — a static `cookies.txt` file wins over a live browser when
    /// both are set (see the field doc on `cookies`).
    fn cookie_arg(&self) -> Option<(&'static str, String)> {
        let cfg = self.cookies.read().unwrap();
        if let Some(file) = &cfg.file {
            if !file.is_empty() {
                return Some(("--cookies", file.clone()));
            }
        }
        if let Some(browser) = &cfg.browser {
            if !browser.is_empty() {
                return Some(("--cookies-from-browser", browser.clone()));
            }
        }
        None
    }

    /// yt-dlp reports one of these when a request is walled behind a
    /// signed-in YouTube session — an age gate, the "confirm you're not a
    /// bot" check, or a plain login requirement. These are the *only*
    /// failures a cookie can fix, so automatic browser probing escalates
    /// on this signature alone — never on a dead link, a geo-block, or a
    /// network error, where cycling browsers would just fire pointless
    /// keychain prompts.
    fn needs_auth(msg: &str) -> bool {
        msg.contains("confirm your age")
            || msg.contains("confirm you're not a bot")
            || msg.contains("Sign in to confirm")
            || msg.contains("LOGIN_REQUIRED")
            || msg.contains("age-restricted")
    }

    /// yt-dlp `--cookies-from-browser` targets to try on an auth wall, for
    /// every browser actually set up on this machine — ordered by how much
    /// OS friction reading the cookie store costs: Firefox needs no prompt;
    /// Chromium-family browsers need the login keychain (a one-time macOS
    /// prompt); Safari needs Full Disk Access granted to the app.
    ///
    /// For Chromium browsers each profile is listed explicitly
    /// (`chrome:Default`, `chrome:Profile 1`, …) rather than the bare
    /// `chrome` — a YouTube login very often lives in a secondary profile
    /// (a work account, a second person), and the bare name only ever
    /// reads `Default`. `auto_browser_attempts` promotes whichever target
    /// last worked to the front of this list.
    fn detected_browsers() -> Vec<String> {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };

        // (yt-dlp name, dir holding `Local State` + the profile folders)
        #[cfg(target_os = "macos")]
        let (chromium, firefox_ini): (&[(&str, &str)], &str) = (
            &[
                ("chrome", "Library/Application Support/Google/Chrome"),
                (
                    "brave",
                    "Library/Application Support/BraveSoftware/Brave-Browser",
                ),
                ("edge", "Library/Application Support/Microsoft Edge"),
                ("chromium", "Library/Application Support/Chromium"),
                ("vivaldi", "Library/Application Support/Vivaldi"),
                (
                    "opera",
                    "Library/Application Support/com.operasoftware.Opera",
                ),
            ],
            "Library/Application Support/Firefox/profiles.ini",
        );
        #[cfg(target_os = "windows")]
        let (chromium, firefox_ini): (&[(&str, &str)], &str) = (
            &[
                ("chrome", "AppData/Local/Google/Chrome/User Data"),
                (
                    "brave",
                    "AppData/Local/BraveSoftware/Brave-Browser/User Data",
                ),
                ("edge", "AppData/Local/Microsoft/Edge/User Data"),
                ("chromium", "AppData/Local/Chromium/User Data"),
                ("vivaldi", "AppData/Local/Vivaldi/User Data"),
                ("opera", "AppData/Roaming/Opera Software/Opera Stable"),
            ],
            "AppData/Roaming/Mozilla/Firefox/profiles.ini",
        );
        #[cfg(all(unix, not(target_os = "macos")))]
        let (chromium, firefox_ini): (&[(&str, &str)], &str) = (
            &[
                ("chrome", ".config/google-chrome"),
                ("chromium", ".config/chromium"),
                ("brave", ".config/BraveSoftware/Brave-Browser"),
                ("edge", ".config/microsoft-edge"),
                ("vivaldi", ".config/vivaldi"),
                ("opera", ".config/opera"),
            ],
            ".mozilla/firefox/profiles.ini",
        );

        let mut out: Vec<String> = Vec::new();

        // Firefox first: no OS unlock. yt-dlp picks the default profile.
        if home.join(firefox_ini).is_file() {
            out.push("firefox".to_string());
        }

        for (name, rel) in chromium {
            let base = home.join(rel);
            // `Local State` is written on first run and holds the profile
            // list — its absence means the browser is installed but has
            // never actually been used, so there are no cookies to read.
            let local_state = base.join("Local State");
            if !local_state.is_file() {
                continue;
            }
            for profile in Self::chromium_profiles(&local_state) {
                out.push(format!("{name}:{profile}"));
            }
        }

        // Safari last: needs Full Disk Access granted to OpenDJ.
        #[cfg(target_os = "macos")]
        if home
            .join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies")
            .is_file()
            || home.join("Library/Cookies/Cookies.binarycookies").is_file()
        {
            out.push("safari".to_string());
        }

        out
    }

    /// Profile folder names for a Chromium browser, read from its
    /// `Local State` (`profile.info_cache` keys — "Default", "Profile 1",
    /// …), with "Default" first. Falls back to just "Default" if the file
    /// can't be read or parsed.
    fn chromium_profiles(local_state: &Path) -> Vec<String> {
        let fallback = || vec!["Default".to_string()];
        let Ok(text) = std::fs::read_to_string(local_state) else {
            return fallback();
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            return fallback();
        };
        let Some(cache) = json
            .get("profile")
            .and_then(|p| p.get("info_cache"))
            .and_then(|c| c.as_object())
        else {
            return fallback();
        };
        if cache.is_empty() {
            return fallback();
        }
        let mut profiles: Vec<String> = cache.keys().cloned().collect();
        profiles.sort_by_key(|k| (k != "Default", k.to_ascii_lowercase()));
        profiles
    }

    /// Ordered `--cookies-from-browser` values to try on an auth wall:
    /// the browser that last produced a working session (if still
    /// installed) first, then the rest of `detected_browsers`, minus a
    /// browser the user configured explicitly (the caller tries that one
    /// itself).
    fn auto_browser_attempts(&self) -> Vec<String> {
        let configured = {
            let cfg = self.cookies.read().unwrap();
            cfg.browser.clone().filter(|b| !b.is_empty())
        };
        let last = self.auto_cookie_browser.read().unwrap().clone();
        let detected = Self::detected_browsers();

        let mut ordered: Vec<String> = Vec::new();
        if let Some(l) = last {
            if detected.contains(&l) {
                ordered.push(l);
            }
        }
        for d in detected {
            if !ordered.contains(&d) {
                ordered.push(d);
            }
        }
        // Drop targets for a browser the user pinned in Settings — the
        // caller tries that one itself. Match on the browser name, so
        // pinning "chrome" also skips "chrome:Profile 1".
        ordered
            .into_iter()
            .filter(|b| match configured.as_deref() {
                None => true,
                Some(c) => b.split(':').next().unwrap_or(b) != c,
            })
            .collect()
    }

    fn remember_auto_browser(&self, browser: &str) {
        let mut w = self.auto_cookie_browser.write().unwrap();
        if w.as_deref() != Some(browser) {
            *w = Some(browser.to_string());
        }
    }

    fn ytdlp_path() -> Result<PathBuf> {
        yt_dlp_bin::find_ytdlp().ok_or(ProviderError::NotConfigured(
            "yt-dlp not found. This shouldn't happen in an official build — try reinstalling OpenDJ. Running from source? brew install yt-dlp",
        ))
    }

    /// A stale/rotated cookie is worse than no cookie at all — yt-dlp
    /// treats the request as authenticated-but-invalid rather than falling
    /// back to its normal anonymous path, so passing a bad cookie can break
    /// requests that would otherwise have succeeded unauthenticated. When
    /// yt-dlp reports this specific signature, retry once with no cookies
    /// instead of surfacing a failure the user can't self-diagnose.
    fn is_stale_cookie_error(msg: &str) -> bool {
        msg.contains("cookies are no longer valid") || msg.contains("cookies have expired")
    }

    /// Run yt-dlp and return its JSON stdout, working through cookie
    /// strategies as needed: the user's configured cookies first (falling
    /// back to anonymous if yt-dlp says they've gone stale), then — only
    /// if the request is refused for lack of a signed-in session — each
    /// browser on this machine in turn, remembering whichever one works.
    async fn run_ytdlp_json(&self, args: &[&str]) -> Result<String> {
        let configured = self.cookie_arg();
        let first = match self.run_ytdlp_json_inner(args, configured.clone()).await {
            Err(e) if configured.is_some() && Self::is_stale_cookie_error(&e.to_string()) => {
                self.run_ytdlp_json_inner(args, None).await
            }
            other => other,
        };

        match first {
            Err(e) if Self::needs_auth(&e.to_string()) => {
                for browser in self.auto_browser_attempts() {
                    if let Ok(out) = self
                        .run_ytdlp_json_inner(
                            args,
                            Some(("--cookies-from-browser", browser.clone())),
                        )
                        .await
                    {
                        self.remember_auto_browser(&browser);
                        return Ok(out);
                    }
                }
                Err(ProviderError::AuthRequired(AUTH_HELP.to_string()))
            }
            other => other,
        }
    }

    async fn run_ytdlp_json_inner(
        &self,
        args: &[&str],
        cookie_arg: Option<(&'static str, String)>,
    ) -> Result<String> {
        let ytdlp = Self::ytdlp_path()?;
        let mut full_args: Vec<&str> = Vec::with_capacity(args.len() + 2);
        if let Some((flag, value)) = &cookie_arg {
            full_args.push(flag);
            full_args.push(value.as_str());
        }
        full_args.extend_from_slice(args);

        let output = yt_dlp_bin::hidden(tokio::process::Command::new(&ytdlp))
            .args(&full_args)
            .env("PATH", yt_dlp_bin::augmented_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ProviderError::Io(std::io::Error::other(format!(
                "yt-dlp failed: {stderr}"
            ))));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Check if a URL is a SoundCloud link.
    pub fn is_soundcloud_url(url: &str) -> bool {
        url.to_ascii_lowercase().contains("soundcloud.com")
    }

    /// Check if a URL is a Spotify link.
    pub fn is_spotify_url(url: &str) -> bool {
        let lower = url.to_ascii_lowercase();
        lower.contains("spotify.com") || lower.starts_with("spotify:")
    }

    /// Check if a URL is from a DRM-protected platform.
    fn is_drm_platform(url: &str) -> bool {
        let lower = url.to_ascii_lowercase();
        lower.contains("spotify.com")
            || lower.starts_with("spotify:")
            || lower.contains("music.apple.com")
            || lower.contains("deezer.com")
    }

    // ── SoundCloud: auto-detect client_id ──────────────────────────────────

    /// Detect SoundCloud client_id from their website JavaScript assets.
    async fn detect_sc_client_id(&self) -> Result<String> {
        let html = self
            .http_client
            .get("https://soundcloud.com/discover")
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;

        // Find script asset URLs
        let mut scripts = Vec::new();
        let mut search_from = 0;
        while let Some(idx) = html[search_from..].find("src=\"https://a-v2.sndcdn.com/assets/") {
            let abs = search_from + idx;
            let url_start = abs + 5; // skip src="
            if let Some(end) = html[url_start..].find('"') {
                let url = &html[url_start..url_start + end];
                if url.ends_with(".js") {
                    scripts.push(url.to_string());
                }
                search_from = url_start + end + 1;
            } else {
                break;
            }
        }

        if scripts.is_empty() {
            return Err(ProviderError::NotConfigured(
                "Could not find SoundCloud asset scripts",
            ));
        }

        // Check last 8 scripts for client_id
        for src in scripts.iter().rev().take(8) {
            if let Ok(js) = self.http_client.get(src).send().await?.text().await {
                if let Some(m) = js.find_client_id() {
                    return Ok(m);
                }
            }
        }

        Err(ProviderError::NotConfigured(
            "Could not detect SoundCloud client_id",
        ))
    }

    /// Resolve a SoundCloud track URL to metadata.
    async fn resolve_soundcloud(&self, url: &str, client_id: &str) -> Result<Vec<TrackCandidate>> {
        let api_url =
            format!("https://api-v2.soundcloud.com/resolve?url={url}&client_id={client_id}");

        let resp = self
            .http_client
            .get(&api_url)
            .send()
            .await?
            .error_for_status()?;

        #[derive(Deserialize)]
        struct ScTrack {
            id: u64,
            title: Option<String>,
            duration: Option<u64>,
            permalink_url: Option<String>,
            user: Option<ScUser>,
            media: Option<ScMedia>,
        }

        #[derive(Deserialize)]
        struct ScUser {
            username: Option<String>,
        }

        #[derive(Deserialize)]
        struct ScMedia {
            transcodings: Option<Vec<ScTranscoding>>,
        }

        #[derive(Deserialize)]
        struct ScTranscoding {
            url: Option<String>,
            format: Option<ScFormat>,
            snipped: Option<bool>,
        }

        #[derive(Deserialize)]
        struct ScFormat {
            protocol: Option<String>,
        }

        let track: ScTrack = resp.json().await?;

        let title = track.title.unwrap_or_else(|| "Unknown".to_string());
        let artist = track
            .user
            .and_then(|u| u.username)
            .unwrap_or_else(|| "Unknown".to_string());
        let duration_ms = track.duration;
        let source_url = track.permalink_url.unwrap_or_else(|| url.to_string());

        // Find progressive (direct MP3) transcoding URL
        let transcode_url = track.media.and_then(|m| m.transcodings).and_then(|tc| {
            let tc: Vec<_> = tc;
            let progressive = tc.iter().find(|x| {
                x.format
                    .as_ref()
                    .map(|f| f.protocol.as_deref() == Some("progressive"))
                    .unwrap_or(false)
                    && !x.snipped.unwrap_or(false)
            });
            let fallback = tc.iter().find(|x| !x.snipped.unwrap_or(false));
            progressive.or(fallback).and_then(|x| x.url.clone())
        });

        Ok(vec![TrackCandidate {
            id: track.id.to_string(),
            title,
            artist: Some(artist),
            album: None,
            duration_ms,
            provider: "soundcloud".to_string(),
            source_url,
            confidence: 1.0,
            downloadable: transcode_url.is_some(),
        }])
    }

    /// Download a SoundCloud track directly via its transcoding URL.
    async fn fetch_soundcloud(
        &self,
        candidate: &TrackCandidate,
        dest_dir: &Path,
        format: &str,
    ) -> Result<PathBuf> {
        let client_id = self.detect_sc_client_id().await?;

        // Re-resolve to get fresh transcoding URLs
        let candidates = self
            .resolve_soundcloud(&candidate.source_url, &client_id)
            .await?;
        let fresh = candidates.first().ok_or(ProviderError::NoMatch)?;

        // Get the actual stream URL from the API
        let api_url = format!(
            "https://api-v2.soundcloud.com/resolve?url={}&client_id={client_id}",
            candidate.source_url
        );

        #[derive(Deserialize)]
        struct ScFull {
            media: Option<ScMedia>,
        }

        #[derive(Deserialize)]
        struct ScMedia {
            transcodings: Option<Vec<ScTranscoding>>,
        }

        #[derive(Deserialize)]
        struct ScTranscoding {
            url: Option<String>,
            format: Option<ScFormat>,
            snipped: Option<bool>,
        }

        #[derive(Deserialize)]
        struct ScFormat {
            protocol: Option<String>,
        }

        let resp = self
            .http_client
            .get(&api_url)
            .send()
            .await?
            .error_for_status()?;

        let full: ScFull = resp.json().await?;

        let transcoding_url = full
            .media
            .and_then(|m| m.transcodings)
            .and_then(|tc| {
                let tc: Vec<_> = tc;
                let progressive = tc.iter().find(|x| {
                    x.format
                        .as_ref()
                        .map(|f| f.protocol.as_deref() == Some("progressive"))
                        .unwrap_or(false)
                        && !x.snipped.unwrap_or(false)
                });
                let fallback = tc.iter().find(|x| !x.snipped.unwrap_or(false));
                progressive.or(fallback).and_then(|x| x.url.clone())
            })
            .ok_or(ProviderError::NotDownloadable)?;

        // Resolve the actual CDN stream URL
        let stream_resp = self
            .http_client
            .get(format!("{transcoding_url}?client_id={client_id}"))
            .send()
            .await?
            .error_for_status()?;

        #[derive(Deserialize)]
        struct StreamUrl {
            url: String,
        }

        let stream: StreamUrl = stream_resp.json().await?;

        // Download the MP3 stream
        let resp = self
            .http_client
            .get(&stream.url)
            .send()
            .await?
            .error_for_status()?;
        let bytes = resp.bytes().await?;

        tokio::fs::create_dir_all(dest_dir).await?;

        let safe_name = format!(
            "{} - {}",
            fresh.artist.as_deref().unwrap_or("Unknown"),
            fresh.title
        );
        let file_name = sanitize_filename(&safe_name);
        let dest_path = dest_dir.join(format!("{file_name}.{format}"));
        tokio::fs::write(&dest_path, &bytes).await?;

        Ok(dest_path)
    }

    /// For DRM platforms, search YouTube for the track. Spotify URLs only
    /// encode an opaque track ID (no title/artist), so a search built from
    /// the URL itself is a guess at best — instead, look up the real title
    /// and artist from Spotify's own public track-embed page first (no
    /// login/API key needed, same no-key-scraping approach already used
    /// for SoundCloud), then use *that* to build an accurate search query.
    async fn resolve_drm_url(&self, raw: &str) -> Result<Vec<TrackCandidate>> {
        if Self::is_spotify_url(raw) {
            if let Some(track_id) = Self::extract_spotify_track_id(raw) {
                if let Ok(meta) = self.fetch_spotify_track_metadata(&track_id).await {
                    let query = match &meta.artist {
                        Some(artist) => format!("{} {}", meta.title, artist),
                        None => meta.title.clone(),
                    };
                    return self.search_youtube(raw, &query, Some(meta)).await;
                }
            }
        }

        // Try yt-dlp directly first (covers platforms it can extract without a search, e.g. some Apple Music/Deezer pages).
        if let Ok(json) = self
            .run_ytdlp_json(&["--dump-json", "--no-download", "--no-playlist", raw])
            .await
        {
            if let Ok(info) = serde_json::from_str::<YtdlpInfo>(&json) {
                return Ok(vec![info.into_candidate(raw, true)]);
            }
        }

        // Last resort: a heuristic search query guessed from the URL slug.
        let search_query = Self::extract_search_query(raw);
        if search_query.is_empty() {
            return Err(ProviderError::NoMatch);
        }
        self.search_youtube(raw, &search_query, None).await
    }

    /// Run a YouTube search for `query` and build a candidate from the top
    /// result. When `known` metadata was resolved directly from the source
    /// platform, it overrides whatever (often messy) title/uploader the
    /// matched YouTube video itself reports — YouTube is only the audio
    /// source here, not the source of truth for track metadata.
    async fn search_youtube(
        &self,
        raw: &str,
        query: &str,
        known: Option<SourceTrackMeta>,
    ) -> Result<Vec<TrackCandidate>> {
        let search_url = format!("ytsearch1:{query}");
        let json = self
            .run_ytdlp_json(&["--dump-json", "--no-download", "--no-playlist", &search_url])
            .await?;

        let info: YtdlpInfo = serde_json::from_str(&json).map_err(|e| {
            ProviderError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse yt-dlp output: {e}"),
            ))
        })?;

        let mut candidate = info.into_candidate(raw, true);
        if let Some(meta) = known {
            candidate.title = meta.title;
            candidate.artist = meta.artist.map(|a| format!("{a} (via YouTube)"));
            if meta.duration_ms.is_some() {
                candidate.duration_ms = meta.duration_ms;
            }
            candidate.confidence = 0.85;
        } else {
            candidate.confidence = 0.7;
        }
        Ok(vec![candidate])
    }

    /// Extract the track ID from `open.spotify.com/track/<id>` or
    /// `spotify:track:<id>`.
    fn extract_spotify_track_id(url: &str) -> Option<String> {
        let rest = url
            .split("spotify.com/track/")
            .nth(1)
            .or_else(|| url.strip_prefix("spotify:track:"))?;
        let id: String = rest.chars().take_while(|c| c.is_alphanumeric()).collect();
        if id.is_empty() {
            None
        } else {
            Some(id)
        }
    }

    /// Fetch real title/artist/duration for a Spotify track from its
    /// public embed page — no login or API key required. The embed page
    /// ships a `__NEXT_DATA__` JSON blob with the full track entity
    /// (Spotify's oEmbed endpoint only gives the title, not the artist).
    async fn fetch_spotify_track_metadata(&self, track_id: &str) -> Result<SourceTrackMeta> {
        let html = self
            .http_client
            .get(format!("https://open.spotify.com/embed/track/{track_id}"))
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;

        const START: &str = "<script id=\"__NEXT_DATA__\" type=\"application/json\">";
        let start = html.find(START).ok_or(ProviderError::NoMatch)?;
        let body_start = start + START.len();
        let end = html[body_start..]
            .find("</script>")
            .ok_or(ProviderError::NoMatch)?;
        let json_str = &html[body_start..body_start + end];

        let data: serde_json::Value = serde_json::from_str(json_str).map_err(|e| {
            ProviderError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse Spotify track data: {e}"),
            ))
        })?;

        let entity = &data["props"]["pageProps"]["state"]["data"]["entity"];
        let title = entity["name"]
            .as_str()
            .ok_or(ProviderError::NoMatch)?
            .to_string();
        let artist = entity["artists"][0]["name"].as_str().map(|s| s.to_string());
        let duration_ms = entity["duration"].as_u64();

        Ok(SourceTrackMeta {
            title,
            artist,
            duration_ms,
        })
    }

    fn extract_search_query(url: &str) -> String {
        let lower = url.to_ascii_lowercase();

        if lower.contains("spotify.com") || lower.starts_with("spotify:") {
            if let Some(track_segment) = url.split("/track/").nth(1) {
                let track_part: String = track_segment
                    .chars()
                    .take_while(|c| *c != '?' && *c != '#')
                    .collect();
                if track_part.contains('-') && track_part.len() > 10 {
                    return track_part.replace('-', " ");
                }
                return format!("spotify track {track_part}");
            }
        }

        if lower.contains("music.apple.com") {
            if let Some(path) = url.split("music.apple.com/").nth(1) {
                let segments: Vec<&str> = path.split('/').collect();
                if let Some(name) = segments.last() {
                    let cleaned: String = name
                        .chars()
                        .take_while(|c| *c != '?' && *c != '#')
                        .collect();
                    if !cleaned.is_empty() && !cleaned.chars().all(|c| c.is_numeric()) {
                        return cleaned.replace('-', " ");
                    }
                }
            }
        }

        String::new()
    }
}

/// Metadata resolved directly from the source platform (Spotify, etc.)
/// before falling back to YouTube for the actual audio.
struct SourceTrackMeta {
    title: String,
    artist: Option<String>,
    duration_ms: Option<u64>,
}

impl Default for YtdlpAdapter {
    fn default() -> Self {
        Self::new()
    }
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ── SoundCloud client_id detection from JS ─────────────────────────────────

trait StrExt {
    fn find_client_id(&self) -> Option<String>;
}

impl StrExt for str {
    fn find_client_id(&self) -> Option<String> {
        // Match patterns like: client_id:"abc123..." or {client_id:"abc123..."}
        for pat in &[
            "\"client_id\":\"",
            "client_id:\"",
            "client_id:'",
            ",client_id:",
            "{client_id:",
            "(client_id:",
        ] {
            if let Some(idx) = self.find(pat) {
                let start = idx + pat.len();
                let rest = &self[start..];
                let id: String = rest.chars().take_while(|c| c.is_alphanumeric()).collect();
                if id.len() >= 20 && id.len() <= 42 {
                    return Some(id);
                }
            }
        }
        None
    }
}

// ── yt-dlp JSON output parsing ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct YtdlpInfo {
    id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    uploader: Option<String>,
    album: Option<String>,
    playlist_title: Option<String>,
    duration: Option<f64>,
    webpage_url: Option<String>,
    extractor: Option<String>,
    #[serde(default)]
    playlist_index: Option<u32>,
}

impl YtdlpInfo {
    fn into_candidate(self, source_url: &str, is_drm_fallback: bool) -> TrackCandidate {
        let title = self.title.unwrap_or_else(|| "Unknown Title".to_string());
        let artist = self.artist.or(self.uploader).map(|a| {
            if is_drm_fallback {
                format!("{a} (via YouTube)")
            } else {
                a
            }
        });
        let album = self.album.or(self.playlist_title);
        let duration_ms = self.duration.map(|d| (d * 1000.0) as u64);
        let id = self.id.unwrap_or_else(|| source_url.to_string());
        let source = self.webpage_url.unwrap_or_else(|| source_url.to_string());

        TrackCandidate {
            id,
            title,
            artist,
            album,
            duration_ms,
            provider: "ytdlp".to_string(),
            source_url: source,
            confidence: 1.0,
            downloadable: true,
        }
    }
}

// ── ProviderAdapter implementation ─────────────────────────────────────────

#[async_trait]
impl ProviderAdapter for YtdlpAdapter {
    fn id(&self) -> &'static str {
        "ytdlp"
    }

    fn display_name(&self) -> &'static str {
        "yt-dlp (Universal)"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            metadata: true,
            download: true,
        }
    }

    fn policy_status(&self) -> PolicyStatus {
        if yt_dlp_bin::find_ytdlp().is_some() {
            PolicyStatus::Permitted
        } else {
            PolicyStatus::NotConfigured
        }
    }

    fn validate_input(&self, raw: &str) -> bool {
        let lower = raw.to_ascii_lowercase();
        lower.starts_with("http://") || lower.starts_with("https://")
    }

    fn set_cookies_browser(&self, browser: Option<String>) {
        self.cookies.write().unwrap().browser = browser;
    }

    fn set_cookies_file(&self, file: Option<String>) {
        self.cookies.write().unwrap().file = file;
    }

    async fn resolve_metadata(&self, raw: &str) -> Result<Vec<TrackCandidate>> {
        // Plain free-text query (a song name, not a URL): search YouTube and
        // pick the top hit. Movies/explicit "Support the artist" headers and
        // other uploads that don't sound like the track are avoided by
        // relying on yt-dlp ranking; the fetched audio is the matched video.
        if !raw.starts_with("http://") && !raw.starts_with("https://") {
            return self.search_youtube(raw, raw, None).await;
        }

        // SoundCloud: use direct API (no yt-dlp needed)
        if Self::is_soundcloud_url(raw) {
            let client_id = self.detect_sc_client_id().await?;
            return self.resolve_soundcloud(raw, &client_id).await;
        }

        // DRM platforms: YouTube search fallback
        if Self::is_drm_platform(raw) {
            return self.resolve_drm_url(raw).await;
        }

        // Everything else: yt-dlp
        let json = self
            .run_ytdlp_json(&["--dump-json", "--no-download", "--no-playlist", raw])
            .await?;

        let info: YtdlpInfo = serde_json::from_str(&json).map_err(|e| {
            ProviderError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse yt-dlp output: {e}"),
            ))
        })?;

        Ok(vec![info.into_candidate(raw, false)])
    }

    async fn fetch(
        &self,
        candidate: &TrackCandidate,
        dest_dir: &Path,
        format: &str,
    ) -> Result<PathBuf> {
        tokio::fs::create_dir_all(dest_dir).await?;

        // SoundCloud: direct API download (clean, no yt-dlp)
        if candidate.provider == "soundcloud" || Self::is_soundcloud_url(&candidate.source_url) {
            return self.fetch_soundcloud(candidate, dest_dir, format).await;
        }

        // Everything else: yt-dlp with format 18 fallback
        let output_template = dest_dir.join("%(title)s - %(artist)s.%(ext)s");
        let ytdlp = Self::ytdlp_path()?;

        let ffmpeg_path = yt_dlp_bin::find_ffmpeg().ok_or(ProviderError::NotConfigured(
            "ffmpeg not found. This shouldn't happen in an official build — try reinstalling OpenDJ. Running from source? brew install ffmpeg",
        ))?;

        // YouTube requires a JS runtime for signature challenges. Prefer
        // the bundled deno, fall back to system PATH.
        let deno_path = yt_dlp_bin::find_deno();

        // YouTube's default/android_vr clients will list formats fine but then
        // 403 on the actual byte fetch unless a PO Token is supplied (we
        // don't run a token provider). No single fallback client is
        // reliable on its own — YouTube tightens/loosens PO-token and
        // signature-challenge requirements per client independently and
        // per video, seemingly via rolling experiments, so a client that
        // works today can fail tomorrow on the very same video (verified
        // directly: web_embedded/mweb both failed on one video with an
        // "n challenge solving failed" error, while tv_simply and
        // web_music succeeded cleanly on that same video moments later).
        // The fix is breadth, not a "correct" client — try several in
        // order of typical audio quality and let whichever still works
        // today carry it.
        let clients = ["web_embedded", "tv_simply", "mweb", "web_music"];
        // Accumulated across every client tried — surfacing only the last
        // failure hides why the earlier (usually more reliable) attempts
        // failed, which is exactly the info needed to diagnose a new
        // failure mode instead of guessing at it.
        let mut attempt_errors: Vec<String> = Vec::new();
        let configured_cookie = self.cookie_arg();
        // Set once a client has reported an auth wall and we've appended
        // this machine's browsers to the cookie plan — so escalation
        // happens at most once per fetch, not once per client.
        let mut auth_escalated = false;

        let audio_quality = match format {
            "flac" | "wav" | "aiff" => "0",
            "mp3" => "320K",
            "aac" => "256K",
            "ogg" => "192K",
            _ => "320K",
        };
        let audio_fmt = format;
        for (i, client) in clients.iter().enumerate() {
            // web_embedded is the only client that reliably serves a real
            // audio-only format (140/m4a) without a PO token; the others
            // need format 18 (a combined, lower-bitrate mp4) specifically
            // because that's the one format YouTube leaves fetchable for
            // them even when it warns about a missing PO token.
            let ytdlp_format = if *client == "web_embedded" {
                "bestaudio[ext=m4a]/bestaudio/best"
            } else {
                "18"
            };
            let ffmpeg_str = ffmpeg_path.to_string_lossy();
            let output_str = output_template.to_string_lossy();
            let client_arg = format!("youtube:player_client={client}");
            let mut base_args: Vec<&str> = vec![
                "-f",
                ytdlp_format,
                "-x",
                "--audio-format",
                audio_fmt,
                "--audio-quality",
                audio_quality,
                "--ffmpeg-location",
                &ffmpeg_str,
                "--output",
                &output_str,
                "--no-playlist",
                "--no-overwrites",
                "--parse-metadata",
                "%(title)s:%(meta_title)s",
                "--parse-metadata",
                "%(uploader)s:%(meta_artist)s",
                "--parse-metadata",
                "%(album)s:%(meta_album)s",
                "--extractor-args",
                &client_arg,
                "--remote-components",
                "ejs:npm",
            ];

            // If we found deno (bundled or system), tell yt-dlp to use it
            // for YouTube's JS signature challenges.
            let deno_str;
            if let Some(ref deno) = deno_path {
                deno_str = format!("deno:{}", deno.to_string_lossy());
                base_args.push("--js-runtimes");
                base_args.push(&deno_str);
            }

            base_args.push(&candidate.source_url);

            // Cookie strategies to try for this client, in order. Start
            // with the user's configured cookies then anonymous (a
            // stale/rotated cookie is worse than none — see
            // `is_stale_cookie_error`); anonymous only if nothing is
            // configured. The first time any client hits an auth wall,
            // this machine's browsers are appended once — see `needs_auth`.
            let mut cookie_plan: Vec<Option<(&str, String)>> = match &configured_cookie {
                Some((flag, value)) => vec![Some((*flag, value.clone())), None],
                None => vec![None],
            };
            if auth_escalated {
                for browser in self.auto_browser_attempts() {
                    cookie_plan.push(Some(("--cookies-from-browser", browser)));
                }
            }

            let mut output = None;
            let mut plan_idx = 0;
            while plan_idx < cookie_plan.len() {
                let cookie = cookie_plan[plan_idx].clone();
                plan_idx += 1;

                let mut args: Vec<&str> = Vec::with_capacity(base_args.len() + 2);
                if let Some((flag, value)) = &cookie {
                    args.push(flag);
                    args.push(value.as_str());
                }
                args.extend_from_slice(&base_args);

                let attempt = yt_dlp_bin::hidden(tokio::process::Command::new(&ytdlp))
                    .args(&args)
                    .env("PATH", yt_dlp_bin::augmented_path())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await?;

                if attempt.status.success() {
                    if let Some(("--cookies-from-browser", browser)) = &cookie {
                        self.remember_auto_browser(browser);
                    }
                    output = Some(attempt);
                    break;
                }

                let stderr = String::from_utf8_lossy(&attempt.stderr).to_string();

                // Stale configured cookie: fall straight through to the
                // next plan entry (anonymous), which is already queued.
                if cookie.is_some() && Self::is_stale_cookie_error(&stderr) {
                    output = Some(attempt);
                    continue;
                }

                // First auth wall of this fetch: append the machine's
                // browsers to the plan and keep going.
                if !auth_escalated && Self::needs_auth(&stderr) {
                    auth_escalated = true;
                    for browser in self.auto_browser_attempts() {
                        cookie_plan.push(Some(("--cookies-from-browser", browser)));
                    }
                    output = Some(attempt);
                    continue;
                }

                // Any other failure: this client is done — trying more
                // cookie variants for it won't change the outcome.
                output = Some(attempt);
                break;
            }
            let output = output.expect("at least one attempt always runs");

            if output.status.success() {
                attempt_errors.clear();
                break;
            }

            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            // We hit an auth wall and no browser on this machine could
            // satisfy it — a different player_client won't help, and this
            // is the one failure the user can actually act on. Surface it
            // plainly instead of a multi-client stderr dump.
            if auth_escalated {
                return Err(ProviderError::AuthRequired(AUTH_HELP.to_string()));
            }

            // YouTube requires a JavaScript runtime (deno/node) to solve
            // signature challenges. If none is available, all clients fail
            // with "Signature solving failed" — no point trying the rest.
            if stderr.contains("Signature solving failed")
                || stderr.contains("n challenge solving failed")
            {
                return Err(ProviderError::NotConfigured(
                    "YouTube downloads require a JavaScript runtime (deno or node). \
                     Install deno: https://deno.com/#installation \
                     Or install node: https://nodejs.org",
                ));
            }

            let retryable = stderr.contains("403") || stderr.contains("Requested format");
            attempt_errors.push(format!("[{client}] {stderr}"));
            if !retryable || i == clients.len() - 1 {
                return Err(ProviderError::Io(std::io::Error::other(format!(
                    "yt-dlp download failed after trying {}: {}",
                    clients.join(", "),
                    attempt_errors.join("\n---\n")
                ))));
            }
        }

        // Find the downloaded file
        find_latest_download(dest_dir, audio_fmt)
    }

    async fn search(&self, query: &str) -> Result<Vec<TrackCandidate>> {
        let search_query = format!("ytsearch10:{query}");
        let json = self
            .run_ytdlp_json(&[
                "--dump-json",
                "--no-download",
                "--flat-playlist",
                &search_query,
            ])
            .await?;

        let mut results = Vec::new();
        for line in json.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(info) = serde_json::from_str::<YtdlpInfo>(line) {
                results.push(info.into_candidate("", false));
            }
        }

        Ok(results)
    }
}

/// Find the most recently created audio file of the given format in a directory.
fn find_latest_download(dir: &Path, format: &str) -> Result<PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(ProviderError::Io)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| {
                    ext.to_string_lossy().to_ascii_lowercase() == format.to_ascii_lowercase()
                })
                .unwrap_or(false)
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.path(), meta.modified().ok()?))
        })
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.1));

    entries
        .into_iter()
        .next()
        .map(|(path, _)| path)
        .ok_or_else(|| {
            ProviderError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Downloaded file not found in destination directory",
            ))
        })
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_any_http_url() {
        let p = YtdlpAdapter::new();
        assert!(p.validate_input("https://youtube.com/watch?v=abc"));
        assert!(p.validate_input("https://open.spotify.com/track/xyz"));
        assert!(p.validate_input("https://soundcloud.com/artist/track"));
        assert!(p.validate_input("http://example.com/song.mp3"));
    }

    #[test]
    fn rejects_non_urls() {
        let p = YtdlpAdapter::new();
        assert!(!p.validate_input("Daft Punk - One More Time"));
        assert!(!p.validate_input("/path/to/file.mp3"));
    }

    #[test]
    fn detects_drm_platforms() {
        assert!(YtdlpAdapter::is_drm_platform(
            "https://open.spotify.com/track/abc"
        ));
        assert!(YtdlpAdapter::is_drm_platform(
            "https://music.apple.com/us/album/xyz"
        ));
        assert!(!YtdlpAdapter::is_drm_platform(
            "https://youtube.com/watch?v=abc"
        ));
        assert!(!YtdlpAdapter::is_drm_platform(
            "https://soundcloud.com/artist/track"
        ));
    }

    #[test]
    fn detects_soundcloud_urls() {
        assert!(YtdlpAdapter::is_soundcloud_url(
            "https://soundcloud.com/artist/track"
        ));
        assert!(!YtdlpAdapter::is_soundcloud_url(
            "https://youtube.com/watch?v=abc"
        ));
    }

    #[test]
    fn needs_auth_matches_only_session_walls() {
        assert!(YtdlpAdapter::needs_auth(
            "ERROR: [youtube] abc: Sign in to confirm your age. Use --cookies-from-browser"
        ));
        assert!(YtdlpAdapter::needs_auth(
            "Sign in to confirm you're not a bot"
        ));
        assert!(YtdlpAdapter::needs_auth("player response: LOGIN_REQUIRED"));
        // Not auth walls — must not trigger browser-cookie probing.
        assert!(!YtdlpAdapter::needs_auth(
            "ERROR: [youtube] abc: Video unavailable"
        ));
        assert!(!YtdlpAdapter::needs_auth("HTTP Error 403: Forbidden"));
        assert!(!YtdlpAdapter::needs_auth(
            "Requested format is not available"
        ));
    }

    #[test]
    fn auto_browser_attempts_excludes_configured_browser() {
        let p = YtdlpAdapter::new();
        // With nothing configured, attempts are exactly what's detected.
        assert_eq!(p.auto_browser_attempts(), YtdlpAdapter::detected_browsers());
        // Pinning a browser in Settings drops all its targets from the
        // automatic list (the caller tries that browser itself) — matched
        // on the name, so "chrome" also excludes "chrome:Profile 1".
        if let Some(first) = YtdlpAdapter::detected_browsers().first().cloned() {
            let name = first.split(':').next().unwrap().to_string();
            p.set_cookies_browser(Some(name.clone()));
            assert!(p
                .auto_browser_attempts()
                .iter()
                .all(|b| b.split(':').next().unwrap() != name));
        }
    }

    #[test]
    fn remembered_browser_is_tried_first() {
        let p = YtdlpAdapter::new();
        let detected = YtdlpAdapter::detected_browsers();
        if let Some(last) = detected.get(1).or_else(|| detected.first()).cloned() {
            p.remember_auto_browser(&last);
            assert_eq!(p.auto_browser_attempts().first(), Some(&last));
        }
    }

    #[test]
    fn chromium_profiles_reads_info_cache() {
        let dir = std::env::temp_dir().join(format!("odj-ls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ls = dir.join("Local State");
        std::fs::write(
            &ls,
            r#"{"profile":{"info_cache":{"Profile 2":{},"Default":{},"Profile 1":{}}}}"#,
        )
        .unwrap();
        assert_eq!(
            YtdlpAdapter::chromium_profiles(&ls),
            vec!["Default", "Profile 1", "Profile 2"]
        );
        std::fs::write(&ls, "not json").unwrap();
        assert_eq!(YtdlpAdapter::chromium_profiles(&ls), vec!["Default"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_spotify_urls() {
        assert!(YtdlpAdapter::is_spotify_url(
            "https://open.spotify.com/track/abc"
        ));
        assert!(YtdlpAdapter::is_spotify_url("spotify:track:abc"));
        assert!(!YtdlpAdapter::is_spotify_url(
            "https://youtube.com/watch?v=abc"
        ));
    }

    #[test]
    fn extract_search_query_from_spotify() {
        let q = YtdlpAdapter::extract_search_query(
            "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp",
        );
        assert!(!q.is_empty());
    }

    #[test]
    fn extract_spotify_track_id_from_url_and_uri() {
        assert_eq!(
            YtdlpAdapter::extract_spotify_track_id(
                "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp?si=abc123"
            ),
            Some("3n3Ppam7vgaVa1iaRUc9Lp".to_string())
        );
        assert_eq!(
            YtdlpAdapter::extract_spotify_track_id("spotify:track:3n3Ppam7vgaVa1iaRUc9Lp"),
            Some("3n3Ppam7vgaVa1iaRUc9Lp".to_string())
        );
        assert_eq!(
            YtdlpAdapter::extract_spotify_track_id("https://youtube.com/watch?v=abc"),
            None
        );
    }

    #[test]
    fn sanitize_filename_works() {
        let name = sanitize_filename("Artist / Track: Name (feat. Someone)");
        assert!(!name.contains('/'));
        assert!(!name.contains(':'));
    }

    #[test]
    fn client_id_detection() {
        let js = r#"something before,{"client_id":"abcdefghijklmnopqrstuvwxyz123456"},"#;
        let id = js.find_client_id();
        assert_eq!(id.as_deref(), Some("abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn client_id_detection_variant() {
        let js = r#"var c={client_id:"abcdefghijklmnopqrstuvwx"}"#;
        let id = js.find_client_id();
        assert!(id.is_some());
    }
}
