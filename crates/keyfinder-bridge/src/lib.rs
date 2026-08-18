//! Isolated bridge to `libkeyfinder` (the key-detection engine Mixxx uses),
//! built as its own `cdylib` and deliberately excluded from the main app's
//! dependency graph.
//!
//! `libkeyfinder-sys` dynamically links against `libkeyfinder.dylib` at
//! *compile* time. If the main `desktop` binary linked it directly, macOS
//! would resolve that dependency at *process launch* — before any of our
//! own code runs — so a machine without `libkeyfinder` installed would
//! fail to even open the app, not just lose key-detection.
//!
//! Putting the link in this separate cdylib instead means the main binary
//! has no Mach-O dependency on `libkeyfinder` at all. `crates/metadata`
//! loads *this* library at runtime via `libloading::Library::new`, which —
//! unlike a hard link — simply returns an `Err` if `libkeyfinder.dylib`
//! can't be resolved, instead of crashing the process. Missing library
//! degrades gracefully to the existing stratum-dsp key detection; it never
//! takes the app down.

use libkeyfinder_sys::{AudioData, KeyFinder};

/// Detect the musical key of the given mono/stereo PCM samples.
///
/// Returns libkeyfinder's raw key code (0-23 for the 24 major/minor keys,
/// 24 for silence) on success, or -1 on any failure (including a panic
/// inside libkeyfinder itself — an FFI boundary must never unwind, so any
/// panic is caught here and turned into an error code instead).
///
/// # Safety
/// `samples` must point to a valid, readable array of at least `len`
/// `f32` values for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn opendj_detect_key(
    samples: *const f32,
    len: usize,
    channels: u32,
    frame_rate: u32,
) -> i32 {
    if samples.is_null() || len == 0 || channels == 0 || frame_rate == 0 {
        return -1;
    }

    let result = std::panic::catch_unwind(|| {
        let slice = std::slice::from_raw_parts(samples, len);
        let mut audio = AudioData::new();
        audio.set_frame_rate(frame_rate);
        audio.set_channels(channels);
        audio.extend(slice.iter().copied());

        let mut kf = KeyFinder::new();
        kf.key_of_audio(&audio) as i32
    });

    result.unwrap_or(-1)
}
