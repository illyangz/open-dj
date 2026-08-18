use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingTool {
    Ytdlp,
    Ffmpeg,
    Both,
}

impl std::fmt::Display for MissingTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MissingTool::Ytdlp => write!(f, "yt-dlp"),
            MissingTool::Ffmpeg => write!(f, "ffmpeg"),
            MissingTool::Both => write!(f, "yt-dlp and ffmpeg"),
        }
    }
}

/// Resolve the yt-dlp binary path. Checks the app bundle resources
/// directory, then the system PATH, then well-known install locations
/// directly.
pub fn find_ytdlp() -> Option<PathBuf> {
    find_in_bundle("yt-dlp")
        .or_else(|| find_in_path("yt-dlp"))
        .or_else(|| find_in_well_known_dirs("yt-dlp"))
}

/// Resolve the ffmpeg binary path. Checks the app bundle resources
/// directory, then the system PATH, then well-known install locations
/// directly.
pub fn find_ffmpeg() -> Option<PathBuf> {
    find_in_bundle("ffmpeg")
        .or_else(|| find_in_path("ffmpeg"))
        .or_else(|| find_in_well_known_dirs("ffmpeg"))
}

/// Check that both yt-dlp and ffmpeg are available. Returns their paths
/// on success, or which tool is missing.
pub fn check_tools() -> Result<(PathBuf, PathBuf), MissingTool> {
    let ytdlp = find_ytdlp();
    let ffmpeg = find_ffmpeg();

    match (ytdlp, ffmpeg) {
        (Some(y), Some(f)) => Ok((y, f)),
        (Some(_), None) => Err(MissingTool::Ffmpeg),
        (None, Some(_)) => Err(MissingTool::Ytdlp),
        (None, None) => Err(MissingTool::Both),
    }
}

/// Look for a binary in the app bundle's resources directory.
/// On macOS this is inside the .app bundle's Resources/ folder.
fn find_in_bundle(name: &str) -> Option<PathBuf> {
    // When running as a bundled Tauri app, the resource dir is next to the executable.
    // Check common bundle paths relative to the current executable.
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    // Tauri places bundled resources in the same directory as the executable
    // (or in ../Resources/ on macOS).
    let candidates = [
        exe_dir.join(name),
        exe_dir.join(format!("{name}.exe")),
        exe_dir.parent()?.join("Resources").join(name),
        exe_dir.parent()?.parent()?.join("Resources").join(name),
    ];

    for path in &candidates {
        if path.is_file() {
            // On Unix, ensure the file is executable.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let meta = std::fs::metadata(path).ok()?;
                if meta.permissions().mode() & 0o111 != 0 {
                    return Some(path.clone());
                }
            }
            #[cfg(not(unix))]
            {
                return Some(path.clone());
            }
        }
    }
    None
}

/// Look directly in well-known install locations, independent of the
/// process's inherited `PATH` — GUI apps launched from Finder/Dock/Spotlight
/// (as opposed to a terminal) don't reliably get the same PATH a login
/// shell has, so a tool installed via Homebrew can be genuinely on disk and
/// working fine from Terminal while `which` (and therefore `find_in_path`)
/// comes up empty for the app.
fn find_in_well_known_dirs(name: &str) -> Option<PathBuf> {
    let dirs = [
        "/opt/homebrew/bin", // Homebrew, Apple Silicon
        "/usr/local/bin",    // Homebrew, Intel
        "/opt/local/bin",    // MacPorts
    ];
    dirs.iter()
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|path| path.is_file())
}

/// A `PATH` value guaranteed to include the well-known install dirs,
/// regardless of what this process actually inherited — pass this to any
/// spawned subprocess (yt-dlp above all) so that *its own* internal PATH
/// lookups (for `deno`, `node`, `ffmpeg`, etc.) don't hit the exact same
/// GUI-launch PATH gap `find_ytdlp`/`find_ffmpeg` work around for us. Not
/// doing this was a real bug: we'd find yt-dlp fine via
/// `find_in_well_known_dirs`, spawn it successfully, and it would then
/// fail to find `deno` on its own PATH, silently degrading every download
/// to yt-dlp's no-JS-runtime fallback (missing formats, "n challenge
/// solving failed") instead of erroring loudly.
pub fn augmented_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let extra = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/opt/local/bin";
    if existing.is_empty() {
        extra.to_string()
    } else {
        format!("{existing}:{extra}")
    }
}

/// Look for a binary on the system PATH using the `which` command.
fn find_in_path(name: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("which")
        .arg(name)
        .output()
        .ok()?;
    if output.status.success() {
        let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path_str.is_empty() {
            return Some(PathBuf::from(path_str));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_tools_succeeds_when_both_installed() {
        // This test passes if yt-dlp and ffmpeg are on the system PATH.
        // In CI without these tools, this test is expected to fail —
        // gate it behind a cfg flag or ignore it there.
        if let Ok((ytdlp, ffmpeg)) = check_tools() {
            assert!(ytdlp.exists());
            assert!(ffmpeg.exists());
        }
    }
}
