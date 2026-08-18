import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
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

  scanFile: (path: string) => invoke<FileScan>("scan_file", { path }),
  generateWaveform: (path: string) => invoke<string>("generate_waveform", { path }),
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

  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) => invoke<void>("update_settings", { settings }),

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
