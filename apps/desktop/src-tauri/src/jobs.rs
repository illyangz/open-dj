use crate::state::AppState;
use opendj_core::{InputKind, JobState, SuggestedMatch};
use opendj_providers::{matching, ProviderError, TrackCandidate, TrackHint};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

pub const QUEUE_UPDATED_EVENT: &str = "queue-updated";

/// Emit the current state of a single job. The frontend patches this one
/// row into its queue array instead of re-fetching the whole list — with
/// thousands of jobs in flight, a full `list_jobs()` round-trip per state
/// change would mean O(n) work (and an O(n) IPC payload) on every progress
/// tick across the whole queue, not just the job that changed.
fn emit_job(app: &AppHandle, state: &AppState, job_id: Uuid) {
    if let Ok(job) = state.store.get_job(job_id) {
        let _ = app.emit(QUEUE_UPDATED_EVENT, job);
    }
}

/// FR-010–FR-016: resolve and (where permitted) download a single job in
/// the background, emitting `queue-updated` after every state change so the
/// Queue workspace reflects progress without polling.
pub fn spawn(app: AppHandle, job_id: Uuid) {
    tokio::spawn(async move {
        let state = app.state::<AppState>();
        let _permit = state.network_semaphore.acquire().await;
        if let Err(err) = run(&app, &state, job_id).await {
            let _ = state.store.fail_job(job_id, "job_failed", &err);
        }
        emit_job(&app, &state, job_id);
    });
}

/// FR: "save this playlist as a crate" — when a finished job lands on a
/// file, add that file to every crate the user linked the job's input to
/// at ingest time. Idempotent (`add_track_to_crate` is a no-op if the
/// track is already a member), so it's safe to run on every completion.
fn sync_crate_memberships(state: &AppState, input_id: Uuid, destination: &str) {
    if let Ok(ids) = state.store.crate_ids_for_input(input_id) {
        for crate_id in ids {
            let _ = state.store.add_track_to_crate(crate_id, destination);
        }
    }
}

async fn run(app: &AppHandle, state: &AppState, job_id: Uuid) -> Result<(), String> {
    // A job may have been cancelled or paused while queued behind the
    // concurrency semaphore; re-check before doing any work.
    let job = state.store.get_job(job_id).map_err(|e| e.to_string())?;
    if !matches!(job.state, JobState::Waiting) {
        return Ok(());
    }

    let input = state
        .store
        .get_input(job.input_id)
        .map_err(|e| e.to_string())?;
    state
        .store
        .set_progress(job_id, JobState::Resolving, 0.1)
        .map_err(|e| e.to_string())?;
    emit_job(app, state, job_id);

    let registry = state.providers.read().await.clone();
    let provider = job
        .provider_id
        .as_deref()
        .and_then(|id| registry.get(id))
        .or_else(|| registry.detect_for(&input.raw_value));

    let Some(provider) = provider else {
        state
            .store
            .fail_job(job_id, "no_provider", "No provider could handle this input")
            .map_err(|e| e.to_string())?;
        return Ok(());
    };

    let candidate = if let Some(approved) = job.suggested_match.clone() {
        // The user approved a "needs review" match: download exactly that
        // upload rather than searching again (results can shift).
        TrackCandidate {
            id: approved.source_url.clone(),
            title: job.title.clone().unwrap_or(approved.upload_title),
            artist: job.artist.clone(),
            album: None,
            duration_ms: approved.duration_ms,
            provider: provider.id().to_string(),
            source_url: approved.source_url,
            confidence: 1.0,
            downloadable: true,
            matched_upload: None,
        }
    } else {
        // Playlist expansion pre-fills title/artist from the collection
        // listing; pass them along so a throttled per-track Spotify lookup
        // can still search by the real song name. On a retry these come
        // from the previous resolution, which tags the artist "(via …)".
        let hint = job.title.clone().map(|title| TrackHint {
            title,
            artist: job.artist.as_deref().map(|a| {
                a.trim_end_matches(" (via YouTube)")
                    .trim_end_matches(" (via SoundCloud)")
                    .to_string()
            }),
        });
        let resolved = provider
            .resolve_metadata_hinted(&input.raw_value, hint.as_ref())
            .await;
        let candidates = match resolved {
            Ok(c) => c,
            Err(ProviderError::NoConfidentMatch(msg)) => {
                state
                    .store
                    .fail_job(job_id, "no_accurate_match", &msg)
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err(e) => return Err(e.to_string()),
        };
        candidates
            .into_iter()
            .next()
            .ok_or("No match found for this input")?
    };

    // Found by search but not certain: hold for the user instead of
    // downloading something that may be the wrong song.
    if let Some(upload) = candidate
        .matched_upload
        .clone()
        .filter(|_| candidate.confidence < matching::AUTO_ACCEPT)
    {
        let mut job = state.store.get_job(job_id).map_err(|e| e.to_string())?;
        job.title = Some(candidate.title.clone());
        job.artist = candidate.artist.clone();
        job.provider_id = Some(provider.id().to_string());
        job.state = JobState::AwaitingConfirmation;
        job.progress = 1.0;
        job.error_class = Some("needs_review".to_string());
        job.error_message = Some(format!(
            "Not sure this is the right file ({}% match). Check it, then approve to download or search again.",
            (candidate.confidence * 100.0).round()
        ));
        job.suggested_match = Some(SuggestedMatch {
            source_url: candidate.source_url.clone(),
            platform: upload.platform,
            upload_title: upload.title,
            uploader: upload.uploader,
            duration_ms: upload.duration_ms,
            score: candidate.confidence,
        });
        job.updated_at = chrono::Utc::now();
        state.store.save_job(&job).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let mut job = state.store.get_job(job_id).map_err(|e| e.to_string())?;
    job.title = Some(candidate.title.clone());
    job.artist = candidate.artist.clone();
    job.provider_id = Some(provider.id().to_string());
    state.store.save_job(&job).map_err(|e| e.to_string())?;

    if input.kind == InputKind::LocalPath {
        // Already on disk: nothing to resolve or fetch. Repair/replace is a
        // separate, explicit workflow (see `commands::preview_replacement`).
        job.destination = Some(candidate.source_url.clone());
        job.state = JobState::Complete;
        job.progress = 1.0;
        state.store.save_job(&job).map_err(|e| e.to_string())?;
        if let Some(dest) = &job.destination {
            sync_crate_memberships(state, job.input_id, dest);
        }
        return Ok(());
    }

    if !provider.capabilities().download || !candidate.downloadable {
        // PROVIDER_POLICY.md: metadata-only providers (Spotify, YouTube), or
        // a source-flagged non-downloadable track, stop here by design —
        // this is a resolved result awaiting a manual/legitimate next step,
        // not a failure.
        state
            .store
            .set_progress(job_id, JobState::AwaitingConfirmation, 1.0)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    state
        .store
        .set_progress(job_id, JobState::Downloading, 0.4)
        .map_err(|e| e.to_string())?;
    emit_job(app, state, job_id);
    let dest_dir = state.download_root.read().await.clone();
    let format_str = job.requested_format.as_deref().unwrap_or("mp3");
    let path = provider
        .fetch(&candidate, &dest_dir, format_str)
        .await
        .map_err(|e| e.to_string())?;

    let mut job = state.store.get_job(job_id).map_err(|e| e.to_string())?;
    job.destination = Some(path.to_string_lossy().to_string());
    job.suggested_match = None;
    job.state = JobState::Complete;
    job.progress = 1.0;
    state.store.save_job(&job).map_err(|e| e.to_string())?;
    if let Some(dest) = job.destination.clone() {
        sync_crate_memberships(state, job.input_id, &dest);
    }
    Ok(())
}
