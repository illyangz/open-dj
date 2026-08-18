use crate::state::AppState;
use opendj_core::{InputKind, JobState};
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

    let candidates = provider
        .resolve_metadata(&input.raw_value)
        .await
        .map_err(|e| e.to_string())?;
    let candidate = candidates
        .into_iter()
        .next()
        .ok_or("No match found for this input")?;

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
    let path = provider
        .fetch(&candidate, &dest_dir)
        .await
        .map_err(|e| e.to_string())?;

    let mut job = state.store.get_job(job_id).map_err(|e| e.to_string())?;
    job.destination = Some(path.to_string_lossy().to_string());
    job.state = JobState::Complete;
    job.progress = 1.0;
    state.store.save_job(&job).map_err(|e| e.to_string())?;
    Ok(())
}
