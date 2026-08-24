//! Real BPM/key detection from decoded audio, as opposed to `probe`'s tag
//! reading — this is for files that don't already carry a BPM/key tag
//! (which is most fresh downloads).

use crate::{keyfinder_bridge, MetadataError, Result};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Detected BPM/key for a track, with the detector's own confidence in each
/// (0.0-1.0) — low confidence means the source material is a poor fit for
/// this kind of analysis (ambient, spoken word, heavy tempo drift, etc.),
/// not necessarily a bug. `key_confidence` is pinned to 1.0 when `key` came
/// from libkeyfinder rather than stratum-dsp — see `analyze_track`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrackAnalysis {
    pub bpm: f32,
    pub bpm_confidence: f32,
    /// Camelot notation (e.g. "8A") — the format DJ software standardizes on.
    pub key: String,
    pub key_confidence: f32,
}

/// Decode `path` and run BPM/key detection on it. BPM always comes from
/// stratum-dsp (already validated well against real tracks). Key prefers
/// libkeyfinder — Mixxx's own key-detection engine, and meaningfully more
/// accurate in practice — falling back to stratum-dsp's key detector only
/// when libkeyfinder (or its bridge library) isn't available on this
/// machine; see `crates/keyfinder-bridge` for why that's a soft fallback
/// rather than a hard requirement.
pub fn analyze_track(path: &Path) -> Result<TrackAnalysis> {
    // Only decode the first 30 seconds — BPM and key detection don't need
    // the full file. This cuts decode time from seconds to milliseconds.
    const SAMPLES_FOR_ANALYSIS: usize = 30 * 44100; // 30s at 44.1kHz
    let decoded = decode_limited(path, Some(SAMPLES_FOR_ANALYSIS))?;

    let result = stratum_dsp::analyze_audio(
        &decoded.mono_samples,
        decoded.sample_rate,
        stratum_dsp::AnalysisConfig::default(),
    )
    .map_err(|e| MetadataError::Analysis(e.to_string()))?;

    let (key, key_confidence) = match keyfinder_bridge::detect_key_camelot(
        &decoded.interleaved_samples,
        decoded.channels,
        decoded.sample_rate,
    ) {
        Some(key) => (key, 1.0),
        None => (result.key.numerical(), result.key_confidence),
    };

    Ok(TrackAnalysis {
        bpm: result.bpm,
        bpm_confidence: result.bpm_confidence,
        key,
        key_confidence,
    })
}

pub(crate) struct DecodedAudio {
    /// Downmixed to mono — what stratum-dsp (and the waveform-band FFT)
    /// expects.
    pub(crate) mono_samples: Vec<f32>,
    /// Original channel layout, interleaved — what libkeyfinder expects
    /// (it does its own, more careful channel reduction internally).
    pub(crate) interleaved_samples: Vec<f32>,
    pub(crate) channels: u32,
    pub(crate) sample_rate: u32,
}

/// Cache for decoded audio — avoids decoding the same file twice when
/// both BPM/key analysis and waveform rendering run concurrently.
/// Keyed by canonicalized file path. Limited to 3 entries to cap memory
/// (~600MB worst case for stereo 44.1kHz tracks).
#[allow(dead_code)]
fn decoded_cache() -> &'static Mutex<HashMap<String, DecodedAudio>> {
    static CACHE: OnceLock<Mutex<HashMap<String, DecodedAudio>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Try to get a cached decoded audio for this path, or decode and cache it.
/// If the cache is full, evicts the oldest entry.
#[allow(dead_code)]
pub(crate) fn decode_cached(path: &Path) -> Result<DecodedAudio> {
    let key = path.to_string_lossy().to_string();

    // Fast path: check cache
    {
        let cache = decoded_cache().lock().map_err(|e| MetadataError::Analysis(e.to_string()))?;
        if let Some(cached) = cache.get(&key) {
            return Ok(DecodedAudio {
                mono_samples: cached.mono_samples.clone(),
                interleaved_samples: cached.interleaved_samples.clone(),
                channels: cached.channels,
                sample_rate: cached.sample_rate,
            });
        }
    }

    // Slow path: decode from disk
    let decoded = decode(path)?;

    // Cache the result (evict oldest if full)
    {
        let mut cache = decoded_cache().lock().map_err(|e| MetadataError::Analysis(e.to_string()))?;
        if cache.len() >= 3 {
            // Remove the first (oldest) entry
            if let Some(first_key) = cache.keys().next().cloned() {
                cache.remove(&first_key);
            }
        }
        cache.insert(key, DecodedAudio {
            mono_samples: decoded.mono_samples.clone(),
            interleaved_samples: decoded.interleaved_samples.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
        });
    }

    Ok(decoded)
}

pub(crate) fn decode(path: &Path) -> Result<DecodedAudio> {
    decode_limited(path, None)
}

/// Decode `path` with an optional sample limit. When `max_samples` is
/// `Some(n)`, stops reading after `n` mono samples (~n/sample_rate seconds).
/// This cuts analysis time dramatically for BPM/key detection which only
/// needs the first 30-60 seconds of audio.
pub(crate) fn decode_limited(path: &Path, max_samples: Option<usize>) -> Result<DecodedAudio> {
    let src = std::fs::File::open(path).map_err(|e| MetadataError::Analysis(e.to_string()))?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| MetadataError::Analysis(format!("unsupported format: {e}")))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or(MetadataError::NoAudioTrack)?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| MetadataError::Analysis(format!("unsupported codec: {e}")))?;

    // Pre-allocate for ~60 seconds at 44.1kHz (2,646,000 samples) when no limit.
    // With a limit, pre-allocate exactly.
    let initial_cap = max_samples.unwrap_or(2_646_000);
    let mut mono_samples: Vec<f32> = Vec::with_capacity(initial_cap);
    let mut interleaved_samples: Vec<f32> = Vec::with_capacity(initial_cap * 2);
    let mut channels: u32 = 1;
    let mut sample_rate: u32 = 44100;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        // Early exit: we have enough samples
        if let Some(limit) = max_samples {
            if mono_samples.len() >= limit {
                break;
            }
        }

        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => break,
            Err(SymphoniaError::IoError(_)) => break,
            Err(e) => return Err(MetadataError::Analysis(e.to_string())),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(MetadataError::Analysis(e.to_string())),
        };

        let spec = *decoded.spec();
        sample_rate = spec.rate;
        let frame_channels = spec.channels.count().max(1);
        channels = frame_channels as u32;

        let buf = sample_buf
            .get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        buf.copy_interleaved_ref(decoded);

        let interleaved = buf.samples();
        interleaved_samples.extend_from_slice(interleaved);
        // Downmix to mono by averaging channels — stratum-dsp expects mono.
        for frame in interleaved.chunks(frame_channels) {
            let sum: f32 = frame.iter().sum();
            mono_samples.push(sum / frame_channels as f32);
        }
    }

    if mono_samples.is_empty() {
        return Err(MetadataError::NoAudioTrack);
    }

    Ok(DecodedAudio {
        mono_samples,
        interleaved_samples,
        channels,
        sample_rate,
    })
}
