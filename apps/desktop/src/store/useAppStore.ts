import { create } from "zustand";
import { api, onQueueUpdated } from "../lib/api";
import type { Job, ProviderInfo, Settings, WorkspaceId } from "../types";

interface AppStore {
  workspace: WorkspaceId;
  setWorkspace: (w: WorkspaceId) => void;

  tourOpen: boolean;
  setTourOpen: (open: boolean) => void;

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

  initialized: boolean;
  init: () => Promise<void>;
}

export const useAppStore = create<AppStore>((set, get) => ({
  workspace: "queue",
  setWorkspace: (w) => set({ workspace: w }),

  tourOpen: false,
  setTourOpen: (open) => set({ tourOpen: open }),

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
    await get().refreshProviders();
  },

  initialized: false,
  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    await Promise.all([get().refreshJobs(), get().refreshProviders(), get().refreshSettings()]);
    await onQueueUpdated((job) => {
      get().patchJob(job);
    });
  },
}));
