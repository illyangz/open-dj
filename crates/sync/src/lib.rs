//! HTTP client for the OpenDJ Convex sync backend. Stateless — like the
//! provider adapters in `opendj-providers` take a `client_id` rather than
//! owning credentials, every method here takes the caller's device secret
//! as an argument rather than this client holding or persisting one.
//! Local persistence of the secret itself is `opendj-core`'s job (it lives
//! in `Settings`, the same tier as everything else that's saved on disk).

mod error;

pub use error::{Result, SyncError};

use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Convex's `v.optional(x)` means the key may be *absent*, not that it may
/// be `null` — an explicit `null` fails validation the same as a wrong
/// type. `serde_json::json!` has no way to conditionally omit a key based
/// on an `Option` being `None`, so every `Option<T>` we serialize turns
/// into a literal `null` unless we strip it out first. Recurses into
/// nested objects/arrays so this also covers e.g. `SharedTrackDto`'s
/// optional fields nested inside the `tracks` array.
fn strip_nulls(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            for v in map.values_mut() {
                strip_nulls(v);
            }
        }
        serde_json::Value::Array(items) => {
            for v in items {
                strip_nulls(v);
            }
        }
        _ => {}
    }
}

/// Convex's `v.number()` is always a JS float64 and always serializes with
/// a decimal point (`0.0`, `1787160007767.0`, never bare `0`/`1787160007767`)
/// — `serde_json` refuses to deserialize a token with a decimal point
/// directly into an integer type, so every plain `u32`/`u64`/`i64` field
/// fed by a Convex response needs to go through `f64` first. Applied via
/// `#[serde(deserialize_with = "...")]` on the affected fields below; only
/// affects the *incoming* direction (fields we serialize outbound as
/// integers are accepted by Convex either way).
mod number_as_int {
    use serde::{Deserialize, Deserializer};

    pub fn u32<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u32, D::Error> {
        Ok(f64::deserialize(d)? as u32)
    }

    pub fn u64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
        Ok(f64::deserialize(d)? as u64)
    }

    pub fn i64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<i64, D::Error> {
        Ok(f64::deserialize(d)? as i64)
    }

    pub fn opt_u64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
        Ok(Option::<f64>::deserialize(d)?.map(|v| v as u64))
    }
}

pub struct SyncClient {
    http: reqwest::Client,
    base_url: String,
}

impl SyncClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("OpenDJ/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("reqwest client"),
            base_url: base_url.into(),
        }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        kind: &str,
        path: &str,
        mut args: serde_json::Value,
    ) -> Result<T> {
        strip_nulls(&mut args);
        let url = format!("{}/api/{kind}", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({ "path": path, "args": args, "format": "json" }))
            .send()
            .await?
            .error_for_status()?;
        match resp.json::<ConvexEnvelope<T>>().await? {
            ConvexEnvelope::Success { value } => Ok(value),
            ConvexEnvelope::Error { error_message } => Err(SyncError::Remote(error_message)),
        }
    }

    pub async fn register_identity(&self, secret: &str) -> Result<IdentityInfo> {
        self.call(
            "mutation",
            "identities:register",
            serde_json::json!({ "rawSecret": secret }),
        )
        .await
    }

    pub async fn set_username(&self, secret: &str, username: &str) -> Result<()> {
        self.call(
            "mutation",
            "identities:setUsername",
            serde_json::json!({ "rawSecret": secret, "username": username }),
        )
        .await
    }

    /// Fully public — no secret. Powers @mention autocomplete while composing.
    pub async fn search_usernames(&self, prefix: &str, limit: Option<u32>) -> Result<Vec<String>> {
        self.call(
            "query",
            "identities:searchUsernames",
            serde_json::json!({ "prefix": prefix, "limit": limit }),
        )
        .await
    }

    pub async fn push_preferences(&self, secret: &str, preferences: PreferencesDto) -> Result<()> {
        self.call(
            "mutation",
            "identities:setPreferences",
            serde_json::json!({ "rawSecret": secret, "preferences": preferences }),
        )
        .await
    }

    pub async fn pull_preferences(&self, secret: &str) -> Result<PreferencesResponse> {
        self.call(
            "query",
            "identities:getPreferences",
            serde_json::json!({ "rawSecret": secret }),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn push_track_state(
        &self,
        secret: &str,
        checksum: &str,
        bpm: Option<f64>,
        musical_key: Option<String>,
        duration_ms: Option<u64>,
        cues: Vec<CueDto>,
    ) -> Result<()> {
        self.call(
            "mutation",
            "trackStates:push",
            serde_json::json!({
                "rawSecret": secret,
                "checksum": checksum,
                "bpm": bpm,
                "musicalKey": musical_key,
                "durationMs": duration_ms,
                "cues": cues,
            }),
        )
        .await
    }

    pub async fn pull_track_state(
        &self,
        secret: &str,
        checksum: &str,
    ) -> Result<Option<TrackStateDto>> {
        self.call(
            "query",
            "trackStates:pull",
            serde_json::json!({ "rawSecret": secret, "checksum": checksum }),
        )
        .await
    }

    pub async fn share_item(
        &self,
        secret: &str,
        kind: SharedItemKind,
        title: Option<&str>,
        caption: Option<&str>,
        tracks: Vec<SharedTrackDto>,
    ) -> Result<String> {
        self.call(
            "mutation",
            "sharedItems:share",
            serde_json::json!({
                "rawSecret": secret,
                "kind": kind,
                "title": title,
                "caption": caption,
                "tracks": tracks,
            }),
        )
        .await
    }

    /// Fully public — no secret. Community feed browsing needs no identity.
    pub async fn list_feed(&self, limit: Option<u32>) -> Result<Vec<SharedItemDto>> {
        self.call(
            "query",
            "sharedItems:listFeed",
            serde_json::json!({ "limit": limit }),
        )
        .await
    }

    pub async fn toggle_upvote(&self, secret: &str, item_id: &str) -> Result<UpvoteToggleResult> {
        self.call(
            "mutation",
            "upvotes:toggle",
            serde_json::json!({ "rawSecret": secret, "itemId": item_id }),
        )
        .await
    }

    pub async fn my_upvoted_item_ids(&self, secret: &str) -> Result<Vec<String>> {
        self.call(
            "query",
            "upvotes:myUpvotedItemIds",
            serde_json::json!({ "rawSecret": secret }),
        )
        .await
    }

    pub async fn list_mentions(
        &self,
        secret: &str,
        limit: Option<u32>,
    ) -> Result<Vec<SharedItemDto>> {
        self.call(
            "query",
            "mentions:listMentioningMe",
            serde_json::json!({ "rawSecret": secret, "limit": limit }),
        )
        .await
    }

    pub async fn add_comment(&self, secret: &str, item_id: &str, text: &str) -> Result<String> {
        self.call(
            "mutation",
            "comments:add",
            serde_json::json!({ "rawSecret": secret, "itemId": item_id, "text": text }),
        )
        .await
    }

    /// Fully public — no secret. Reading comments needs no identity.
    pub async fn list_comments(
        &self,
        item_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<CommentDto>> {
        self.call(
            "query",
            "comments:list",
            serde_json::json!({ "itemId": item_id, "limit": limit }),
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ConvexEnvelope<T> {
    Success {
        value: T,
    },
    Error {
        #[serde(rename = "errorMessage")]
        error_message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueDto {
    #[serde(deserialize_with = "number_as_int::u32")]
    pub slot: u32,
    #[serde(deserialize_with = "number_as_int::u64")]
    pub position_ms: u64,
    pub label: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveformColorsDto {
    pub low: String,
    pub mid: String,
    pub high: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesDto {
    pub waveform_color_mode: Option<String>,
    pub waveform_custom_colors: Option<WaveformColorsDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesResponse {
    pub username: Option<String>,
    pub preferences: PreferencesDto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStateDto {
    pub bpm: Option<f64>,
    pub musical_key: Option<String>,
    #[serde(deserialize_with = "number_as_int::opt_u64")]
    pub duration_ms: Option<u64>,
    pub cues: Vec<CueDto>,
    #[serde(deserialize_with = "number_as_int::i64")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    pub identity_id: String,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SharedItemKind {
    Crate,
    Song,
    /// A plain text post — no tracks, `caption` is the entire content.
    Post,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTrackDto {
    pub title: String,
    pub artist: Option<String>,
    pub bpm: Option<f64>,
    pub musical_key: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedItemDto {
    pub id: String,
    pub kind: SharedItemKind,
    pub title: Option<String>,
    pub caption: Option<String>,
    pub tracks: Vec<SharedTrackDto>,
    #[serde(deserialize_with = "number_as_int::u32")]
    pub upvote_count: u32,
    #[serde(deserialize_with = "number_as_int::i64")]
    pub created_at: i64,
    pub author_username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpvoteToggleResult {
    pub upvoted: bool,
    #[serde(deserialize_with = "number_as_int::u32")]
    pub upvote_count: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentDto {
    pub id: String,
    pub text: String,
    #[serde(deserialize_with = "number_as_int::i64")]
    pub created_at: i64,
    pub author_username: Option<String>,
}
