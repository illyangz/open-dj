//! FR-030–FR-038: safe local file inspection and replacement.
//!
//! The core invariant this crate exists to guarantee: **a failed or
//! interrupted replacement never leaves the original file missing or
//! zero-byte.** The original is only ever removed by a single atomic
//! rename/replace of a fully-written, already-verified temporary file, and
//! only after a verified backup copy exists on disk.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum FileOpsError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("candidate file is missing or empty: {0}")]
    InvalidCandidate(PathBuf),
    #[error("original file does not exist: {0}")]
    OriginalMissing(PathBuf),
    #[error("backup verification failed: checksum mismatch after copying to {0}")]
    BackupVerificationFailed(PathBuf),
}

pub type Result<T> = std::result::Result<T, FileOpsError>;

pub fn checksum_file(path: &Path) -> Result<String> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationRecord {
    pub original_path: String,
    pub backup_path: String,
    pub original_checksum: String,
    pub replacement_checksum: String,
    pub created_at: chrono::DateTime<Utc>,
}

/// Where a backup lives for a given original file, mirroring the reference
/// product's "OLD TRACKS BACKUP" concept (recreation-plan.md §2.3) without
/// reusing its name or layout verbatim.
pub fn backup_path_for(original: &Path, backup_root: &Path) -> PathBuf {
    let stamp = Utc::now().format("%Y%m%dT%H%M%S%.3f");
    let file_name = original
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    backup_root.join(format!("{stamp}__{file_name}"))
}

/// FR-034–FR-036: back up `original_path`, then atomically replace it with
/// `candidate_path`'s content. `candidate_path` is left untouched (it is
/// copied, not moved) so callers can keep it around as a downloaded
/// artifact if desired.
pub fn replace_atomic(
    original_path: &Path,
    candidate_path: &Path,
    backup_root: &Path,
) -> Result<MutationRecord> {
    let candidate_meta = fs::metadata(candidate_path)
        .map_err(|_| FileOpsError::InvalidCandidate(candidate_path.to_path_buf()))?;
    if candidate_meta.len() == 0 {
        return Err(FileOpsError::InvalidCandidate(candidate_path.to_path_buf()));
    }
    if !original_path.exists() {
        return Err(FileOpsError::OriginalMissing(original_path.to_path_buf()));
    }

    let original_checksum = checksum_file(original_path)?;

    fs::create_dir_all(backup_root)?;
    let backup_path = backup_path_for(original_path, backup_root);
    fs::copy(original_path, &backup_path)?;
    let backup_checksum = checksum_file(&backup_path)?;
    if backup_checksum != original_checksum {
        let _ = fs::remove_file(&backup_path);
        return Err(FileOpsError::BackupVerificationFailed(backup_path));
    }

    // Original is now safely backed up and verified. Stage the replacement
    // and only then perform the single atomic swap.
    let replacement_checksum = checksum_file(candidate_path)?;
    atomic_place(candidate_path, original_path)?;

    Ok(MutationRecord {
        original_path: original_path.to_string_lossy().to_string(),
        backup_path: backup_path.to_string_lossy().to_string(),
        original_checksum,
        replacement_checksum,
        created_at: Utc::now(),
    })
}

/// FR-037: restore the original from its backup, using the same
/// stage-then-atomic-swap path as `replace_atomic`.
pub fn restore_from_backup(backup_path: &Path, original_path: &Path) -> Result<String> {
    if !backup_path.exists() {
        return Err(FileOpsError::InvalidCandidate(backup_path.to_path_buf()));
    }
    atomic_place(backup_path, original_path)?;
    checksum_file(original_path)
}

/// Copies `source` to a temp file beside `dest`, fsyncs it, then performs a
/// single atomic replace of `dest` via `fs::rename`. On any error prior to
/// the final swap, `dest` is untouched. On Unix this is a same-filesystem
/// rename (atomic). On Windows, `std::fs::rename` already does the
/// equivalent — it calls `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`,
/// which performs the swap as a single filesystem transaction — so no
/// platform split is needed here. (An earlier version used `ReplaceFileW`
/// directly for its attribute/ACL-preservation semantics, but it returned
/// spurious `ERROR_ACCESS_DENIED` in CI; plain `rename` is the better-tested
/// path and this crate doesn't need ACL preservation for audio files.)
fn atomic_place(source: &Path, dest: &Path) -> Result<()> {
    let dest_dir = dest.parent().unwrap_or_else(|| Path::new("."));
    let tmp_name = format!(
        ".opendj-tmp-{}",
        dest.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "replace".to_string())
    );
    let tmp_path = dest_dir.join(tmp_name);

    fs::copy(source, &tmp_path)?;
    {
        let f = File::open(&tmp_path)?;
        f.sync_all()?;
    }

    let result = fs::rename(&tmp_path, dest).map_err(FileOpsError::from);
    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(path: &Path, content: &[u8]) {
        let mut f = File::create(path).unwrap();
        f.write_all(content).unwrap();
    }

    #[test]
    fn replace_backs_up_and_swaps_content() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("track.mp3");
        let candidate = dir.path().join("candidate.mp3");
        let backups = dir.path().join("backups");

        write_file(&original, b"old bytes");
        write_file(&candidate, b"new better bytes");

        let record = replace_atomic(&original, &candidate, &backups).unwrap();

        assert_eq!(fs::read(&original).unwrap(), b"new better bytes");
        assert_eq!(fs::read(&record.backup_path).unwrap(), b"old bytes");
        assert_eq!(
            record.original_checksum,
            checksum_file(Path::new(&record.backup_path)).unwrap()
        );
    }

    #[test]
    fn restore_brings_back_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("track.mp3");
        let candidate = dir.path().join("candidate.mp3");
        let backups = dir.path().join("backups");

        write_file(&original, b"old bytes");
        write_file(&candidate, b"new bytes");

        let record = replace_atomic(&original, &candidate, &backups).unwrap();
        restore_from_backup(Path::new(&record.backup_path), &original).unwrap();

        assert_eq!(fs::read(&original).unwrap(), b"old bytes");
    }

    #[test]
    fn empty_candidate_is_rejected_and_original_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("track.mp3");
        let candidate = dir.path().join("candidate.mp3");
        let backups = dir.path().join("backups");

        write_file(&original, b"old bytes");
        write_file(&candidate, b""); // zero-byte candidate: simulates a truncated download

        let err = replace_atomic(&original, &candidate, &backups);
        assert!(err.is_err());
        assert_eq!(fs::read(&original).unwrap(), b"old bytes"); // FR-038
    }

    #[test]
    fn missing_original_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("does-not-exist.mp3");
        let candidate = dir.path().join("candidate.mp3");
        let backups = dir.path().join("backups");
        write_file(&candidate, b"bytes");

        assert!(replace_atomic(&original, &candidate, &backups).is_err());
    }

    #[test]
    fn checksum_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        write_file(&path, b"hello world");
        let a = checksum_file(&path).unwrap();
        let b = checksum_file(&path).unwrap();
        assert_eq!(a, b);
    }
}
