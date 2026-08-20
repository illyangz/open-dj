//! Per-column low/mid/high spectral energy for the RGB/3-Band waveform
//! views — a real 2048-bin STFT rather than ffmpeg's independently
//! max-normalized `showwavespic` bands, so relative loudness between bands
//! and across time survives into the render (that's what makes a drop read
//! red/loud and a breakdown read thin, the way Serato/Rekordbox waveforms
//! do). All normalization/color mapping happens client-side against these
//! raw sums — see `GradientWaveform` in the frontend.

use crate::analyze::decode;
use crate::Result;
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use std::path::Path;

const FFT_SIZE: usize = 2048;
const LOW_HZ: f32 = 250.0;
const HIGH_HZ: f32 = 4000.0;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BandWaveform {
    pub low: Vec<f32>,
    pub mid: Vec<f32>,
    pub high: Vec<f32>,
    /// Per-column peak spectral magnitude — the overall amplitude envelope
    /// that drives waveform height (independent of the low/mid/high split,
    /// which drives color).
    pub peak: Vec<f32>,
}

/// Analyze `path` into `target_columns` waveform columns. The hop between
/// FFT frames is derived from the track's total sample count rather than
/// fixed, so a 10-minute track produces the same column count (and payload
/// size) as a 3-minute one — coarser time resolution, not more data.
pub fn analyze_band_waveform(path: &Path, target_columns: usize) -> Result<BandWaveform> {
    let decoded = decode(path)?;
    let samples = &decoded.mono_samples;
    let sample_rate = decoded.sample_rate.max(1);

    let target_columns = target_columns.max(1);
    let hop = (samples.len() / target_columns).max(1);

    let hz_per_bin = sample_rate as f32 / FFT_SIZE as f32;
    let low_end = ((LOW_HZ / hz_per_bin).floor() as usize).min(FFT_SIZE / 2);
    let mid_end = ((HIGH_HZ / hz_per_bin).floor() as usize).min(FFT_SIZE / 2);

    let mut hann = vec![0f32; FFT_SIZE];
    for (i, w) in hann.iter_mut().enumerate() {
        *w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos());
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    let mut low = Vec::new();
    let mut mid = Vec::new();
    let mut high = Vec::new();
    let mut peak = Vec::new();
    let mut buf = vec![Complex32::new(0.0, 0.0); FFT_SIZE];

    let mut start = 0;
    while start < samples.len() {
        for i in 0..FFT_SIZE {
            let sample = samples.get(start + i).copied().unwrap_or(0.0);
            buf[i] = Complex32::new(sample * hann[i], 0.0);
        }
        fft.process(&mut buf);

        let mut l = 0f32;
        let mut m = 0f32;
        let mut h = 0f32;
        let mut pk = 0f32;
        for (bin, c) in buf.iter().enumerate().take(FFT_SIZE / 2 + 1) {
            let mag = c.norm();
            if mag > pk {
                pk = mag;
            }
            if bin < low_end {
                l += mag;
            } else if bin < mid_end {
                m += mag;
            } else {
                h += mag;
            }
        }
        low.push(l);
        mid.push(m);
        high.push(h);
        peak.push(pk);

        start += hop;
    }

    Ok(BandWaveform { low, mid, high, peak })
}
