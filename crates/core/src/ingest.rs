use crate::model::{InputKind, InputRecord};
use chrono::Utc;
use uuid::Uuid;

/// FR-001: classify a single pasted/dropped line into a kind the job engine
/// knows how to route. This is intentionally conservative — anything that
/// isn't clearly a URL or an existing local path becomes a search `Query`,
/// which downstream providers resolve (or reject) rather than the parser
/// guessing.
pub fn classify_line(line: &str) -> InputKind {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return InputKind::Unsupported;
    }
    if looks_like_url(trimmed) {
        return InputKind::Url;
    }
    if looks_like_local_path(trimmed) {
        return InputKind::LocalPath;
    }
    InputKind::Query
}

fn looks_like_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn looks_like_local_path(s: &str) -> bool {
    let path = std::path::Path::new(s);
    if path.is_absolute() && path.exists() {
        return true;
    }
    // Windows drive-letter paths (e.g. C:\Music\track.mp3) or explicit
    // relative markers, without requiring the path to exist on this host
    // (useful for tests and for paths on a different volume than cwd).
    let has_drive_letter = s.len() > 2
        && s.as_bytes()[1] == b':'
        && (s.as_bytes()[2] == b'\\' || s.as_bytes()[2] == b'/');
    has_drive_letter || s.starts_with("./") || s.starts_with("../") || s.starts_with('/')
}

/// Best-effort provider guess used to tag inputs (and the jobs created
/// from them) before a provider adapter has actually resolved the input.
/// The provider registry is the source of truth for capability and policy;
/// this only decides which adapter gets first shot at the input.
///
/// URLs and free-text search queries both go to yt-dlp (universal adapter):
/// it extracts publicly available audio streams from streaming platforms
/// and searches YouTube for plain-text queries. Local files use the file
/// provider, and anything unsupported stays untagged so the registry's
/// `detect_for` fallback can evaluate it later.
pub fn guess_provider(raw: &str, kind: InputKind) -> Option<String> {
    match kind {
        InputKind::Url | InputKind::Query => Some("ytdlp".to_string()),
        InputKind::LocalPath => {
            let _ = raw;
            None
        }
        InputKind::Unsupported => None,
    }
}

/// When the "download extended versions" option is on, rewrite a free-text
/// search query toward the extended/dj-mix version of a track (YouTube
/// search is the resolution path, so this biases the query rather than
/// picking a specific upload). Queries that already mention "extended" are
/// left untouched; trailing Radio Edit/Edit markers are rewritten to
/// "Extended Mix"; anything else gets " extended mix" appended.
fn apply_extended(query: &str) -> String {
    let lower = query.to_ascii_lowercase();
    if lower.contains("extended") {
        return query.to_string();
    }
    for marker in [
        "- radio edit",
        "- radio mix",
        "radio edit",
        "radio mix",
        "- edit",
    ] {
        if lower.ends_with(marker) {
            let stem = query[..query.len() - marker.len()].trim_end();
            return format!("{stem} - Extended Mix");
        }
    }
    format!("{query} extended mix")
}

/// FR-003/FR-004: turn multiline pasted text into normalized, immutable
/// input records. Callers are responsible for surfacing a confirmation
/// summary when `inputs.len() > 25` (FR-004) — kept out of this pure
/// function so it stays trivially unit-testable.
///
/// `extended` selects "download the extended version": URLs and local
/// paths are never rewritten, but plain search queries are biased toward
/// extended mixes by `apply_extended`.
pub fn parse_inputs(text: &str, provenance: &str, extended: bool) -> Vec<InputRecord> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|line| {
            let kind = classify_line(line);
            let raw_value = if extended && kind == InputKind::Query {
                apply_extended(line)
            } else {
                line.to_string()
            };
            let provider_id = guess_provider(&raw_value, kind);
            InputRecord {
                id: Uuid::new_v4(),
                raw_value,
                kind,
                provider_id,
                created_at: Utc::now(),
                provenance: provenance.to_string(),
                parse_status: if kind == InputKind::Unsupported {
                    "unsupported".to_string()
                } else {
                    "parsed".to_string()
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_urls() {
        assert_eq!(
            classify_line("https://open.spotify.com/track/abc"),
            InputKind::Url
        );
        assert_eq!(classify_line("http://example.com/song.mp3"), InputKind::Url);
    }

    #[test]
    fn classifies_search_queries() {
        assert_eq!(classify_line("Daft Punk - One More Time"), InputKind::Query);
    }

    #[test]
    fn classifies_windows_paths_without_requiring_existence() {
        assert_eq!(classify_line(r"C:\Music\track.mp3"), InputKind::LocalPath);
    }

    #[test]
    fn blank_lines_are_unsupported() {
        assert_eq!(classify_line("   "), InputKind::Unsupported);
    }

    #[test]
    fn parse_inputs_skips_blank_lines_and_tags_provider() {
        let text = "https://soundcloud.com/artist/track\n\nDaft Punk - One More Time\n";
        let inputs = parse_inputs(text, "paste", false);
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0].provider_id.as_deref(), Some("ytdlp"));
        assert_eq!(inputs[1].kind, InputKind::Query);
        // Plain-text queries must be tagged so jobs resolve them via the
        // yt-dlp YouTube search path instead of failing with "no provider".
        assert_eq!(inputs[1].provider_id.as_deref(), Some("ytdlp"));
    }

    #[test]
    fn confirmation_threshold_is_left_to_the_caller() {
        let many = (0..30)
            .map(|i| format!("track {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let inputs = parse_inputs(&many, "paste", false);
        assert_eq!(inputs.len(), 30); // FR-004 confirmation UI is a caller concern
    }

    #[test]
    fn extended_rewrites_queries_not_urls() {
        let text = "Daft Punk - One More Time\nhttps://example.com/track.mp3\n/tmp/some.wav";
        let inputs = parse_inputs(text, "paste", true);
        assert_eq!(
            inputs[0].raw_value,
            "Daft Punk - One More Time extended mix"
        );
        assert_eq!(inputs[1].raw_value, "https://example.com/track.mp3");
        assert_eq!(inputs[2].raw_value, "/tmp/some.wav");
    }

    #[test]
    fn extended_rewrites_radio_edit_to_extended_mix() {
        let inputs = parse_inputs("Sentin - Find Us - Radio Edit", "paste", true);
        assert_eq!(inputs[0].raw_value, "Sentin - Find Us - Extended Mix");
    }

    #[test]
    fn extended_rewrites_trailing_edit_marker() {
        let inputs = parse_inputs(
            "Ankhoï - THE FUTURE - Notre Dame Remix - Edit",
            "paste",
            true,
        );
        assert_eq!(
            inputs[0].raw_value,
            "Ankhoï - THE FUTURE - Notre Dame Remix - Extended Mix"
        );
    }

    #[test]
    fn extended_leaves_existing_extended_alone() {
        let inputs = parse_inputs("Franc Fala - Looney Tunes - Extended Mix", "paste", true);
        assert_eq!(
            inputs[0].raw_value,
            "Franc Fala - Looney Tunes - Extended Mix"
        );
    }

    #[test]
    fn normal_parse_is_untouched_when_extended_off() {
        let inputs = parse_inputs("Sentin - Find Us - Radio Edit", "paste", false);
        assert_eq!(inputs[0].raw_value, "Sentin - Find Us - Radio Edit");
    }
}
