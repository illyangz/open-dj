use crate::jobs;
use crate::state::AppState;
use opendj_core::{InputKind, Job, MutationJournal, Settings};
use opendj_file_ops::MutationRecord;
use opendj_metadata::AudioProbe;
use opendj_organization::{PlannedMove, TrackFields};
use opendj_providers::{ProviderInfo, TrackCandidate};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

/// FR-001–FR-005: parse pasted/dropped multiline input, persist it, enqueue
/// a job per line, and kick off background resolution. Returns the created
/// jobs immediately so the UI can render them in `waiting` state right away.
///
/// For playlist/album URLs, this expands them into individual track jobs
/// using yt-dlp's flat-playlist extraction.
#[tauri::command]
pub async fn ingest_inputs(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> CmdResult<Vec<Job>> {
    let inputs = opendj_core::ingest::parse_inputs(&text, "paste");
    let mut jobs = Vec::with_capacity(inputs.len());

    for input in &inputs {
        if input.kind == InputKind::Url && input.provider_id.as_deref() == Some("ytdlp") {
            // Try to expand as playlist/album
            match opendj_providers::playlist::expand_playlist(&input.raw_value).await {
                Ok(entries) if entries.len() > 1 => {
                    // Create one job per track
                    for entry in &entries {
                        let track_input = opendj_core::model::InputRecord {
                            id: Uuid::new_v4(),
                            raw_value: entry.url.clone(),
                            kind: InputKind::Url,
                            provider_id: Some("ytdlp".to_string()),
                            created_at: chrono::Utc::now(),
                            provenance: "paste".to_string(),
                            parse_status: "parsed".to_string(),
                        };
                        state
                            .store
                            .insert_input(&track_input)
                            .map_err(|e| e.to_string())?;
                        let mut job = state
                            .store
                            .create_job(track_input.id, Some("ytdlp"))
                            .map_err(|e| e.to_string())?;
                        // Pre-fill metadata from playlist resolution
                        job.title = entry.title.clone();
                        job.artist = entry.artist.clone();
                        state.store.save_job(&job).map_err(|e| e.to_string())?;
                        jobs::spawn(app.clone(), job.id);
                        jobs.push(job);
                    }
                }
                _ => {
                    // Single track or expansion failed — normal flow
                    state.store.insert_input(input).map_err(|e| e.to_string())?;
                    let job = state
                        .store
                        .create_job(input.id, input.provider_id.as_deref())
                        .map_err(|e| e.to_string())?;
                    jobs::spawn(app.clone(), job.id);
                    jobs.push(job);
                }
            }
        } else {
            // Local path, query, or non-ytdlp URL — normal flow
            state.store.insert_input(input).map_err(|e| e.to_string())?;
            let provider_id = input.provider_id.clone().or({
                if input.kind == InputKind::LocalPath {
                    Some("local_file".to_string())
                } else {
                    None
                }
            });
            let job = state
                .store
                .create_job(input.id, provider_id.as_deref())
                .map_err(|e| e.to_string())?;
            jobs::spawn(app.clone(), job.id);
            jobs.push(job);
        }
    }
    Ok(jobs)
}

#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>) -> CmdResult<Vec<Job>> {
    state.store.list_jobs().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pause_job(state: State<'_, AppState>, id: Uuid) -> CmdResult<Job> {
    state.store.pause_job(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resume_job(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> CmdResult<Job> {
    let job = state.store.resume_job(id).map_err(|e| e.to_string())?;
    jobs::spawn(app, id);
    Ok(job)
}

#[tauri::command]
pub async fn cancel_job(state: State<'_, AppState>, id: Uuid) -> CmdResult<Job> {
    state.store.cancel_job(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retry_job(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> CmdResult<Job> {
    let job = state.store.retry_job(id).map_err(|e| e.to_string())?;
    jobs::spawn(app, id);
    Ok(job)
}

#[tauri::command]
pub async fn delete_job(state: State<'_, AppState>, id: Uuid) -> CmdResult<()> {
    state.store.delete_job(id).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileScan {
    pub path: String,
    pub checksum: String,
    pub probe: AudioProbe,
}

/// FR-031: read-only inspection for the Repair workspace.
#[tauri::command]
pub async fn scan_file(path: String) -> CmdResult<FileScan> {
    let p = PathBuf::from(&path);
    let checksum = opendj_file_ops::checksum_file(&p).map_err(|e| e.to_string())?;
    let probe = opendj_metadata::probe(&p).map_err(|e| e.to_string())?;
    Ok(FileScan {
        path,
        checksum,
        probe,
    })
}

/// Detect BPM/key from the audio itself (not just tags) via `opendj_metadata`'s
/// symphonia decode + stratum-dsp analysis. Reasonably confident results are
/// written back into the file's own tags, so this only has to run once per
/// file — future `scan_file` calls will find them already tagged, and other
/// DJ software reading the same file benefits too.
#[tauri::command]
pub async fn analyze_track(
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<opendj_metadata::TrackAnalysis> {
    let _permit = state
        .analysis_semaphore
        .acquire()
        .await
        .map_err(|e| e.to_string())?;

    let p = PathBuf::from(&path);
    let analysis = tokio::task::spawn_blocking(move || opendj_metadata::analyze_track(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    // BPM is always persisted: measured directly against real tracks, its
    // *values* are accurate even when stratum-dsp's own confidence score
    // is low (a track with a known real tempo of ~113 BPM was detected at
    // 113.8 while self-reporting only 7% confidence) — the confidence
    // score is conservative, the number is usually still right. Key stays
    // gated because it only ever falls back to stratum-dsp's own guess
    // when libkeyfinder isn't available (libkeyfinder's result is pinned
    // to 1.0 confidence upstream, so it always clears this bar); a wrong
    // key written into a file's tags is worse than leaving it blank, since
    // other DJ software will trust it too.
    //
    // KEY_CONFIDENCE_THRESHOLD is calibrated against stratum-dsp's own
    // confidence scale, not an absolute 0-1 "percent correct" — measured
    // directly against real downloads, its key_confidence sits around
    // 0.04-0.08 even on harmonically simple, correctly-detected tracks. A
    // 0.3 cutoff was silently discarding nearly every result; this is set
    // just above the observed noise floor instead.
    const KEY_CONFIDENCE_THRESHOLD: f32 = 0.03;

    {
        let existing = opendj_metadata::probe(&PathBuf::from(&path))
            .map(|p| p.tags)
            .unwrap_or_default();
        let fields = opendj_metadata::TagFields {
            bpm: Some(analysis.bpm as f64),
            key: if analysis.key_confidence > KEY_CONFIDENCE_THRESHOLD {
                Some(analysis.key.clone())
            } else {
                existing.key
            },
            ..existing
        };
        let _ = opendj_metadata::write_tags(&PathBuf::from(&path), &fields);
    }

    Ok(analysis)
}

/// Render a waveform PNG for a local audio file via ffmpeg's `showwavespic`
/// filter and return it as a data URI. Results are cached on disk keyed by
/// the file path, so re-opening the Library tab doesn't re-render every
/// waveform on every load.
#[tauri::command]
pub async fn generate_waveform(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<String> {
    use sha2::{Digest, Sha256};

    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("waveforms");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let digest = hasher.finalize();
    let cache_path = cache_dir.join(format!("{:x}.png", digest));

    if !cache_path.exists() {
        let ffmpeg = opendj_providers::yt_dlp_bin::find_ffmpeg()
            .ok_or("ffmpeg not found. Install it with: brew install ffmpeg".to_string())?;

        let _permit = state
            .analysis_semaphore
            .acquire()
            .await
            .map_err(|e| e.to_string())?;

        let output = tokio::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-i",
                &path,
                "-filter_complex",
                "aformat=channel_layouts=mono,showwavespic=s=640x100:colors=#e8ff6b",
                "-frames:v",
                "1",
                &cache_path.to_string_lossy(),
            ])
            .env("PATH", opendj_providers::yt_dlp_bin::augmented_path())
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg waveform render failed: {stderr}"));
        }
    }

    let bytes = tokio::fs::read(&cache_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
    ))
}

#[derive(Debug, Serialize)]
pub struct ReplacementPreview {
    pub original: FileScan,
    pub candidate: FileScan,
    pub backup_directory: String,
}

/// FR-032: preview a proposed replacement without mutating anything.
#[tauri::command]
pub async fn preview_replacement(
    state: State<'_, AppState>,
    original_path: String,
    candidate_path: String,
) -> CmdResult<ReplacementPreview> {
    let original = scan_file(original_path).await?;
    let candidate = scan_file(candidate_path).await?;
    let backup_directory = state.backup_root.read().await.to_string_lossy().to_string();
    Ok(ReplacementPreview {
        original,
        candidate,
        backup_directory,
    })
}

/// FR-034–FR-036: back up, atomically replace, and journal the mutation.
#[tauri::command]
pub async fn apply_replacement(
    state: State<'_, AppState>,
    original_path: String,
    candidate_path: String,
) -> CmdResult<MutationRecord> {
    let original = PathBuf::from(&original_path);
    let candidate = PathBuf::from(&candidate_path);
    let backup_root = state.backup_root.read().await.clone();

    let record = tokio::task::spawn_blocking(move || {
        opendj_file_ops::replace_atomic(&original, &candidate, &backup_root)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let journal = MutationJournal {
        id: Uuid::new_v4(),
        job_id: None,
        original_path: record.original_path.clone(),
        backup_path: record.backup_path.clone(),
        original_checksum: record.original_checksum.clone(),
        replacement_checksum: Some(record.replacement_checksum.clone()),
        state: opendj_core::MutationState::Applied,
        created_at: record.created_at,
    };
    state
        .store
        .insert_mutation_journal(&journal)
        .map_err(|e| e.to_string())?;

    Ok(record)
}

#[tauri::command]
pub async fn list_mutation_journal(state: State<'_, AppState>) -> CmdResult<Vec<MutationJournal>> {
    state
        .store
        .list_mutation_journal()
        .map_err(|e| e.to_string())
}

/// FR-037: restore the original file from a prior mutation's backup.
#[tauri::command]
pub async fn restore_mutation(state: State<'_, AppState>, journal_id: Uuid) -> CmdResult<String> {
    let journal = state
        .store
        .get_mutation_journal(journal_id)
        .map_err(|e| e.to_string())?;
    let backup = PathBuf::from(&journal.backup_path);
    let original = PathBuf::from(&journal.original_path);

    let checksum = tokio::task::spawn_blocking(move || {
        opendj_file_ops::restore_from_backup(&backup, &original)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    state
        .store
        .set_mutation_state(journal_id, opendj_core::MutationState::RestoredFromBackup)
        .map_err(|e| e.to_string())?;
    Ok(checksum)
}

#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> CmdResult<Vec<ProviderInfo>> {
    Ok(state.providers.read().await.list())
}

/// FR-050–FR-053: free-text search via yt-dlp (YouTube by default).
#[tauri::command]
pub async fn search_providers(
    state: State<'_, AppState>,
    query: String,
    provider_id: Option<String>,
) -> CmdResult<Vec<TrackCandidate>> {
    let registry = state.providers.read().await.clone();

    // If a specific provider is requested, use it; otherwise default to ytdlp
    if let Some(id) = provider_id {
        if let Some(provider) = registry.get(&id) {
            return provider.search(&query).await.map_err(|e| e.to_string());
        }
    }

    // Default: search via yt-dlp
    if let Some(provider) = registry.get("ytdlp") {
        return provider.search(&query).await.map_err(|e| e.to_string());
    }

    Ok(vec![])
}

#[tauri::command]
pub async fn build_organization_plan(
    tracks: Vec<TrackFields>,
    folder_template: String,
    destination_root: String,
    existing_destinations: Vec<String>,
) -> CmdResult<Vec<PlannedMove>> {
    let template = opendj_organization::FolderTemplate::new(folder_template);
    Ok(opendj_organization::build_plan(
        &tracks,
        &template,
        &destination_root,
        &existing_destinations,
    ))
}

#[tauri::command]
pub async fn find_duplicate_tracks(tracks: Vec<TrackFields>) -> CmdResult<Vec<Vec<String>>> {
    Ok(opendj_organization::find_duplicates(&tracks))
}

const LIBRARY_AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "aiff", "m4a", "ogg", "opus"];

/// FR-040/FR-041: recursively list audio files under a directory so the
/// Library workspace can build a dry-run organization plan.
#[tauri::command]
pub async fn scan_library_folder(directory: String) -> CmdResult<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&directory);
        let mut found = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
            for entry in entries {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if LIBRARY_AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
                        found.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        Ok(found)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Used only for user-initiated exports where the user already chose the
/// destination path via a native save dialog (FR-044 plan export,
/// diagnostics export).
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> CmdResult<()> {
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    state.store.get_settings().map_err(|e| e.to_string())
}

/// FR-060–FR-064: persists settings and, if download/backup roots changed,
/// updates the in-memory paths the job engine and Repair commands use.
#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> CmdResult<()> {
    state
        .store
        .save_settings(&settings)
        .map_err(|e| e.to_string())?;
    if !settings.download_root.is_empty() {
        let new_root = PathBuf::from(&settings.download_root);
        // Extend the asset:// scope so waveforms/playback keep working if
        // the user points downloads at a new folder mid-session.
        let _ = app.asset_protocol_scope().allow_directory(&new_root, true);
        *state.download_root.write().await = new_root;
    }
    let providers = state.providers.read().await;
    let cookies_browser = (!settings.youtube_cookies_browser.is_empty())
        .then(|| settings.youtube_cookies_browser.clone());
    providers.set_cookies_browser(cookies_browser);
    let cookies_file =
        (!settings.youtube_cookies_file.is_empty()).then(|| settings.youtube_cookies_file.clone());
    providers.set_cookies_file(cookies_file);
    Ok(())
}

/// Check whether yt-dlp and ffmpeg are available, returning their paths
/// and versions for display in the Settings UI.
#[tauri::command]
pub async fn check_system_tools() -> CmdResult<SystemToolsStatus> {
    let ytdlp_path = opendj_providers::yt_dlp_bin::find_ytdlp();
    let ffmpeg_path = opendj_providers::yt_dlp_bin::find_ffmpeg();

    let ytdlp_version = if let Some(ref p) = ytdlp_path {
        let output = tokio::process::Command::new(p)
            .arg("--version")
            .env("PATH", opendj_providers::yt_dlp_bin::augmented_path())
            .output()
            .await;
        output
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        None
    };

    let ffmpeg_version = if let Some(ref p) = ffmpeg_path {
        let output = tokio::process::Command::new(p)
            .args(["-version"])
            .env("PATH", opendj_providers::yt_dlp_bin::augmented_path())
            .output()
            .await;
        output.ok().and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|s| s.trim().to_string())
        })
    } else {
        None
    };

    Ok(SystemToolsStatus {
        ytdlp_path: ytdlp_path.map(|p| p.to_string_lossy().to_string()),
        ytdlp_version,
        ffmpeg_path: ffmpeg_path.map(|p| p.to_string_lossy().to_string()),
        ffmpeg_version,
    })
}

#[derive(Debug, Serialize)]
pub struct SystemToolsStatus {
    pub ytdlp_path: Option<String>,
    pub ytdlp_version: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub ffmpeg_version: Option<String>,
}

// ── SoundCloud Likes Extractor ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScTrack {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub artwork: Option<String>,
    pub url: String,
    pub duration: u64,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub genre: Option<String>,
    pub transcode_url: Option<String>,
}

/// Fetch a SoundCloud user's likes by username.
/// Auto-detects client_id from the SoundCloud website — no API key needed.
#[tauri::command]
pub async fn fetch_soundcloud_likes(username: String) -> CmdResult<Vec<ScTrack>> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    // Step 1: Detect client_id
    let html = client
        .get("https://soundcloud.com/discover")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let mut scripts = Vec::new();
    let mut search_from = 0;
    while let Some(idx) = html[search_from..].find("src=\"https://a-v2.sndcdn.com/assets/") {
        let abs = search_from + idx;
        // skip past src=" to get to the URL itself
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

    let mut client_id = String::new();
    for src in scripts.iter().rev().take(8) {
        if let Ok(js) = client.get(src.as_str()).send().await {
            if let Ok(text) = js.text().await {
                for pat in &[
                    "\"client_id\":\"",
                    "client_id:\"",
                    "client_id:'",
                    ",client_id:",
                    "{client_id:",
                ] {
                    if let Some(idx) = text.find(pat) {
                        let start = idx + pat.len();
                        let rest = &text[start..];
                        let id: String = rest.chars().take_while(|c| c.is_alphanumeric()).collect();
                        if id.len() >= 20 && id.len() <= 42 {
                            client_id = id;
                            break;
                        }
                    }
                }
                if !client_id.is_empty() {
                    break;
                }
            }
        }
    }

    if client_id.is_empty() {
        return Err("Could not detect SoundCloud client_id".into());
    }

    // Step 2: Resolve user — accept bare username or full URL
    let username = username
        .trim()
        .trim_start_matches('@')
        .trim_end_matches('/')
        .trim_end_matches('?')
        .replace("https://", "")
        .replace("http://", "");
    // Strip soundcloud.com/ or www.soundcloud.com/ prefix
    let username = if let Some(rest) = username.strip_prefix("www.soundcloud.com/") {
        rest.to_string()
    } else if let Some(rest) = username.strip_prefix("soundcloud.com/") {
        rest.to_string()
    } else {
        username
    };
    let resolve_url = format!(
        "https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/{}&client_id={}",
        username, client_id
    );

    #[derive(Deserialize)]
    struct ScUser {
        id: u64,
    }

    let user: ScUser = client
        .get(&resolve_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if user.id == 0 {
        return Err(format!("User @{} not found", username));
    }

    // Step 3: Fetch all likes (paginated)
    let mut tracks = Vec::new();
    let mut next_url = Some(format!(
        "https://api-v2.soundcloud.com/users/{}/likes?limit=200&client_id={}",
        user.id, client_id
    ));

    #[derive(Deserialize)]
    struct LikesResp {
        collection: Vec<LikesItem>,
        next_href: Option<String>,
    }

    #[derive(Deserialize)]
    struct LikesItem {
        track: Option<LikesTrack>,
    }

    #[derive(Deserialize)]
    struct LikesTrack {
        id: u64,
        title: Option<String>,
        duration: Option<u64>,
        permalink_url: Option<String>,
        artwork_url: Option<String>,
        bpm: Option<f64>,
        key_signature: Option<String>,
        genre: Option<String>,
        publisher_metadata: Option<PublisherMeta>,
        user: Option<LikesUser>,
        media: Option<LikesMedia>,
    }

    #[derive(Deserialize)]
    struct PublisherMeta {
        artist: Option<String>,
    }

    #[derive(Deserialize)]
    struct LikesUser {
        username: Option<String>,
    }

    #[derive(Deserialize)]
    struct LikesMedia {
        transcodings: Option<Vec<LikesTranscoding>>,
    }

    #[derive(Deserialize)]
    struct LikesTranscoding {
        url: Option<String>,
        format: Option<LikesFormat>,
        snipped: Option<bool>,
    }

    #[derive(Deserialize)]
    struct LikesFormat {
        protocol: Option<String>,
    }

    while let Some(url) = next_url {
        let resp_text = client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;

        let data: LikesResp = serde_json::from_str(&resp_text).map_err(|e| e.to_string())?;

        for item in data.collection {
            if let Some(t) = item.track {
                let title = t.title.unwrap_or_else(|| "Untitled".to_string());
                let artist = t
                    .publisher_metadata
                    .and_then(|pm| pm.artist)
                    .or_else(|| t.user.and_then(|u| u.username))
                    .unwrap_or_else(|| "Unknown".to_string());

                let artwork = t.artwork_url.map(|a| a.replace("-large", "-t300x300"));

                let transcode_url = t.media.and_then(|m| m.transcodings).and_then(|tc| {
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

                tracks.push(ScTrack {
                    id: t.id,
                    title,
                    artist,
                    artwork,
                    url: t.permalink_url.unwrap_or_default(),
                    duration: t.duration.unwrap_or(0),
                    bpm: t.bpm,
                    key: t.key_signature,
                    genre: t.genre,
                    transcode_url,
                });
            }
        }

        if let Some(nh) = data.next_href {
            let sep = if nh.contains('?') { "&" } else { "?" };
            next_url = Some(format!("{nh}{sep}client_id={client_id}"));
            // Gentle rate-limit
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        } else {
            next_url = None;
        }
    }

    Ok(tracks)
}

/// Download a SoundCloud track directly to the download folder.
#[tauri::command]
pub async fn download_soundcloud_track(
    state: State<'_, AppState>,
    sc_track: ScTrack,
) -> CmdResult<String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    // Get the actual stream URL from the transcoding endpoint
    let transcode_url = sc_track
        .transcode_url
        .ok_or("No transcoding URL available for this track")?;

    // Detect client_id (reuse logic)
    let html = client
        .get("https://soundcloud.com/discover")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let mut client_id = String::new();
    for (idx, _) in html.match_indices("src=\"https://a-v2.sndcdn.com/assets/") {
        let rest = &html[idx..];
        let end = rest.find('"').unwrap_or(0);
        let url = &rest[5..end];
        if url.ends_with(".js") {
            if let Ok(js) = client.get(url).send().await {
                if let Ok(text) = js.text().await {
                    if let Some(pat_idx) = text.find("client_id:\"") {
                        let start = pat_idx + "client_id:\"".len();
                        let id: String = text[start..]
                            .chars()
                            .take_while(|c| c.is_alphanumeric())
                            .collect();
                        if id.len() >= 20 && id.len() <= 42 {
                            client_id = id;
                            break;
                        }
                    }
                }
            }
        }
    }

    if client_id.is_empty() {
        return Err("Could not detect SoundCloud client_id".into());
    }

    // Resolve the actual CDN stream URL
    let stream_resp = client
        .get(format!("{transcode_url}?client_id={client_id}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    struct StreamUrl {
        url: String,
    }

    let stream: StreamUrl = stream_resp.json().await.map_err(|e| e.to_string())?;

    // Download the MP3 bytes
    let resp = client
        .get(&stream.url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    let dest_dir = state.download_root.read().await.clone();
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| e.to_string())?;

    let safe_name = format!("{} - {}", sc_track.artist, sc_track.title);
    let file_name: String = safe_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let file_name = file_name.split_whitespace().collect::<Vec<_>>().join(" ");

    let dest_path = dest_dir.join(format!("{file_name}.mp3"));
    tokio::fs::write(&dest_path, &bytes)
        .await
        .map_err(|e| e.to_string())?;

    Ok(dest_path.to_string_lossy().to_string())
}

#[derive(Debug, Serialize)]
pub struct Diagnostics {
    pub app_version: String,
    pub job_count: usize,
    pub mutation_count: usize,
    pub providers: Vec<ProviderInfo>,
}

/// FR-063: a redacted diagnostics summary — counts and versions only, never
/// file paths, audio bytes, or credentials.
#[tauri::command]
pub async fn export_diagnostics(state: State<'_, AppState>) -> CmdResult<Diagnostics> {
    let jobs = state.store.list_jobs().map_err(|e| e.to_string())?;
    let mutations = state
        .store
        .list_mutation_journal()
        .map_err(|e| e.to_string())?;
    let providers = state.providers.read().await.list();
    Ok(Diagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        job_count: jobs.len(),
        mutation_count: mutations.len(),
        providers,
    })
}
