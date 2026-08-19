import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BandWaveform,
  CommunityComment,
  CommunityItem,
  CommunityUpvoteResult,
  Crate,
  CuePoint,
  Diagnostics,
  FileScan,
  Job,
  MutationJournal,
  MutationRecord,
  PlannedMove,
  ProviderInfo,
  ReplacementPreview,
  ScTrack,
  Settings,
  StemDownloadResult,
  StemModelDownloadProgress,
  StemName,
  StemSplitProgress,
  SystemToolsStatus,
  TrackAnalysis,
  TrackCandidate,
  TrackFields,
} from "../types";

export const api = {
  ingestInputs: (text: string) => invoke<Job[]>("ingest_inputs", { text }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  pauseJob: (id: string) => invoke<Job>("pause_job", { id }),
  resumeJob: (id: string) => invoke<Job>("resume_job", { id }),
  cancelJob: (id: string) => invoke<Job>("cancel_job", { id }),
  retryJob: (id: string) => invoke<Job>("retry_job", { id }),
  deleteJob: (id: string) => invoke<void>("delete_job", { id }),

  setCuePoint: (trackPath: string, slot: number, positionMs: number, label?: string, color?: string) =>
    invoke<CuePoint>("set_cue_point", { trackPath, slot, positionMs, label, color }),
  deleteCuePoint: (trackPath: string, slot: number) =>
    invoke<void>("delete_cue_point", { trackPath, slot }),
  listCuePoints: (trackPath: string) => invoke<CuePoint[]>("list_cue_points", { trackPath }),

  createCrate: (name: string) => invoke<Crate>("create_crate", { name }),
  renameCrate: (id: string, name: string) => invoke<Crate>("rename_crate", { id, name }),
  deleteCrate: (id: string) => invoke<void>("delete_crate", { id }),
  listCrates: () => invoke<Crate[]>("list_crates"),
  addTrackToCrate: (crateId: string, trackPath: string) =>
    invoke<void>("add_track_to_crate", { crateId, trackPath }),
  removeTrackFromCrate: (crateId: string, trackPath: string) =>
    invoke<void>("remove_track_from_crate", { crateId, trackPath }),
  listCrateTracks: (crateId: string) => invoke<string[]>("list_crate_tracks", { crateId }),
  reorderCrateTracks: (crateId: string, orderedPaths: string[]) =>
    invoke<void>("reorder_crate_tracks", { crateId, orderedPaths }),

  scanFile: (path: string) => invoke<FileScan>("scan_file", { path }),
  generateWaveform: (path: string) => invoke<string>("generate_waveform", { path }),
  generateBandWaveform: (path: string) => invoke<BandWaveform>("generate_band_waveform", { path }),
  separateTrackStems: (path: string, stems: StemName[]) =>
    invoke<StemDownloadResult>("separate_track_stems", { path, stems }),
  analyzeTrack: (path: string) => invoke<TrackAnalysis>("analyze_track", { path }),
  previewReplacement: (originalPath: string, candidatePath: string) =>
    invoke<ReplacementPreview>("preview_replacement", { originalPath, candidatePath }),
  applyReplacement: (originalPath: string, candidatePath: string) =>
    invoke<MutationRecord>("apply_replacement", { originalPath, candidatePath }),
  listMutationJournal: () => invoke<MutationJournal[]>("list_mutation_journal"),
  restoreMutation: (journalId: string) => invoke<string>("restore_mutation", { journalId }),

  listProviders: () => invoke<ProviderInfo[]>("list_providers"),
  searchProviders: (query: string, providerId?: string) =>
    invoke<TrackCandidate[]>("search_providers", { query, providerId: providerId ?? null }),

  buildOrganizationPlan: (
    tracks: TrackFields[],
    folderTemplate: string,
    destinationRoot: string,
    existingDestinations: string[],
  ) =>
    invoke<PlannedMove[]>("build_organization_plan", {
      tracks,
      folderTemplate,
      destinationRoot,
      existingDestinations,
    }),
  findDuplicateTracks: (tracks: TrackFields[]) => invoke<string[][]>("find_duplicate_tracks", { tracks }),
  scanLibraryFolder: (directory: string) => invoke<string[]>("scan_library_folder", { directory }),
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  // Tauri's invoke bridge serializes args as JSON, so a Uint8Array has to
  // become a plain number array first — it doesn't survive JSON.stringify
  // as-is the way it would over a binary channel.
  writeBinaryFile: (path: string, content: Uint8Array) =>
    invoke<void>("write_binary_file", { path, content: Array.from(content) }),

  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) => invoke<void>("update_settings", { settings }),

  ensureDeviceIdentity: () => invoke<string>("ensure_device_identity"),
  importDeviceIdentity: (secret: string) => invoke<void>("import_device_identity", { secret }),
  pushTrackSync: (path: string) => invoke<void>("push_track_sync_state", { path }),
  pullTrackSync: (path: string) => invoke<boolean>("pull_track_sync_state", { path }),
  pushPreferences: () => invoke<void>("push_preferences"),
  pullPreferences: () => invoke<void>("pull_preferences"),

  shareCrateToCommunity: (crateId: string, caption?: string) =>
    invoke<string>("share_crate", { crateId, caption }),
  shareSongToCommunity: (url: string, title: string, artist?: string, caption?: string) =>
    invoke<string>("share_song", { url, title, artist, caption }),
  sharePostToCommunity: (caption: string) => invoke<string>("share_post", { caption }),
  listCommunityFeed: (limit?: number) => invoke<CommunityItem[]>("list_community_feed", { limit }),
  toggleCommunityUpvote: (itemId: string) =>
    invoke<CommunityUpvoteResult>("toggle_community_upvote", { itemId }),
  listMyUpvotes: () => invoke<string[]>("list_my_upvotes"),
  listCommunityMentions: (limit?: number) =>
    invoke<CommunityItem[]>("list_community_mentions", { limit }),
  addCommunityComment: (itemId: string, text: string) =>
    invoke<string>("add_community_comment", { itemId, text }),
  listCommunityComments: (itemId: string, limit?: number) =>
    invoke<CommunityComment[]>("list_community_comments", { itemId, limit }),
  searchCommunityUsernames: (prefix: string, limit?: number) =>
    invoke<string[]>("search_community_usernames", { prefix, limit }),

  checkSystemTools: () => invoke<SystemToolsStatus>("check_system_tools"),

  fetchSoundcloudLikes: (username: string) =>
    invoke<ScTrack[]>("fetch_soundcloud_likes", { username }),
  downloadSoundcloudTrack: (scTrack: ScTrack) =>
    invoke<string>("download_soundcloud_track", { scTrack }),

  exportDiagnostics: () => invoke<Diagnostics>("export_diagnostics"),
};

/** FR-010: subscribe to per-job state changes emitted by the Rust job
 * engine. Each event carries the single job that changed, not the whole
 * queue — callers should patch it in place rather than re-fetching. */
export function onQueueUpdated(callback: (job: Job) => void) {
  return listen<Job>("queue-updated", (event) => callback(event.payload));
}

/** One-time ~200MB model fetch, only fires the first time stem separation
 * runs on a machine (subsequent runs use the cached model). */
export function onStemModelDownloadProgress(callback: (progress: StemModelDownloadProgress) => void) {
  return listen<StemModelDownloadProgress>("stem-model-download-progress", (event) => callback(event.payload));
}

/** Per-track separation progress. The backend only ever runs one
 * separation at a time, but events still carry `path` so a listener can
 * ignore stale events for a track the user has since navigated away from. */
export function onStemSplitProgress(callback: (progress: StemSplitProgress) => void) {
  return listen<StemSplitProgress>("stem-split-progress", (event) => callback(event.payload));
}
