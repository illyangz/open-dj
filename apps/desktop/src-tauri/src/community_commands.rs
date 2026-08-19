//! Tauri commands for the anonymous community feed (crate/song sharing,
//! upvotes, mentions) — same Convex backend and same lazy device-identity
//! model as `sync_commands.rs`, but this is a *public* feed: listing reads
//! carry no secret at all (`sharedItems:listFeed` needs no identity), only
//! writes (share, upvote) touch the device identity.

use crate::state::AppState;
use crate::sync_commands::read_or_generate_secret;
use opendj_sync::{
    CommentDto, SharedItemDto, SharedItemKind, SharedTrackDto,
    UpvoteToggleResult as RemoteUpvoteToggleResult,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// Plain, snake_case-serializing mirrors of the sync crate's camelCase
// DTOs — kept separate so the frontend never sees Convex's own field
// naming, matching how sync_commands.rs never returns CueDto/TrackStateDto
// to the frontend either.
#[derive(Debug, Clone, Serialize)]
pub struct CommunityTrack {
    pub title: String,
    pub artist: Option<String>,
    pub bpm: Option<f64>,
    pub musical_key: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommunityItem {
    pub id: String,
    pub kind: String, // "crate" | "song" | "post"
    pub title: Option<String>,
    pub caption: Option<String>,
    pub tracks: Vec<CommunityTrack>,
    pub upvote_count: u32,
    pub created_at: i64,
    pub author_username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommunityUpvoteResult {
    pub upvoted: bool,
    pub upvote_count: u32,
}

impl From<SharedItemDto> for CommunityItem {
    fn from(d: SharedItemDto) -> Self {
        Self {
            id: d.id,
            kind: match d.kind {
                SharedItemKind::Crate => "crate".to_string(),
                SharedItemKind::Song => "song".to_string(),
                SharedItemKind::Post => "post".to_string(),
            },
            title: d.title,
            caption: d.caption,
            tracks: d
                .tracks
                .into_iter()
                .map(|t| CommunityTrack {
                    title: t.title,
                    artist: t.artist,
                    bpm: t.bpm,
                    musical_key: t.musical_key,
                    source_url: t.source_url,
                })
                .collect(),
            upvote_count: d.upvote_count,
            created_at: d.created_at,
            author_username: d.author_username,
        }
    }
}

impl From<RemoteUpvoteToggleResult> for CommunityUpvoteResult {
    fn from(r: RemoteUpvoteToggleResult) -> Self {
        Self {
            upvoted: r.upvoted,
            upvote_count: r.upvote_count,
        }
    }
}

/// Same metadata source every other command uses for a track's tags —
/// `opendj_metadata::probe`, re-read on demand (there's no stored "Track"
/// row to join against). Title falls back to the file stem, matching the
/// "Untitled" convention used elsewhere for untagged files.
fn track_dto_from_path(path: &str, source_url: Option<String>) -> CmdResult<SharedTrackDto> {
    let probe = opendj_metadata::probe(&PathBuf::from(path)).map_err(map_err)?;
    let title = probe.tags.title.unwrap_or_else(|| {
        Path::new(path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    });
    Ok(SharedTrackDto {
        title,
        artist: probe.tags.artist,
        bpm: probe.tags.bpm,
        musical_key: probe.tags.key,
        source_url,
    })
}

/// Maps a track's local file path back to the URL it was originally
/// downloaded from, when it was downloaded through this app at all — a
/// crate track that was manually dropped/scanned into the library, rather
/// than downloaded, simply has no entry here and gets shared without a
/// link. Built once per share (not cached) since it's just an in-memory
/// join over already-loaded rows, cheap next to the ffmpeg-free tag reads
/// this command already does per track.
fn source_url_by_path(state: &AppState) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(jobs) = state.store.list_jobs() else {
        return map;
    };
    for job in jobs {
        let Some(destination) = job.destination else {
            continue;
        };
        let Ok(input) = state.store.get_input(job.input_id) else {
            continue;
        };
        map.insert(destination, input.raw_value);
    }
    map
}

/// Shares a local crate's track list as a metadata snapshot — never the
/// audio itself. Each track carries a source URL when it's resolvable
/// (the track was downloaded through this app, not just scanned/dropped
/// into the library) so a recipient can actually fetch the same tracks.
#[tauri::command]
pub async fn share_crate(
    state: State<'_, AppState>,
    crate_id: Uuid,
    caption: Option<String>,
) -> CmdResult<String> {
    let secret = read_or_generate_secret(&state).await?;
    let crate_row = state.store.get_crate(crate_id).map_err(map_err)?;
    let paths = state.store.list_crate_tracks(crate_id).map_err(map_err)?;
    if paths.is_empty() {
        return Err("crate has no tracks".into());
    }
    let urls = source_url_by_path(&state);
    let tracks = paths
        .iter()
        .map(|p| track_dto_from_path(p, urls.get(p).cloned()))
        .collect::<CmdResult<Vec<_>>>()?;

    state
        .sync_client
        .share_item(
            &secret,
            SharedItemKind::Crate,
            Some(&crate_row.name),
            caption.as_deref(),
            tracks,
        )
        .await
        .map_err(map_err)
}

/// Manual "paste a link" flow — title/artist typed by the user in the
/// composer, not derived from any download/job row.
#[tauri::command]
pub async fn share_song(
    state: State<'_, AppState>,
    url: String,
    title: String,
    artist: Option<String>,
    caption: Option<String>,
) -> CmdResult<String> {
    let secret = read_or_generate_secret(&state).await?;
    let track = SharedTrackDto {
        title: title.clone(),
        artist,
        bpm: None,
        musical_key: None,
        source_url: Some(url),
    };
    state
        .sync_client
        .share_item(
            &secret,
            SharedItemKind::Song,
            Some(&title),
            caption.as_deref(),
            vec![track],
        )
        .await
        .map_err(map_err)
}

/// A plain text post — no crate, no link, just a caption. `title` is
/// deliberately `None`: the caption is the entire content, there's
/// nothing else to summarize it with.
#[tauri::command]
pub async fn share_post(state: State<'_, AppState>, caption: String) -> CmdResult<String> {
    let secret = read_or_generate_secret(&state).await?;
    state
        .sync_client
        .share_item(&secret, SharedItemKind::Post, None, Some(&caption), vec![])
        .await
        .map_err(map_err)
}

/// Fully public — no identity is created or read for a feed browse.
#[tauri::command]
pub async fn list_community_feed(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> CmdResult<Vec<CommunityItem>> {
    let items = state.sync_client.list_feed(limit).await.map_err(map_err)?;
    Ok(items.into_iter().map(CommunityItem::from).collect())
}

#[tauri::command]
pub async fn toggle_community_upvote(
    state: State<'_, AppState>,
    item_id: String,
) -> CmdResult<CommunityUpvoteResult> {
    let secret = read_or_generate_secret(&state).await?;
    state
        .sync_client
        .toggle_upvote(&secret, &item_id)
        .await
        .map(CommunityUpvoteResult::from)
        .map_err(map_err)
}

#[tauri::command]
pub async fn list_my_upvotes(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let secret = read_or_generate_secret(&state).await?;
    state
        .sync_client
        .my_upvoted_item_ids(&secret)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn list_community_mentions(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> CmdResult<Vec<CommunityItem>> {
    let secret = read_or_generate_secret(&state).await?;
    let items = state
        .sync_client
        .list_mentions(&secret, limit)
        .await
        .map_err(map_err)?;
    Ok(items.into_iter().map(CommunityItem::from).collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct CommunityComment {
    pub id: String,
    pub text: String,
    pub created_at: i64,
    pub author_username: Option<String>,
}

impl From<CommentDto> for CommunityComment {
    fn from(d: CommentDto) -> Self {
        Self {
            id: d.id,
            text: d.text,
            created_at: d.created_at,
            author_username: d.author_username,
        }
    }
}

#[tauri::command]
pub async fn add_community_comment(
    state: State<'_, AppState>,
    item_id: String,
    text: String,
) -> CmdResult<String> {
    let secret = read_or_generate_secret(&state).await?;
    state
        .sync_client
        .add_comment(&secret, &item_id, &text)
        .await
        .map_err(map_err)
}

/// Fully public — no identity is created or read for reading comments.
#[tauri::command]
pub async fn list_community_comments(
    state: State<'_, AppState>,
    item_id: String,
    limit: Option<u32>,
) -> CmdResult<Vec<CommunityComment>> {
    let comments = state
        .sync_client
        .list_comments(&item_id, limit)
        .await
        .map_err(map_err)?;
    Ok(comments.into_iter().map(CommunityComment::from).collect())
}

/// Fully public — powers @mention autocomplete while composing.
#[tauri::command]
pub async fn search_community_usernames(
    state: State<'_, AppState>,
    prefix: String,
    limit: Option<u32>,
) -> CmdResult<Vec<String>> {
    state
        .sync_client
        .search_usernames(&prefix, limit)
        .await
        .map_err(map_err)
}
