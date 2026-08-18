//! Runtime (not compile-time) loader for the isolated `opendj-keyfinder-bridge`
//! cdylib — see that crate's doc comment for why this has to be dlopen'd
//! at runtime instead of a normal Cargo dependency. If the bridge library
//! or the `libkeyfinder` it links can't be found, every function here
//! returns `None` and the caller falls back to stratum-dsp's own key
//! detection — this is a soft, best-effort upgrade, never a requirement.

use libloading::{Library, Symbol};
use std::path::PathBuf;

type DetectKeyFn = unsafe extern "C" fn(*const f32, usize, u32, u32) -> i32;

#[cfg(target_os = "macos")]
const BRIDGE_FILENAME: &str = "libopendj_keyfinder_bridge.dylib";
#[cfg(target_os = "linux")]
const BRIDGE_FILENAME: &str = "libopendj_keyfinder_bridge.so";
#[cfg(target_os = "windows")]
const BRIDGE_FILENAME: &str = "opendj_keyfinder_bridge.dll";

/// Same search shape as `opendj_providers::yt_dlp_bin::find_in_bundle`:
/// next to the executable, or in the macOS bundle's `Resources/` dir a
/// couple levels up. Also checks the raw `target/{debug,release}` dir so
/// this works when running un-bundled during development.
fn find_bridge_dylib() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    let mut candidates = vec![
        exe_dir.join(BRIDGE_FILENAME),
        exe_dir.parent()?.join("Resources").join(BRIDGE_FILENAME),
        exe_dir
            .parent()?
            .parent()?
            .join("Resources")
            .join(BRIDGE_FILENAME),
    ];
    // Dev builds: `cargo run`/`cargo build` put the desktop binary and this
    // dylib in the same target/{debug,release} dir already covered above,
    // but `tauri dev` nests the binary one level deeper — check the parent
    // target dir too.
    if let Some(target_dir) = exe_dir.parent() {
        candidates.push(target_dir.join(BRIDGE_FILENAME));
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// Detect key via libkeyfinder (Mixxx's key-detection engine) if it's
/// available on this machine. `samples` is interleaved PCM at the given
/// channel count/sample rate — pass the original decode, not a downmix;
/// libkeyfinder does its own channel reduction internally.
fn detect_key_code(samples: &[f32], channels: u32, sample_rate: u32) -> Option<i32> {
    let path = find_bridge_dylib()?;
    // Safety: we only load a dylib we built ourselves and bundle with the
    // app; `opendj_detect_key` is defined in crates/keyfinder-bridge with
    // a matching signature and never unwinds across the FFI boundary.
    let lib = unsafe { Library::new(&path) }.ok()?;
    let func: Symbol<DetectKeyFn> = unsafe { lib.get(b"opendj_detect_key\0") }.ok()?;
    let code = unsafe { func(samples.as_ptr(), samples.len(), channels, sample_rate) };
    Some(code)
}

/// Returns Camelot notation (e.g. "8A") for the detected key, or `None` if
/// the bridge/libkeyfinder isn't available or the track is silent.
///
/// Mapping verified against libkeyfinder's `key_t` enum (0-23 = the 24
/// major/minor keys in a fixed order, 24 = silence) cross-checked directly
/// against real tracks against stratum-dsp's own Camelot math.
pub fn detect_key_camelot(samples: &[f32], channels: u32, sample_rate: u32) -> Option<String> {
    let code = detect_key_code(samples, channels, sample_rate)?;
    let camelot = match code {
        0 => "4B",        // A major
        1 => "1A",        // A minor
        2 => "11B",       // Bb major
        3 => "8A",        // Bb minor
        4 => "6B",        // B major
        5 => "3A",        // B minor
        6 => "1B",        // C major
        7 => "10A",       // C minor
        8 => "8B",        // Db major
        9 => "5A",        // Db minor
        10 => "3B",       // D major
        11 => "12A",      // D minor
        12 => "10B",      // Eb major
        13 => "7A",       // Eb minor
        14 => "5B",       // E major
        15 => "2A",       // E minor
        16 => "12B",      // F major
        17 => "9A",       // F minor
        18 => "7B",       // Gb major
        19 => "4A",       // Gb minor
        20 => "2B",       // G major
        21 => "11A",      // G minor
        22 => "9B",       // Ab major
        23 => "6A",       // Ab minor
        _ => return None, // 24 = silence, or a bridge-reported error (-1)
    };
    Some(camelot.to_string())
}
