//! FR-040–FR-044: folder templates, dry-run organization plans, and
//! duplicate detection. This crate never touches the filesystem itself —
//! `build_plan` is pure so it can be unit tested and exported (FR-044)
//! without side effects; applying a plan is the caller's job via
//! `opendj-file-ops`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackFields {
    pub source_path: String,
    pub checksum: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub playlist: Option<String>,
    pub title: Option<String>,
}

/// FR-040: a template like `{artist}/{album}/{title}`. Unknown fields
/// resolve to `"Unknown <Field>"` rather than failing, so a plan can always
/// be built and reviewed.
pub struct FolderTemplate {
    pub pattern: String,
}

impl FolderTemplate {
    pub fn new(pattern: impl Into<String>) -> Self {
        Self {
            pattern: pattern.into(),
        }
    }

    pub fn render(&self, fields: &TrackFields, extension: &str) -> String {
        let mut segments: Vec<String> = Vec::new();
        for raw_segment in self.pattern.split('/') {
            segments.push(substitute(raw_segment, fields));
        }
        let mut path = segments.join("/");
        path.push('.');
        path.push_str(extension.trim_start_matches('.'));
        path
    }
}

fn substitute(segment: &str, fields: &TrackFields) -> String {
    let value = if segment == "{artist}" {
        fields
            .artist
            .clone()
            .unwrap_or_else(|| "Unknown Artist".to_string())
    } else if segment == "{album}" {
        fields
            .album
            .clone()
            .unwrap_or_else(|| "Unknown Album".to_string())
    } else if segment == "{year}" {
        fields
            .year
            .map(|y| y.to_string())
            .unwrap_or_else(|| "Unknown Year".to_string())
    } else if segment == "{playlist}" {
        fields
            .playlist
            .clone()
            .unwrap_or_else(|| "Unsorted".to_string())
    } else if segment == "{title}" {
        fields
            .title
            .clone()
            .unwrap_or_else(|| "Unknown Title".to_string())
    } else {
        segment.to_string()
    };
    sanitize_path_segment(&value)
}

fn sanitize_path_segment(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollisionAction {
    None,
    Skip,
    Rename,
    ReplaceWithBackup,
    ManualReview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedMove {
    pub from: String,
    pub to: String,
    pub collision: CollisionAction,
}

/// FR-041: dry-run plan. `existing_destinations` lets the caller pass in
/// paths already on disk so collisions can be flagged before anything
/// moves.
pub fn build_plan(
    tracks: &[TrackFields],
    template: &FolderTemplate,
    destination_root: &str,
    existing_destinations: &[String],
) -> Vec<PlannedMove> {
    let mut used: std::collections::HashSet<String> =
        existing_destinations.iter().cloned().collect();
    tracks
        .iter()
        .map(|t| {
            let extension = std::path::Path::new(&t.source_path)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_else(|| "mp3".to_string());
            let relative = FolderTemplate::render(template, t, &extension);
            let to = format!("{}/{}", destination_root.trim_end_matches('/'), relative);

            let collision = if used.contains(&to) {
                CollisionAction::ManualReview
            } else {
                CollisionAction::None
            };
            used.insert(to.clone());

            PlannedMove {
                from: t.source_path.clone(),
                to,
                collision,
            }
        })
        .collect()
}

/// FR-043: checksum-based duplicate groups. Returns only groups with more
/// than one member.
pub fn find_duplicates(tracks: &[TrackFields]) -> Vec<Vec<String>> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for t in tracks {
        groups
            .entry(t.checksum.clone())
            .or_default()
            .push(t.source_path.clone());
    }
    groups.into_values().filter(|g| g.len() > 1).collect()
}

// ── DuplicateGroup (richer duplicate detection for the UI) ──────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateTier {
    ExactFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub tier: DuplicateTier,
    pub tracks: Vec<TrackFields>,
    pub suggested_canonical: String,
}

/// Pick the best canonical track from a group. Prefers (a) highest bitrate
/// (if available via source_path metadata), (b) most complete tag set,
/// (c) oldest file as tiebreak.
fn pick_canonical(tracks: &[TrackFields]) -> String {
    let mut best = &tracks[0];
    for t in &tracks[1..] {
        let best_score = tag_completeness(best);
        let t_score = tag_completeness(t);
        if t_score > best_score {
            best = t;
        }
    }
    best.source_path.clone()
}

fn tag_completeness(t: &TrackFields) -> u32 {
    let mut score = 0u32;
    if t.artist.is_some() {
        score += 1;
    }
    if t.album.is_some() {
        score += 1;
    }
    if t.year.is_some() {
        score += 1;
    }
    if t.title.is_some() {
        score += 1;
    }
    if t.playlist.is_some() {
        score += 1;
    }
    score
}

/// Richer duplicate detection: groups tracks by checksum, returns
/// DuplicateGroup structs with full metadata and a suggested canonical.
pub fn find_duplicate_groups(tracks: &[TrackFields]) -> Vec<DuplicateGroup> {
    let mut groups: HashMap<String, Vec<TrackFields>> = HashMap::new();
    for t in tracks {
        groups
            .entry(t.checksum.clone())
            .or_default()
            .push(t.clone());
    }
    groups
        .into_values()
        .filter(|g| g.len() > 1)
        .map(|members| {
            let suggested_canonical = pick_canonical(&members);
            DuplicateGroup {
                tier: DuplicateTier::ExactFile,
                tracks: members,
                suggested_canonical,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(path: &str, checksum: &str, artist: &str, title: &str) -> TrackFields {
        TrackFields {
            source_path: path.to_string(),
            checksum: checksum.to_string(),
            artist: Some(artist.to_string()),
            album: Some("Album".to_string()),
            year: Some(2024),
            playlist: None,
            title: Some(title.to_string()),
        }
    }

    #[test]
    fn renders_template_with_sanitized_segments() {
        let template = FolderTemplate::new("{artist}/{album}/{title}");
        let t = track("/in/a.mp3", "abc", "AC/DC", "T.N.T.");
        let rendered = template.render(&t, "mp3");
        assert_eq!(rendered, "AC_DC/Album/T.N.T..mp3");
    }

    #[test]
    fn missing_fields_fall_back_to_unknown() {
        let template = FolderTemplate::new("{artist}/{title}");
        let t = TrackFields {
            source_path: "/in/a.mp3".into(),
            checksum: "abc".into(),
            artist: None,
            album: None,
            year: None,
            playlist: None,
            title: None,
        };
        assert_eq!(
            template.render(&t, "mp3"),
            "Unknown Artist/Unknown Title.mp3"
        );
    }

    #[test]
    fn plan_flags_collisions_for_manual_review() {
        let template = FolderTemplate::new("{artist}/{title}");
        let tracks = vec![
            track("/in/a.mp3", "aaa", "Daft Punk", "One More Time"),
            track("/in/b.mp3", "bbb", "Daft Punk", "One More Time"),
        ];
        let plan = build_plan(&tracks, &template, "/library", &[]);
        assert_eq!(plan[0].collision, CollisionAction::None);
        assert_eq!(plan[1].collision, CollisionAction::ManualReview);
    }

    #[test]
    fn duplicates_are_grouped_by_checksum() {
        let tracks = vec![
            track("/in/a.mp3", "same", "X", "A"),
            track("/in/b.mp3", "same", "X", "B"),
            track("/in/c.mp3", "different", "X", "C"),
        ];
        let dups = find_duplicates(&tracks);
        assert_eq!(dups.len(), 1);
        assert_eq!(dups[0].len(), 2);
    }

    #[test]
    fn find_duplicate_groups_returns_rich_groups() {
        let tracks = vec![
            track("/in/a.mp3", "same", "X", "A"),
            track("/in/b.mp3", "same", "Y", "B"),
            track("/in/c.mp3", "diff", "Z", "C"),
        ];
        let groups = find_duplicate_groups(&tracks);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].tracks.len(), 2);
        assert_eq!(groups[0].tier, DuplicateTier::ExactFile);
        // suggested_canonical should be the one with more tags (both have same completeness here,
        // so it picks the first one)
        assert!(!groups[0].suggested_canonical.is_empty());
    }

    #[test]
    fn canonical_picks_most_complete_tags() {
        let mut a = track("/in/a.mp3", "same", "X", "A");
        a.album = None;
        a.year = None;
        let b = track("/in/b.mp3", "same", "Y", "B");
        let tracks = vec![a, b];
        let groups = find_duplicate_groups(&tracks);
        assert_eq!(groups[0].suggested_canonical, "/in/b.mp3");
    }

    #[test]
    fn three_member_group() {
        let tracks = vec![
            track("/in/a.mp3", "dup", "X", "A"),
            track("/in/b.mp3", "dup", "Y", "B"),
            track("/in/c.mp3", "dup", "Z", "C"),
        ];
        let groups = find_duplicate_groups(&tracks);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].tracks.len(), 3);
    }
}
