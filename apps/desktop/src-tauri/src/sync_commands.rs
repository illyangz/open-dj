//! Tauri commands for the anonymous cloud sync backend (Convex). Pure
//! orchestration: every command here reads/writes through the same local
//! primitives the rest of the app already uses (`Store::set_cue_point`,
//! `opendj_metadata::write_tags`, `opendj_file_ops::checksum_file`) — no
//! new local persistence is introduced by this module.

use crate::state::AppState;
use opendj_sync::{CueDto, PreferencesDto, WaveformColorsDto};
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Also used by `community_commands.rs` — the device secret has exactly
/// one owner (this lazy-generate-and-persist path) so the two feature
/// areas can't independently decide "does a secret exist yet" and race.
///
/// Re-registers on every call, not just when a secret is freshly
/// generated — `register` is a cheap idempotent upsert-or-touch, and
/// skipping it once a secret exists locally turns out to be a real
/// footgun: the secret is only ever meaningful *for whichever Convex
/// deployment currently registered it*, so switching `CONVEX_URL` (e.g.
/// local dev backend → cloud deployment) silently orphans an
/// already-generated secret, and every subsequent call fails with
/// "unknown identity" until something explicitly re-registers it. Doing
/// it here means that class of bug can't recur — the identity is always
/// self-healing against whatever backend is actually configured.
pub(crate) async fn read_or_generate_secret(state: &State<'_, AppState>) -> CmdResult<String> {
    let settings = state.store.get_settings().map_err(map_err)?;
    let secret = if !settings.device_secret.is_empty() {
        settings.device_secret
    } else {
        let secret = Uuid::new_v4().simple().to_string();
        let mut updated = settings;
        updated.device_secret = secret.clone();
        state.store.save_settings(&updated).map_err(map_err)?;
        secret
    };
    state
        .sync_client
        .register_identity(&secret)
        .await
        .map_err(map_err)?;
    Ok(secret)
}

/// Generates a device secret on first call (persisted via the same
/// `Settings` blob as everything else), (re-)registers it with the sync
/// backend, and returns it — only ever invoked from an explicit "Reveal
/// recovery key" action in Settings, never surfaced automatically.
#[tauri::command]
pub async fn ensure_device_identity(state: State<'_, AppState>) -> CmdResult<String> {
    read_or_generate_secret(&state).await
}

/// "Use on this device" — confirms the pasted secret round-trips to a real
/// identity (register is idempotent register-or-touch, so this reuses the
/// exact same call rather than a separate claim/verify endpoint), then
/// adopts it as this device's identity.
#[tauri::command]
pub async fn import_device_identity(state: State<'_, AppState>, secret: String) -> CmdResult<()> {
    state
        .sync_client
        .register_identity(&secret)
        .await
        .map_err(map_err)?;
    let mut settings = state.store.get_settings().map_err(map_err)?;
    settings.device_secret = secret;
    state.store.save_settings(&settings).map_err(map_err)
}

#[tauri::command]
pub async fn push_track_sync_state(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let secret = read_or_generate_secret(&state).await?;
    let checksum = opendj_file_ops::checksum_file(&PathBuf::from(&path)).map_err(map_err)?;
    let probe = opendj_metadata::probe(&PathBuf::from(&path)).map_err(map_err)?;
    let cues = state.store.list_cue_points(&path).map_err(map_err)?;

    state
        .sync_client
        .push_track_state(
            &secret,
            &checksum,
            probe.tags.bpm,
            probe.tags.key,
            Some(probe.duration_ms),
            cues.into_iter()
                .map(|c| CueDto {
                    slot: c.slot as u32,
                    position_ms: c.position_ms,
                    label: c.label,
                    color: c.color,
                })
                .collect(),
        )
        .await
        .map_err(map_err)
}

/// Pulls this track's cloud state and applies it locally, but only where
/// local state is empty — this never overwrites cues or tags the user
/// already has on this device. Returns whether anything was applied, so
/// the caller can decide whether to re-read local state.
#[tauri::command]
pub async fn pull_track_sync_state(state: State<'_, AppState>, path: String) -> CmdResult<bool> {
    let secret = read_or_generate_secret(&state).await?;
    let checksum = opendj_file_ops::checksum_file(&PathBuf::from(&path)).map_err(map_err)?;
    let Some(remote) = state
        .sync_client
        .pull_track_state(&secret, &checksum)
        .await
        .map_err(map_err)?
    else {
        return Ok(false);
    };

    let mut applied = false;

    let local_cues = state.store.list_cue_points(&path).map_err(map_err)?;
    if local_cues.is_empty() && !remote.cues.is_empty() {
        for cue in &remote.cues {
            state
                .store
                .set_cue_point(
                    &path,
                    cue.slot as u8,
                    cue.position_ms,
                    cue.label.as_deref(),
                    cue.color.as_deref(),
                )
                .map_err(map_err)?;
        }
        applied = true;
    }

    if remote.bpm.is_some() || remote.musical_key.is_some() {
        let existing = opendj_metadata::probe(&PathBuf::from(&path))
            .map(|p| p.tags)
            .unwrap_or_default();
        if existing.bpm.is_none() && existing.key.is_none() {
            let fields = opendj_metadata::TagFields {
                bpm: remote.bpm.or(existing.bpm),
                key: remote.musical_key.or(existing.key),
                ..existing
            };
            opendj_metadata::write_tags(&PathBuf::from(&path), &fields).map_err(map_err)?;
            applied = true;
        }
    }

    Ok(applied)
}

#[tauri::command]
pub async fn push_preferences(state: State<'_, AppState>) -> CmdResult<()> {
    let secret = read_or_generate_secret(&state).await?;
    let settings = state.store.get_settings().map_err(map_err)?;

    if !settings.username.is_empty() {
        state
            .sync_client
            .set_username(&secret, &settings.username)
            .await
            .map_err(map_err)?;
    }

    state
        .sync_client
        .push_preferences(
            &secret,
            PreferencesDto {
                waveform_color_mode: Some(settings.waveform_color_mode),
                waveform_custom_colors: settings.waveform_custom_colors.map(|c| {
                    WaveformColorsDto {
                        low: c.low,
                        mid: c.mid,
                        high: c.high,
                    }
                }),
            },
        )
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn pull_preferences(state: State<'_, AppState>) -> CmdResult<()> {
    let secret = read_or_generate_secret(&state).await?;
    let remote = state
        .sync_client
        .pull_preferences(&secret)
        .await
        .map_err(map_err)?;

    let mut settings = state.store.get_settings().map_err(map_err)?;
    if let Some(username) = remote.username {
        settings.username = username;
    }
    if let Some(mode) = remote.preferences.waveform_color_mode {
        settings.waveform_color_mode = mode;
    }
    if let Some(colors) = remote.preferences.waveform_custom_colors {
        settings.waveform_custom_colors = Some(opendj_core::WaveformCustomColors {
            low: colors.low,
            mid: colors.mid,
            high: colors.high,
        });
    }
    state.store.save_settings(&settings).map_err(map_err)
}
