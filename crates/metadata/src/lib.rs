use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag, TagType};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum MetadataError {
    #[error("audio probe failed: {0}")]
    Probe(#[from] lofty::error::LoftyError),
    #[error("file has no readable audio track")]
    NoAudioTrack,
    #[error("audio analysis failed: {0}")]
    Analysis(String),
}

pub type Result<T> = std::result::Result<T, MetadataError>;

mod analyze;
mod keyfinder_bridge;
mod waveform_bands;
pub use analyze::{analyze_track, TrackAnalysis};
pub use waveform_bands::{analyze_band_waveform, BandWaveform};

/// FR-031: fields shown in the Repair inspector for a scanned local file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TagFields {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    /// Beats per minute, read from the file's own BPM tag (TBPM/tmpo/BPM
    /// comment) when the source already embedded it. Not computed from the
    /// audio — files without a BPM tag (e.g. most fresh yt-dlp downloads)
    /// report `None` here.
    pub bpm: Option<f64>,
    /// Musical key (e.g. "8A", "Fm"), read from the file's own initial-key
    /// tag (TKEY/initialkey) when present. Same caveat as `bpm`: this is
    /// whatever the source embedded, not detected from the audio.
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioProbe {
    pub codec: String,
    pub duration_ms: u64,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u8>,
    pub tags: TagFields,
    pub artwork_present: bool,
}

/// FR-031: read container properties and tags without mutating the file.
pub fn probe(path: &Path) -> Result<AudioProbe> {
    let tagged = Probe::open(path)?.read()?;
    let properties = tagged.properties();
    let codec = format!("{:?}", tagged.file_type());

    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let tags = tag.map(tag_fields_from).unwrap_or_default();
    let artwork_present = tag.map(|t| !t.pictures().is_empty()).unwrap_or(false);

    Ok(AudioProbe {
        codec,
        duration_ms: properties.duration().as_millis() as u64,
        bitrate_kbps: properties.audio_bitrate(),
        sample_rate_hz: properties.sample_rate(),
        channels: properties.channels(),
        tags,
        artwork_present,
    })
}

fn tag_fields_from(tag: &Tag) -> TagFields {
    let bpm = tag
        .get_string(&ItemKey::Bpm)
        .or_else(|| tag.get_string(&ItemKey::IntegerBpm))
        .and_then(|s| s.trim().parse::<f64>().ok());
    let key = tag
        .get_string(&ItemKey::InitialKey)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    TagFields {
        title: tag.title().map(|s| s.to_string()),
        artist: tag.artist().map(|s| s.to_string()),
        album: tag.album().map(|s| s.to_string()),
        genre: tag.genre().map(|s| s.to_string()),
        year: tag.year(),
        track_number: tag.track(),
        bpm,
        key,
    }
}

/// FR-035: apply (or preserve) tag fields on a candidate file before it is
/// atomically swapped into place by `opendj-file-ops`. Operates on whatever
/// tag format is native to the container (ID3v2 for MP3, Vorbis comments for
/// FLAC/OGG, etc.) via lofty's primary-tag resolution.
pub fn write_tags(path: &Path, fields: &TagFields) -> Result<()> {
    let mut tagged = Probe::open(path)?.read()?;
    let tag_type = tagged.primary_tag_type();

    if tagged.tag(tag_type).is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged
        .tag_mut(tag_type)
        .ok_or(MetadataError::NoAudioTrack)?;
    apply_fields(tag, fields);
    tagged.save_to_path(path, WriteOptions::default())?;
    Ok(())
}

fn apply_fields(tag: &mut Tag, fields: &TagFields) {
    if let Some(title) = &fields.title {
        tag.set_title(title.clone());
    }
    if let Some(artist) = &fields.artist {
        tag.set_artist(artist.clone());
    }
    if let Some(album) = &fields.album {
        tag.set_album(album.clone());
    }
    if let Some(genre) = &fields.genre {
        tag.set_genre(genre.clone());
    }
    if let Some(year) = fields.year {
        tag.set_year(year);
    }
    if let Some(track) = fields.track_number {
        tag.set_track(track);
    }
    if let Some(bpm) = fields.bpm {
        tag.insert_text(ItemKey::Bpm, bpm.to_string());
    }
    if let Some(key) = &fields.key {
        tag.insert_text(ItemKey::InitialKey, key.clone());
    }
}

/// Convenience used by `TagType`-generic callers; kept so this crate is the
/// single place that knows how to map a container to its native tag format.
pub fn default_tag_type_for(path: &Path) -> Result<TagType> {
    let tagged = Probe::open(path)?.read()?;
    Ok(tagged.primary_tag_type())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_missing_file_errors() {
        let result = probe(Path::new("/nonexistent/does-not-exist.mp3"));
        assert!(result.is_err());
    }
}
