# Plan: yt-dlp Universal Download Adapter

## Goal

Replace per-platform API-key providers with a single yt-dlp adapter that handles
YouTube, SoundCloud, Spotify, Beatport, Apple Music, Deezer, and 1800+ other
sites. Paste a link, get a 320kbps MP3. No API keys. No setup. Playlists and
albums auto-expand into individual download jobs.

## Architecture Change

**Before:**
```
YouTube (oEmbed, metadata only, no API key)
Spotify (Web API, metadata only, needs client_id + secret)
SoundCloud (REST API, needs client_id, downloads only if track flagged downloadable)
Direct URL (HTTP GET, only audio file URLs)
Local File (probe only)
```

**After:**
```
yt-dlp (universal: metadata + download for all streaming platforms)
Local File (probe only, unchanged)
```

yt-dlp is invoked as a subprocess via `tokio::process::Command`. It handles
metadata extraction, audio download, MP3 conversion (320kbps), and metadata
embedding in a single pipeline.

---

## File Changes

### 1. New: `crates/providers/src/adapters/ytdlp.rs` — yt-dlp adapter

Core adapter that wraps yt-dlp as a subprocess.

```rust
pub struct YtdlpAdapter { /* empty — stateless */ }
```

**`validate_input(raw)`**: Accepts any `http(s)://` URL. yt-dlp figures out
whether it's a supported site. For Spotify URLs specifically, the adapter
sets a flag on the `TrackCandidate` so the UI can display:
"Audio sourced from YouTube — quality varies."

**`resolve_metadata(raw)`**: Runs `yt-dlp --dump-json --no-download <url>`.
Parses JSON output to extract:
- `title` → `title`
- `artist` or `uploader` → `artist`
- `album` or `playlist_title` → `album`
- `duration` (seconds, f64) → `duration_ms`
- `id` → `id`
- `webpage_url` → `source_url`

Returns single `TrackCandidate` with `downloadable: true`.

**`fetch(candidate, dest_dir)`**: Runs:
```
yt-dlp -x --audio-format mp3 --audio-quality 320K
  --output "<dest_dir>/%(title)s - %(artist)s.%(ext)s"
  --no-playlist
  --parse-metadata "%(title)s:%(meta_title)s"
  --parse-metadata "%(artist)s:%(meta_artist)s"
  --parse-metadata "%(album)s:%(meta_album)s"
  <source_url>
```

Returns the path of the downloaded file. yt-dlp + ffmpeg handle conversion
and metadata embedding.

**`search(query)`**: Runs `yt-dlp "ytsearch10:<query>" --dump-json --no-download`
(defaulting to YouTube search). Parses multiple results. Returns `Vec<TrackCandidate>`.

**Error handling**: If yt-dlp binary is not found → `ProviderError::NotConfigured("yt-dlp")`.
If yt-dlp exits non-zero → `ProviderError::Io` with stderr message.

### 2. New: `crates/providers/src/yt_dlp_bin.rs` — Binary resolution

Locates yt-dlp and ffmpeg executables. Resolution order:

1. **App bundle resources** — `resource_dir()/yt-dlp` (or `yt-dlp.exe`)
2. **System PATH** — `which yt-dlp` / `which ffmpeg`

Functions:
```rust
pub fn find_ytdlp() -> Option<PathBuf>
pub fn find_ffmpeg() -> Option<PathBuf>
pub fn check_tools() -> Result<(PathBuf, PathBuf), MissingTool>
```

`MissingTool` enum: `Ytdlp | Fmtpeg | Both` — used for user-facing error messages.

### 3. Modify: `crates/providers/src/adapters/mod.rs`

- Remove: `soundcloud`, `spotify`, `youtube` modules
- Add: `ytdlp` module
- Re-export: `YtdlpAdapter`

### 4. Modify: `crates/providers/src/lib.rs`

- Remove `ProviderCredentials` import (no longer needed)
- No changes to `ProviderAdapter` trait, `TrackCandidate`, `ProviderError`, etc.

### 5. Modify: `crates/providers/src/registry.rs`

- Remove `ProviderCredentials` struct and all credential logic
- Registry becomes:
  ```rust
  ProviderRegistry::new() -> Self {
      providers: vec![
          Arc::new(LocalFileProvider),
          Arc::new(YtdlpAdapter::new()),
      ]
  }
  ```
- `detect_for()`: YtdlpAdapter matches any URL, LocalFileProvider matches local paths.
  Order: LocalFile first (more specific), Ytdlp second (catches all URLs).

### 6. Modify: `crates/providers/Cargo.toml`

No new Rust crate dependencies needed — yt-dlp is invoked as a subprocess.
(If we later want richer JSON parsing, add `serde_json` — already a workspace dep.)

### 7. Modify: `crates/core/src/ingest.rs` — `guess_provider()`

Update domain list to route all streaming platform URLs to `"ytdlp"`:
```rust
("youtube.com", "ytdlp"),
("youtu.be", "ytdlp"),
("spotify.com", "ytdlp"),
("soundcloud.com", "ytdlp"),
("beatport.com", "ytdlp"),
("music.apple.com", "ytdlp"),
("deezer.com", "ytdlp"),
("junodownload.com", "ytdlp"),
```

Unknown URLs still fall through to `"ytdlp"` (instead of `"direct_url"`)
since yt-dlp handles 1800+ sites.

### 8. New: `crates/providers/src/playlist.rs` — Playlist expansion

```rust
pub async fn expand_playlist(url: &str, ytdlp_path: &Path) -> Result<Vec<PlaylistEntry>>
```

Runs `yt-dlp --flat-playlist --dump-json <url>`. Each line is a JSON object
with `url`, `title`, `uploader`, `duration`, `playlist_index`.

`PlaylistEntry` struct:
```rust
pub struct PlaylistEntry {
    pub url: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub duration_ms: Option<u64>,
    pub index: Option<u32>,
}
```

If the URL is a single track (not a playlist), yt-dlp returns one entry.
If it's a playlist/album, it returns all entries.

### 9. Modify: `apps/desktop/src-tauri/src/commands.rs` — `ingest_inputs`

Before creating jobs, expand playlists:

```rust
pub async fn ingest_inputs(app, state, text) -> Result<Vec<Job>> {
    let inputs = parse_inputs(&text, "paste");
    let ytdlp = find_ytdlp().ok_or("yt-dlp not found")?;
    let mut jobs = Vec::new();

    for input in &inputs {
        if input.kind == InputKind::Url {
            // Try to expand as playlist
            match expand_playlist(&input.raw_value, &ytdlp).await {
                Ok(entries) if entries.len() > 1 => {
                    // Create one job per track
                    for entry in &entries {
                        let track_input = InputRecord { raw_value: entry.url.clone(), .. };
                        store.insert_input(&track_input)?;
                        let job = store.create_job(track_input.id, Some("ytdlp"))?;
                        // Set title/artist on the job immediately
                        job.title = entry.title.clone();
                        job.artist = entry.artist.clone();
                        store.save_job(&job)?;
                        jobs::spawn(app.clone(), job.id);
                        jobs.push(job);
                    }
                }
                _ => {
                    // Single track — normal flow
                    store.insert_input(input)?;
                    let job = store.create_job(input.id, Some("ytdlp"))?;
                    jobs::spawn(app.clone(), job.id);
                    jobs.push(job);
                }
            }
        } else {
            // Local path or query — normal flow
            store.insert_input(input)?;
            let job = store.create_job(input.id, provider_id.as_deref())?;
            jobs::spawn(app.clone(), job.id);
            jobs.push(job);
        }
    }
    Ok(jobs)
}
```

### 10. Modify: `apps/desktop/src-tauri/src/state.rs`

- Remove `ProviderCredentials` and `load_credentials()`
- `AppState::new()` no longer takes credentials
- `rebuild_providers()` becomes a no-op or can be removed

### 11. Modify: `apps/desktop/src-tauri/src/jobs.rs`

The job runner already handles the full pipeline. Minor changes:
- When resolving, if yt-dlp returns metadata during `resolve_metadata()`, the
  job already gets title/artist. No change needed.
- The `Downloading` state calls `provider.fetch()` which runs yt-dlp with
  `--audio-format mp3 --audio-quality 320K`. No change needed.
- Remove the `AwaitingConfirmation` gate for providers without download
  capability — yt-dlp always downloads. (Keep the gate for `LocalFile` path.)

### 12. Modify: `apps/desktop/src-tauri/src/commands.rs` — `search_providers`

Update to use yt-dlp search:
```rust
pub async fn search_providers(state, query, provider_id) -> Result<Vec<TrackCandidate>> {
    let registry = state.providers.read().await.clone();
    if let Some(provider) = registry.get("ytdlp") {
        return provider.search(&query).await.map_err(|e| e.to_string());
    }
    Ok(vec![])
}
```

### 13. Modify: `apps/desktop/src-tauri/src/commands.rs` — `update_provider_config`

Remove or simplify. No more per-provider credentials to update.
Could keep for future use or remove entirely.

### 14. Modify: `apps/desktop/src-tauri/tauri.conf.json`

Add external binaries to bundle:
```json
{
  "bundle": {
    "externalBin": [
      "binaries/yt-dlp",
      "binaries/ffmpeg"
    ]
  }
}
```

### 15. Modify: `apps/desktop/src-tauri/Cargo.toml`

Add `which` crate for PATH lookup:
```toml
which = "7"
```

### 16. Modify: Frontend — `SettingsWorkspace.tsx`

- Remove the entire "Provider credentials" section (SoundCloud/Spotify inputs)
- Add "System tools" section showing yt-dlp + ffmpeg status:
  ```
  System tools
  yt-dlp    ✓ v2024.x.x    (bundled / system)
  ffmpeg    ✓ v7.x          (bundled / system)
  ```
- Add a "Check for updates" button for bundled tools (future)

### 17. Modify: Frontend — `IngestDial.tsx`

Update placeholder text:
```
Paste YouTube, Spotify, SoundCloud, Beatport, Deezer... links (one per line)
```

Add Spotify quality warning: when a Spotify URL is detected in the textarea,
show a small note below it: "Audio will be sourced from YouTube — quality varies."

### 17b. Modify: Frontend — `QueueList.tsx` / `Inspector.tsx`

Show a quality notice on jobs where `provider_id == "ytdlp"` and the source
was Spotify. Could use the `source_url` field on the candidate to detect this.

### 18. Modify: Frontend — `AppShell.tsx`

Simplify or remove "Automations" workspace tab (was placeholder for
Spotify Shazam integration). Or repurpose it.

### 19. Modify: Frontend — `types.ts`

No structural changes needed. `ProviderInfo` and `Capabilities` stay the same.

### 20. Modify: `PROVIDER_POLICY.md`

Update the provider status table:

| Provider | Metadata | Audio download | Basis |
|---|---|---|---|
| Local files | Yes | N/A | Already on disk |
| yt-dlp (universal) | Yes | Yes | User-supplied URL. yt-dlp extracts publicly available audio streams. User asserts lawful right to download. |
| ~~Spotify~~ | ~~Removed~~ | ~~Removed~~ | Replaced by yt-dlp |
| ~~SoundCloud~~ | ~~Removed~~ | ~~Removed~~ | Replaced by yt-dlp |
| ~~YouTube~~ | ~~Removed~~ | ~~Removed~~ | Replaced by yt-dlp |

Add note: yt-dlp supports 1800+ sites. The legal basis is the same as
Direct URL — the user supplies a URL and asserts they are authorized to
download. yt-dlp does not circumvent DRM; it extracts publicly accessible
audio streams where available.

### 21. Modify: Existing tests

- `registry::tests` — update for new registry (no credentials)
- `ingest::tests` — update `guess_provider` expectations
- Remove Spotify/SoundCloud adapter unit tests
- Add YtdlpAdapter tests (mock yt-dlp output)

---

## Bundling Strategy

### macOS
- Download `yt-dlp` standalone binary (PyInstaller build) for macOS arm64
- Download `ffmpeg` static binary for macOS arm64 from evermeet.cx
- Place in `apps/desktop/src-tauri/binaries/`:
  - `yt-dlp-aarch64-apple-darwin`
  - `ffmpeg-aarch64-apple-darwin`
- Tauri renames to `yt-dlp` and `ffmpeg` at build time in the app bundle

### Build script
Add `apps/desktop/src-tauri/build.rs` logic to download binaries if not present:
```rust
// In build.rs: download yt-dlp + ffmpeg if binaries/ doesn't have them
// Or provide a script: scripts/fetch-binaries.sh
```

### Alternative: runtime download
On first launch, if binaries not found in bundle or PATH, prompt user to
install via `brew install yt-dlp ffmpeg` (macOS) or download automatically.

---

## Sequencing

1. **Binary resolver** (`yt_dlp_bin.rs`) — foundation, testable independently
2. **Ytdlp adapter** (`adapters/ytdlp.rs`) — core functionality
3. **Playlist expansion** (`playlist.rs`) — needed by ingest
4. **Registry cleanup** — remove old adapters, wire new one
5. **Ingest layer** — playlist expansion in `ingest_inputs`
6. **Job runner** — minor adjustments
7. **Frontend** — settings, ingest dial, provider display
8. **Bundling** — build.rs, tauri.conf.json, binary downloads
9. **PROVIDER_POLICY.md** — update documentation
10. **Tests** — update all affected tests

---

## Decisions

- **Spotify quality warning**: When a Spotify URL is detected, show a note:
  "Audio sourced from YouTube — quality varies."
- **Binary distribution**: Build-time download. A `scripts/fetch-binaries.sh`
  script downloads yt-dlp + ffmpeg static binaries for the target platform
  during `cargo build`. Binaries are committed to the repo or cached in
  `target/` (gitignored).

## Open Questions

- **yt-dlp updates**: How to handle yt-dlp version updates? Bundled binary
  becomes stale. Could add auto-update check on app launch.
- **Search scope**: yt-dlp search defaults to YouTube. Should we search
  SoundCloud/other platforms too?
- **Playlist ordering**: Should tracks in expanded playlists preserve the
  original playlist order? (yt-dlp provides `playlist_index`.)
