//! Tauri commands for real (ML-based) stem separation — distinct from the
//! low/mid/high EQ-band waveform in `commands.rs`, which is a visual aid
//! only and cannot produce isolated stems (a lowpass/bandpass/highpass
//! split still has every instrument bleeding across bands). This uses
//! `opendj_stems` (ONNX Runtime + htdemucs) for real source separation.

use crate::state::AppState;
use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;

pub const STEM_MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "stem-model-download-progress";
pub const STEM_SPLIT_PROGRESS_EVENT: &str = "stem-split-progress";

#[derive(Debug, Clone, Serialize)]
pub struct StemModelDownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StemSplitProgress {
    pub path: String,
    pub stage: String,
    pub percent: f32,
}

/// Tracks which track the (process-global) split-progress callback is
/// currently reporting on — the underlying callback carries no path of its
/// own, but `AppState::stem_semaphore` guarantees only one separation runs
/// at a time, so this is always unambiguous while a job is in flight.
fn current_path_cell() -> &'static Mutex<Option<String>> {
    static CURRENT_PATH: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CURRENT_PATH.get_or_init(|| Mutex::new(None))
}

/// Registers `opendj_stems`' progress callbacks exactly once, translating
/// each into a Tauri event. Must be called once from `lib.rs`'s `setup()`
/// — the callbacks are backed by `OnceLock`s upstream, so a second
/// registration attempt would silently no-op.
pub fn register_progress_bridge(app: AppHandle) {
    let download_app = app.clone();
    opendj_stems::set_download_progress_callback(move |downloaded, total| {
        let _ = download_app.emit(
            STEM_MODEL_DOWNLOAD_PROGRESS_EVENT,
            StemModelDownloadProgress { downloaded, total },
        );
    });

    opendj_stems::set_split_progress_callback(move |progress| {
        let (stage, percent) = match progress {
            opendj_stems::SplitProgress::Stage(s) => (s.to_string(), 0.0),
            opendj_stems::SplitProgress::Chunks { percent, .. } => ("chunks".to_string(), percent),
            opendj_stems::SplitProgress::Writing { stem, percent, .. } => {
                (format!("writing_{stem}"), percent)
            }
            opendj_stems::SplitProgress::Finished => ("finished".to_string(), 100.0),
        };
        let path = current_path_cell()
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default();
        let _ = app.emit(
            STEM_SPLIT_PROGRESS_EVENT,
            StemSplitProgress {
                path,
                stage,
                percent,
            },
        );
    });
}

#[derive(Debug, Serialize)]
pub struct StemDownloadResult {
    pub vocals: Option<String>,
    pub drums: Option<String>,
    pub bass: Option<String>,
    pub other: Option<String>,
}

/// Runs full stem separation (Demucs always computes all four together in
/// one pass — there's no partial-output mode) and returns only the stems
/// the caller asked to keep, deleting the rest so the output folder
/// matches exactly what the user selected in the picker UI.
#[tauri::command]
pub async fn separate_track_stems(
    state: State<'_, AppState>,
    path: String,
    stems: Vec<String>,
) -> CmdResult<StemDownloadResult> {
    let _permit = state
        .stem_semaphore
        .acquire()
        .await
        .map_err(|e| e.to_string())?;

    let file_stem = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();
    let output_dir = Path::new(&path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{file_stem} (Stems)"));
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let output_dir_str = output_dir.to_string_lossy().to_string();

    *current_path_cell().lock().unwrap() = Some(path.clone());
    let separate_path = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        opendj_stems::separate(&separate_path, &output_dir_str)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());
    *current_path_cell().lock().unwrap() = None;
    let paths = result?;

    let keep = |name: &str, file: String| -> Option<String> {
        if stems.iter().any(|s| s == name) {
            Some(file)
        } else {
            let _ = std::fs::remove_file(&file);
            None
        }
    };

    Ok(StemDownloadResult {
        vocals: keep("vocals", paths.vocals),
        drums: keep("drums", paths.drums),
        bass: keep("bass", paths.bass),
        other: keep("other", paths.other),
    })
}
