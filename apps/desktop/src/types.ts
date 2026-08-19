// Mirrors the Serialize/Deserialize shapes emitted by the Rust core
// (crates/core/src/model.rs, crates/providers/src/lib.rs, etc). Kept as
// plain interfaces rather than generated bindings for now — see
// CONTRIBUTING.md if you want to wire up `tauri-specta` later.

export type JobState =
  | "waiting"
  | "resolving"
  | "awaiting_confirmation"
  | "downloading"
  | "converting"
  | "tagging"
  | "organizing"
  | "complete"
  | "paused"
  | "cancelled"
  | "failed";

export interface Job {
  id: string;
  input_id: string;
  candidate_id: string | null;
  state: JobState;
  progress: number;
  title: string | null;
  artist: string | null;
  provider_id: string | null;
  requested_format: string | null;
  destination: string | null;
  error_class: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface Capabilities {
  metadata: boolean;
  download: boolean;
}

export type PolicyStatus = "permitted" | "metadata_only" | "not_configured";

export interface ProviderInfo {
  id: string;
  display_name: string;
  capabilities: Capabilities;
  policy_status: PolicyStatus;
}

export interface TrackCandidate {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_ms: number | null;
  provider: string;
  source_url: string;
  confidence: number;
  downloadable: boolean;
}

export interface TagFields {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  track_number: number | null;
  bpm: number | null;
  key: string | null;
}

export interface TrackAnalysis {
  bpm: number;
  bpm_confidence: number;
  key: string;
  key_confidence: number;
}

export interface AudioProbe {
  codec: string;
  duration_ms: number;
  bitrate_kbps: number | null;
  sample_rate_hz: number | null;
  channels: number | null;
  tags: TagFields;
  artwork_present: boolean;
}

export interface FileScan {
  path: string;
  checksum: string;
  probe: AudioProbe;
}

export interface ReplacementPreview {
  original: FileScan;
  candidate: FileScan;
  backup_directory: string;
}

export interface MutationRecord {
  original_path: string;
  backup_path: string;
  original_checksum: string;
  replacement_checksum: string;
  created_at: string;
}

export type MutationState = "prepared" | "backed_up" | "applied" | "restored_from_backup" | "failed";

export interface MutationJournal {
  id: string;
  job_id: string | null;
  original_path: string;
  backup_path: string;
  original_checksum: string;
  replacement_checksum: string | null;
  state: MutationState;
  created_at: string;
}

export type WaveformColorMode = "rgb" | "three-band" | "classic-blue";

export interface WaveformCustomColors {
  low: string;
  mid: string;
  high: string;
}

export interface Settings {
  download_root: string;
  folder_template: string;
  quality_policy: string;
  concurrency_network: number;
  concurrency_file_mutation: number;
  analytics_opt_in: boolean;
  lawful_use_acknowledged: boolean;
  youtube_cookies_browser: string;
  youtube_cookies_file: string;
  waveform_color_mode: WaveformColorMode;
  waveform_custom_colors: WaveformCustomColors | null;
  device_secret: string;
  username: string;
  sync_enabled: boolean;
}

export interface TrackFields {
  source_path: string;
  checksum: string;
  artist: string | null;
  album: string | null;
  year: number | null;
  playlist: string | null;
  title: string | null;
}

export type CollisionAction = "none" | "skip" | "rename" | "replace_with_backup" | "manual_review";

export interface PlannedMove {
  from: string;
  to: string;
  collision: CollisionAction;
}

export interface Diagnostics {
  app_version: string;
  job_count: number;
  mutation_count: number;
  providers: ProviderInfo[];
}

export interface SystemToolsStatus {
  ytdlp_path: string | null;
  ytdlp_version: string | null;
  ffmpeg_path: string | null;
  ffmpeg_version: string | null;
}

export interface ScTrack {
  id: number;
  title: string;
  artist: string;
  artwork: string | null;
  url: string;
  duration: number;
  bpm: number | null;
  key: string | null;
  genre: string | null;
  transcode_url: string | null;
}

/** A hot cue pad (slot 0-7, matching Rekordbox's and Serato's own pad
 * count), keyed by the track's own file path — see crates/core/src/db.rs
 * for why that's the identity instead of a job id. */
export interface CuePoint {
  id: string;
  track_path: string;
  slot: number;
  position_ms: number;
  label: string | null;
  color: string | null;
  created_at: string;
}

/** Three separate transparent-background PNGs (low/mid/high frequency
 * bands) meant to be stacked as layered `<img>` elements — see the Rust
 * `generate_band_waveform` command for why compositing happens client-side
 * instead of server-side. */
export interface BandWaveform {
  low: string;
  mid: string;
  high: string;
}

export type StemName = "vocals" | "drums" | "bass" | "other";

/** Only the stems the caller asked to keep come back populated — the rest
 * were computed (Demucs always separates all four together) but deleted
 * server-side to match the user's picker selection. */
export interface StemDownloadResult {
  vocals: string | null;
  drums: string | null;
  bass: string | null;
  other: string | null;
}

export interface StemModelDownloadProgress {
  downloaded: number;
  total: number;
}

export interface StemSplitProgress {
  path: string;
  stage: string;
  percent: number;
}

export type SharedItemKind = "crate" | "song" | "post";

export interface CommunityTrack {
  title: string;
  artist: string | null;
  bpm: number | null;
  musical_key: string | null;
  source_url: string | null;
}

export interface CommunityItem {
  id: string;
  kind: SharedItemKind;
  title: string | null;
  caption: string | null;
  tracks: CommunityTrack[];
  upvote_count: number;
  created_at: number;
  author_username: string | null;
}

export interface CommunityUpvoteResult {
  upvoted: boolean;
  upvote_count: number;
}

export interface CommunityComment {
  id: string;
  text: string;
  created_at: number;
  author_username: string | null;
}

export interface Crate {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type WorkspaceId =
  | "queue"
  | "soundcloud"
  | "repair"
  | "library"
  | "sort"
  | "crates"
  | "community"
  | "automations"
  | "settings";
