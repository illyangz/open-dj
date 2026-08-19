//! Thin wrapper around `stem-splitter-core` (ONNX-Runtime-based htdemucs
//! inference) — unopinionated: `separate()` always runs the full
//! separation and returns all four stems, since Demucs computes them
//! together in one pass regardless of which ones a caller actually wants.
//! Selecting a subset (and cleaning up the rest) is the caller's job — see
//! `apps/desktop/src-tauri/src/stem_commands.rs`.
//!
//! The underlying crate's progress callbacks (`set_download_progress_callback`/
//! `set_split_progress_callback`) are process-global `OnceLock`s — they can
//! only be set once, ever, so registering them is the caller's
//! responsibility too, done exactly once at app startup, not per call.

pub use stem_splitter_core::{
    set_download_progress_callback, set_split_progress_callback, SplitProgress,
};

#[derive(Debug, Clone)]
pub struct StemPaths {
    pub vocals: String,
    pub drums: String,
    pub bass: String,
    pub other: String,
}

#[derive(Debug, thiserror::Error)]
pub enum StemError {
    #[error("stem separation failed: {0}")]
    Upstream(String),
}

/// Blocking — run inside `tokio::task::spawn_blocking`, matching how
/// `opendj_metadata::analyze_track` is already invoked from Tauri commands.
pub fn separate(input_path: &str, output_dir: &str) -> Result<StemPaths, StemError> {
    let opts = stem_splitter_core::SplitOptions {
        output_dir: output_dir.to_string(),
        ..Default::default()
    };
    let result = stem_splitter_core::split_file(input_path, opts)
        .map_err(|e| StemError::Upstream(e.to_string()))?;
    Ok(StemPaths {
        vocals: result.vocals_path,
        drums: result.drums_path,
        bass: result.bass_path,
        other: result.other_path,
    })
}
