import { create } from "zustand";
import { api, onQueueUpdated } from "../lib/api";
import type { Job, ProviderInfo, Settings, WorkspaceId } from "../types";

const ZOOM_STORAGE_KEY = "opendj.zoomPercent";

function readStoredZoom(): number {
  const raw = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
  return raw >= 70 && raw <= 150 ? raw : 100;
}

interface AppStore {
  workspace: WorkspaceId;
  setWorkspace: (w: WorkspaceId) => void;

  tourOpen: boolean;
  setTourOpen: (open: boolean) => void;

  /** Shared across Library/Sort/Crates — these are the dense list workspaces
   * where a user might want more or less density than responsive width
   * alone gives. Persisted directly to localStorage rather than pulling in
   * Zustand's `persist` middleware for one field. */
  zoomPercent: number;
  setZoom: (percent: number) => void;

  jobs: Job[];
  selectedJobId: string | null;
  selectJob: (id: string | null) => void;
  refreshJobs: () => Promise<void>;
  patchJob: (job: Job) => void;
  removeJobs: (ids: string[]) => Promise<void>;
  ingest: (text: string) => Promise<void>;

  providers: ProviderInfo[];
  refreshProviders: () => Promise<void>;

  settings: Settings | null;
  refreshSettings: () => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  setUsername: (username: string) => Promise<void>;

  initialized: boolean;
  init: () => Promise<void>;
}

export const useAppStore = create<AppStore>((set, get) => ({
  workspace: "queue",
  setWorkspace: (w) => set({ workspace: w }),

  tourOpen: false,
  setTourOpen: (open) => set({ tourOpen: open }),

  zoomPercent: readStoredZoom(),
  setZoom: (percent) => {
    const clamped = Math.min(150, Math.max(70, percent));
    localStorage.setItem(ZOOM_STORAGE_KEY, String(clamped));
    set({ zoomPercent: clamped });
  },

  jobs: [],
  selectedJobId: null,
  selectJob: (id) => set({ selectedJobId: id }),
  refreshJobs: async () => {
    const jobs = await api.listJobs();
    set({ jobs });
  },
  // Patch a single job into the existing array in place — avoids an O(n)
  // re-fetch + re-render of the whole queue on every per-job state change,
  // which is what made large queues (thousands of jobs) get progressively
  // laggier as more jobs completed.
  patchJob: (job: Job) => {
    set((state) => {
      const idx = state.jobs.findIndex((j) => j.id === job.id);
      if (idx === -1) return { jobs: [job, ...state.jobs] };
      if (state.jobs[idx] === job) return state;
      const jobs = state.jobs.slice();
      jobs[idx] = job;
      return { jobs };
    });
  },
  removeJobs: async (ids: string[]) => {
    const idSet = new Set(ids);
    await Promise.all(ids.map((id) => api.deleteJob(id).catch(() => {})));
    set((state) => ({
      jobs: state.jobs.filter((j) => !idSet.has(j.id)),
      selectedJobId: idSet.has(state.selectedJobId ?? "") ? null : state.selectedJobId,
    }));
  },
  ingest: async (text: string) => {
    const created = await api.ingestInputs(text);
    if (created.length === 0) return;
    set((state) => ({ jobs: [...created, ...state.jobs], selectedJobId: created[0].id, workspace: "queue" }));
  },

  providers: [],
  refreshProviders: async () => {
    const providers = await api.listProviders();
    set({ providers });
  },

  settings: null,
  refreshSettings: async () => {
    const settings = await api.getSettings();
    set({ settings });
  },
  saveSettings: async (settings: Settings) => {
    await api.updateSettings(settings);
    set({ settings });
    if (settings.sync_enabled) void api.pushPreferences().catch(() => {});
    await get().refreshProviders();
  },
  // A username is a public community-identity concern, not a "sync my
  // personal data" one — it always pushes to the backend regardless of
  // `sync_enabled`, unlike every other preference field. Without this, a
  // user with sync off could set a username locally and never see it show
  // up on their own posts.
  setUsername: async (username: string) => {
    const current = get().settings;
    if (!current) return;
    const settings = { ...current, username };
    await api.updateSettings(settings);
    set({ settings });
    await api.pushPreferences();
  },

  initialized: false,
  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    await Promise.all([get().refreshJobs(), get().refreshProviders(), get().refreshSettings()]);
    if (get().settings?.sync_enabled) {
      // Best-effort: a fresh install/offline pull failing shouldn't block
      // startup, and the local settings we already loaded are a perfectly
      // usable fallback.
      api
        .pullPreferences()
        .then(() => get().refreshSettings())
        .catch(() => {});
    }
    await onQueueUpdated((job) => {
      get().patchJob(job);
    });
  },
}));
