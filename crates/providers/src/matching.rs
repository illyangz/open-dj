//! Pick the right YouTube upload for a known track.
//!
//! YouTube is only the audio source for DRM platforms (Spotify, Apple
//! Music) and free-text queries, so "the top search result" is not good
//! enough: it is routinely a lyric video with a chopped intro, a cover, a
//! sped-up/nightcore edit, a live take, or — when the query itself is weak
//! — something unrelated. Instead, every search hit is scored against what
//! we know about the track (title, artist, duration) and the best one is
//! only accepted above `MIN_SCORE`; below it, the job fails with "no
//! confident match" rather than downloading the wrong file.

/// What we know about the track we're looking for.
#[derive(Debug, Clone, Default)]
pub struct Target {
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: Option<u64>,
}

/// One search result, as reported by `yt-dlp --flat-playlist`.
#[derive(Debug, Clone, Default)]
pub struct Hit {
    pub title: String,
    pub channel: Option<String>,
    pub duration_ms: Option<u64>,
}

/// Below this, a hit is treated as "not the track" and rejected.
pub const MIN_SCORE: f32 = 0.55;

/// At or above this, a match is downloaded automatically. Between
/// `MIN_SCORE` and this it is plausible but uncertain, and is held as
/// "needs review" for the user to approve instead.
pub const AUTO_ACCEPT: f32 = 0.8;

/// Words that mark a different *version* of a song. A hit containing one
/// the target doesn't (or vice versa) is almost always the wrong file.
const VARIANT_MARKERS: &[&str] = &[
    "cover",
    "karaoke",
    "instrumental",
    "remix",
    "live",
    "reaction",
    "nightcore",
    "sped up",
    "speed up",
    "slowed",
    "reverb",
    "8d",
    "acapella",
    "a cappella",
    "acoustic",
    "tutorial",
    "lesson",
    "mashup",
    "bass boosted",
    "1 hour",
    "10 hours",
    "full album",
    "extended",
    "vip",
    "bootleg",
    "flip",
    "rework",
    "edit",
    "piano version",
];

/// Bracketed words that don't change what the audio is. Anything *else*
/// in a hit's (…)/[…] — "(Valmer Edit) [HZRX]", "(Jersey Club)" — marks
/// some variant we have no specific rule for.
const NEUTRAL_TAGS: &[&str] = &[
    "official",
    "audio",
    "video",
    "music",
    "lyric",
    "lyrics",
    "visualizer",
    "visualiser",
    "hd",
    "hq",
    "4k",
    "remaster",
    "remastered",
    "explicit",
    "clean",
    "version",
    "original",
    "mix",
    "radio",
    "full",
    "song",
    "mv",
    "color",
    "coded",
    "single",
    "album",
    "premiere",
    "out",
    "now",
];

/// Filler that shouldn't count toward (or against) title/artist coverage.
const STOPWORDS: &[&str] = &[
    "feat",
    "ft",
    "featuring",
    "the",
    "a",
    "an",
    "and",
    "x",
    "with",
];

/// Split into lowercase alphanumeric words. Unicode-aware so non-Latin
/// titles still match.
fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

fn content_words(s: &str) -> Vec<String> {
    words(s)
        .into_iter()
        .filter(|w| !STOPWORDS.contains(&w.as_str()))
        .collect()
}

/// Space-padded normalized text, so `has_phrase` matches whole words only
/// ("live" must not match "oliver").
fn padded(s: &str) -> String {
    format!(" {} ", words(s).join(" "))
}

fn has_phrase(padded_text: &str, phrase: &str) -> bool {
    padded_text.contains(&format!(" {phrase} "))
}

/// The core song name: drop "(feat. …)", "[Remastered]", and Spotify's
/// " - Radio Edit" / " - 2011 Remaster" suffixes. Variant words those
/// carried (remix, live, …) are still compared via `VARIANT_MARKERS` on
/// the full title.
fn core_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut depth = 0u32;
    for c in title.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let cut = out.split(" - ").next().unwrap_or(&out).to_string();
    if content_words(&cut).is_empty() {
        title.to_string()
    } else {
        cut
    }
}

/// Words inside (…) and […] only.
fn bracketed_words(title: &str) -> Vec<String> {
    let mut inner = String::new();
    let mut depth = 0u32;
    for c in title.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                inner.push(' ');
            }
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth > 0 => inner.push(c),
            _ => {}
        }
    }
    words(&inner)
}

/// Fraction of `needle` words present in `haystack`.
fn coverage(needle: &[String], haystack: &[String]) -> f32 {
    if needle.is_empty() {
        return 0.0;
    }
    let found = needle.iter().filter(|w| haystack.contains(w)).count();
    found as f32 / needle.len() as f32
}

/// The primary artist only — "A, B & C" → "A" — since uploads usually
/// credit the lead artist and featured artists vary wildly.
pub fn primary_artist(artist: &str) -> &str {
    let lower = artist.to_lowercase();
    let mut end = artist.len();
    for sep in [",", " & ", " feat", " ft.", " x ", " and "] {
        if let Some(i) = lower.find(sep) {
            end = end.min(i);
        }
    }
    artist[..end].trim()
}

pub fn score(target: &Target, hit: &Hit) -> f32 {
    let hit_title_words = words(&hit.title);
    let channel = hit.channel.as_deref().unwrap_or("");
    let channel_words = words(channel);
    let mut title_and_channel = hit_title_words.clone();
    title_and_channel.extend(channel_words.iter().cloned());

    // Weighted average over the signals we actually have, so a target
    // without an artist or duration isn't punished for the missing data.
    let mut total = 0.0f32;
    let mut weight = 0.0f32;

    let title_words = content_words(&core_title(&target.title));
    // With no separate artist (a bare free-text query), the query words may
    // name the artist too, which usually lives in the channel name.
    let title_cov = if target.artist.is_some() {
        coverage(&title_words, &hit_title_words)
    } else {
        coverage(&title_words, &title_and_channel)
    };
    total += 0.5 * title_cov;
    weight += 0.5;

    let mut channel_is_artist = false;
    if let Some(artist) = target.artist.as_deref() {
        let artist_words = content_words(primary_artist(artist));
        if !artist_words.is_empty() {
            // Channel handles squash names together ("TheKillersMusic",
            // "fredagainagainagain"), so also compare with spaces removed.
            let compact_channel = words(channel).concat();
            let compact_artist = artist_words.concat();
            channel_is_artist = coverage(&artist_words, &channel_words) >= 1.0
                || (compact_artist.len() >= 3 && compact_channel.contains(&compact_artist));
            let artist_cov = if channel_is_artist {
                1.0
            } else {
                coverage(&artist_words, &title_and_channel)
            };
            total += 0.25 * artist_cov;
            weight += 0.25;
        }
    }

    let mut duration_penalty = 0.0;
    if let (Some(want), Some(got)) = (target.duration_ms, hit.duration_ms) {
        let diff_s = want.abs_diff(got) as f32 / 1000.0;
        let s = match diff_s {
            d if d <= 3.0 => 1.0,
            d if d <= 8.0 => 0.8,
            d if d <= 15.0 => 0.5,
            d if d <= 30.0 => 0.2,
            _ => 0.0,
        };
        total += 0.25 * s;
        weight += 0.25;
        if diff_s > 60.0 {
            // A minute off is a different edit, a compilation, or a video
            // with a long skit — not the track.
            duration_penalty = 0.3;
        }
    }

    let mut score = total / weight - duration_penalty;

    let target_text = padded(&target.title);
    let hit_text = padded(&hit.title);
    for marker in VARIANT_MARKERS {
        let in_target = has_phrase(&target_text, marker);
        let in_hit = has_phrase(&hit_text, marker);
        if in_hit && !in_target {
            score -= 0.5;
        } else if in_target && !in_hit {
            score -= 0.2;
        }
    }

    let known = words(&format!(
        "{} {}",
        target.title,
        target.artist.as_deref().unwrap_or("")
    ));
    let unexplained = bracketed_words(&hit.title).into_iter().any(|w| {
        !NEUTRAL_TAGS.contains(&w.as_str())
            && !STOPWORDS.contains(&w.as_str())
            && !known.contains(&w)
            && !w.chars().all(|c| c.is_ascii_digit())
    });
    if unexplained {
        score -= 0.15;
    }

    // Auto-generated "Artist - Topic" channels carry the studio master.
    if channel.to_lowercase().ends_with(" - topic") {
        score += 0.15;
    } else if channel_is_artist {
        score += 0.1;
    }
    if has_phrase(&hit_text, "official audio") {
        score += 0.05;
    }

    score
}

/// Index and score of the best hit, if any clears `MIN_SCORE`. Ties go to
/// the earlier (higher-ranked by YouTube) hit.
pub fn best_match(target: &Target, hits: &[Hit]) -> Option<(usize, f32)> {
    hits.iter()
        .enumerate()
        .map(|(i, h)| (i, score(target, h)))
        .fold(None, |best: Option<(usize, f32)>, (i, s)| match best {
            Some((_, bs)) if bs >= s => best,
            _ => Some((i, s)),
        })
        .filter(|(_, s)| *s >= MIN_SCORE)
}

/// Split a free-text query "Artist - Title" into a target. Without a
/// " - " separator the whole query is treated as the title.
pub fn target_from_query(query: &str) -> Target {
    match query.split_once(" - ") {
        Some((artist, title)) if !artist.trim().is_empty() && !title.trim().is_empty() => Target {
            title: title.trim().to_string(),
            artist: Some(artist.trim().to_string()),
            duration_ms: None,
        },
        _ => Target {
            title: query.trim().to_string(),
            artist: None,
            duration_ms: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(title: &str, channel: &str, secs: u64) -> Hit {
        Hit {
            title: title.into(),
            channel: Some(channel.into()),
            duration_ms: Some(secs * 1000),
        }
    }

    fn one_more_time() -> Target {
        Target {
            title: "One More Time".into(),
            artist: Some("Daft Punk".into()),
            duration_ms: Some(320_357),
        }
    }

    #[test]
    fn prefers_official_audio_over_lyric_reupload() {
        let hits = vec![
            hit(
                "Daft Punk - One More Time (Lyrics)",
                "PitchPerfect Channel",
                282,
            ),
            hit(
                "Daft Punk - One More Time (Official Audio)",
                "Daft Punk",
                321,
            ),
        ];
        assert_eq!(best_match(&one_more_time(), &hits).map(|m| m.0), Some(1));
    }

    #[test]
    fn artist_channel_beats_lyric_reupload_with_same_audio() {
        let t = Target {
            title: "Mr. Brightside".into(),
            artist: Some("The Killers".into()),
            duration_ms: Some(222_000),
        };
        let hits = vec![
            hit("The Killers - Mr Brightside (Lyrics)", "Lost Panda", 224),
            hit("Mr. Brightside", "TheKillersMusic", 223),
        ];
        assert_eq!(best_match(&t, &hits).map(|m| m.0), Some(1));
    }

    #[test]
    fn rejects_unrelated_results() {
        let hits = vec![
            hit("Top 10 Spotify Tricks You Didn't Know", "TechGuy", 610),
            hit("Lo-fi beats to study to", "Chill Radio", 3600),
        ];
        assert_eq!(best_match(&one_more_time(), &hits), None);
    }

    #[test]
    fn penalizes_covers_and_speed_edits() {
        let t = one_more_time();
        let original = score(&t, &hit("One More Time", "Daft Punk - Topic", 320));
        let cover = score(
            &t,
            &hit("Daft Punk - One More Time (Piano Cover)", "Pianist", 318),
        );
        let sped = score(&t, &hit("one more time (sped up)", "speedy", 250));
        assert!(original > cover + 0.3, "{original} vs {cover}");
        assert!(original > sped + 0.3, "{original} vs {sped}");
        assert!(cover < MIN_SCORE);
    }

    #[test]
    fn remix_target_wants_the_remix() {
        let t = Target {
            title: "Titanium - Alesso Remix".into(),
            artist: Some("David Guetta, Sia".into()),
            duration_ms: None,
        };
        let hits = vec![
            hit(
                "David Guetta - Titanium ft. Sia (Official Video)",
                "David Guetta",
                245,
            ),
            hit(
                "David Guetta ft. Sia - Titanium (Alesso Remix)",
                "Alesso",
                330,
            ),
        ];
        assert_eq!(best_match(&t, &hits).map(|m| m.0), Some(1));
    }

    #[test]
    fn fan_edits_and_previews_are_not_auto_accepted() {
        let t = one_more_time();
        let edit = score(
            &t,
            &hit(
                "Daft Punk - One More Time (Valmer Edit) [HZRX]",
                "HOUZ",
                314,
            ),
        );
        let preview = score(&t, &hit("One More Time", "Daft Punk", 30));
        assert!(edit < MIN_SCORE, "{edit}");
        assert!(preview < AUTO_ACCEPT, "{preview}");
    }

    #[test]
    fn neutral_brackets_are_fine() {
        let t = one_more_time();
        let s = score(
            &t,
            &hit(
                "Daft Punk - One More Time [Official Video] (2001)",
                "Daft Punk",
                322,
            ),
        );
        assert!(s >= AUTO_ACCEPT, "{s}");
    }

    #[test]
    fn free_text_query_matches_artist_in_channel() {
        let t = target_from_query("mr brightside");
        let hits = vec![hit(
            "Mr. Brightside (Official Music Video)",
            "The Killers",
            228,
        )];
        assert!(best_match(&t, &hits).is_some());
    }

    #[test]
    fn free_text_query_splits_artist_and_title() {
        let t = target_from_query("The Killers - Mr. Brightside");
        assert_eq!(t.artist.as_deref(), Some("The Killers"));
        assert_eq!(t.title, "Mr. Brightside");
    }

    #[test]
    fn core_title_strips_feat_and_remaster_suffix() {
        assert_eq!(
            content_words(&core_title("Song (feat. X) - 2011 Remaster")),
            vec!["song"]
        );
    }

    #[test]
    fn variant_words_match_whole_words_only() {
        // "live" must not fire on "Oliver", "delivery", …
        let t = Target {
            title: "Oliver".into(),
            artist: Some("Someone".into()),
            duration_ms: None,
        };
        assert!(score(&t, &hit("Someone - Oliver", "Someone", 200)) >= MIN_SCORE);
    }
}
