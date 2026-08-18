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

/// Best-effort provider guess used only for display before a provider
/// adapter has actually resolved the input. The provider registry is the
/// source of truth for capability and policy.
pub fn guess_provider(raw: &str, kind: InputKind) -> Option<String> {
    if kind != InputKind::Url {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    // All streaming platform URLs are handled by yt-dlp (universal adapter).
    // No API keys required — yt-dlp extracts publicly available audio streams.
    let _ = &lower; // suppress unused variable warning
    Some("ytdlp".to_string())
}

/// FR-003/FR-004: turn multiline pasted text into normalized, immutable
/// input records. Callers are responsible for surfacing a confirmation
/// summary when `inputs.len() > 25` (FR-004) — kept out of this pure
/// function so it stays trivially unit-testable.
pub fn parse_inputs(text: &str, provenance: &str) -> Vec<InputRecord> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|line| {
            let kind = classify_line(line);
            InputRecord {
                id: Uuid::new_v4(),
                raw_value: line.to_string(),
                kind,
                provider_id: guess_provider(line, kind),
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
        let inputs = parse_inputs(text, "paste");
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0].provider_id.as_deref(), Some("ytdlp"));
        assert_eq!(inputs[1].kind, InputKind::Query);
    }

    #[test]
    fn confirmation_threshold_is_left_to_the_caller() {
        let many = (0..30)
            .map(|i| format!("track {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let inputs = parse_inputs(&many, "paste");
        assert_eq!(inputs.len(), 30); // FR-004 confirmation UI is a caller concern
    }
}
