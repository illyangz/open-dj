import { create } from "zustand";
import { api, onQueueUpdated } from "../lib/api";
import type {
  DownloadFormat,
  Job,
  PlayerState,
  PlayerTrack,
  ProviderInfo,
  ScTrack,
  Settings,
  WorkspaceId,
} from "../types";

const ZOOM_STORAGE_KEY = "opendj.zoomPercent";

function readStoredZoom(): number {
  const raw = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
  return raw >= 70 && raw <= 150 ? raw : 100;
}

// Cache the last SoundCloud lookup (username + results) across reloads/
// restarts so reopening the app doesn't force a re-fetch of a likes list
// that can run into the hundreds of tracks. This is a convenience cache,
// not a database — a new successful search just overwrites it. Living
// state (in-flight fetch, queued downloads) is kept in the store below so
// switching workspace tabs never interrupts or loses it — only a full
// app restart falls back to this cache.
const SC_CACHE_KEY = "opendj:soundcloud:last-lookup";

interface SoundcloudCache {
  username: string;
  tracks: ScTrack[];
}

function loadSoundcloudCache(): SoundcloudCache | null {
  try {
    const raw = localStorage.getItem(SC_CACHE_KEY);
    return raw ? (JSON.parse(raw) as SoundcloudCache) : null;
  } catch {
    return null;
  }
}

function saveSoundcloudCache(entry: SoundcloudCache) {
  try {
    localStorage.setItem(SC_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage full/unavailable — caching is a convenience, not required.
  }
}

interface SoundcloudState {
  username: string;
  tracks: ScTrack[];
  loading: boolean;
  error: string | null;
  /** SoundCloud track id -> the queue Job id it was enqueued as, so the
   * SoundCloud tab can read real download progress/completion straight off
   * `jobs` instead of tracking its own (easily desynced) copy. */
  queuedJobIds: Record<number, string>;
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
  /** Creates jobs for `text` and merges them into `jobs` without switching
   * workspace — the shared primitive behind `ingest` (paste box, always
   * jumps to the Queue tab) and SoundCloud downloads (stay put, just show
   * up in the queue). Merges rather than blindly prepending so a job that
   * already raced ahead via a `queue-updated` event (fast resolves/
   * downloads can finish before this call's promise even returns) doesn't
   * get overwritten by its own stale just-created snapshot — that stale
   * copy would sit at a different array index than the live one, so the
   * queue keeps showing a phantom "active" row for a track that already
   * finished downloading. */
  enqueue: (text: string) => Promise<Job[]>;
  ingest: (text: string) => Promise<void>;

  providers: ProviderInfo[];
  refreshProviders: () => Promise<void>;

  settings: Settings | null;
  refreshSettings: () => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  setUsername: (username: string) => Promise<void>;

  initialized: boolean;
  init: () => Promise<void>;

  /** Global playback transport — survives workspace tab switches.
   * One <audio> element owned by GlobalAudioElement at the App.tsx root. */
  player: PlayerState;
  playTrack: (track: PlayerTrack, contextQueue: PlayerTrack[]) => void;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  next: () => void;
  prev: () => void;
  setPlayerPosition: (pos: number) => void;
  setPlayerDuration: (dur: number) => void;

  /** Selected download format for new ingestions. Persisted in settings. */
  selectedFormat: DownloadFormat;
  setSelectedFormat: (fmt: DownloadFormat) => void;

  /** Lives here (not local component state) so a lookup or a batch of
   * downloads keeps running/showing progress when the user switches away
   * to another workspace tab and back — the SoundCloud workspace used to
   * hold all of this in `useState`, which React tears down on unmount. */
  soundcloud: SoundcloudState;
  setSoundcloudUsername: (username: string) => void;
  fetchSoundcloudLikes: () => Promise<void>;
  /** Downloads a SoundCloud track via the normal ingest/queue pipeline
   * (ytdlp already handles soundcloud.com URLs) instead of a bespoke
   * direct-download path, so it actually shows up — and can be retried,
   * paused, etc — in the Queue tab like every other download. */
  queueSoundcloudDownload: (track: ScTrack) => Promise<void>;
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
  enqueue: async (text: string) => {
    const format = get().selectedFormat;
    const created = await api.ingestInputs(text, format);
    if (created.length > 0) {
      set((state) => {
        const existingIds = new Set(state.jobs.map((j) => j.id));
        const newOnes = created.filter((j) => !existingIds.has(j.id));
        return newOnes.length > 0 ? { jobs: [...newOnes, ...state.jobs] } : state;
      });
    }
    return created;
  },
  ingest: async (text: string) => {
    const created = await get().enqueue(text);
    if (created.length === 0) return;
    set({ selectedJobId: created[0].id, workspace: "queue" });
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
    // Restore selected format from settings
    const settings = get().settings;
    if (settings?.default_output_format) {
      set({ selectedFormat: settings.default_output_format });
    }
    if (get().settings?.sync_enabled) {
      api
        .pullPreferences()
        .then(() => get().refreshSettings())
        .catch(() => {});
    }
    await onQueueUpdated((job) => {
      get().patchJob(job);
    });
  },

  player: { current: null, isPlaying: false, position: 0, contextQueue: [] },
  playTrack: (track, contextQueue) => {
    set({ player: { current: track, isPlaying: true, position: 0, contextQueue } });
  },
  togglePlay: () => {
    set((s) => ({
      player: { ...s.player, isPlaying: !s.player.isPlaying },
    }));
  },
  seek: (seconds) => {
    set((s) => ({ player: { ...s.player, position: seconds } }));
  },
  next: () => {
    const { player } = get();
    if (!player.current) return;
    const idx = player.contextQueue.findIndex(
      (t) => t.jobId === player.current!.jobId,
    );
    if (idx < 0 || idx >= player.contextQueue.length - 1) return;
    const next = player.contextQueue[idx + 1];
    set({ player: { ...player, current: next, position: 0 } });
  },
  prev: () => {
    const { player } = get();
    if (!player.current) return;
    const idx = player.contextQueue.findIndex(
      (t) => t.jobId === player.current!.jobId,
    );
    if (idx <= 0) return;
    const prev = player.contextQueue[idx - 1];
    set({ player: { ...player, current: prev, position: 0 } });
  },
  setPlayerPosition: (pos) => set((s) => ({ player: { ...s.player, position: pos } })),
  setPlayerDuration: (dur) =>
    set((s) => ({
      player: {
        ...s.player,
        current: s.player.current ? { ...s.player.current, durationSec: dur } : null,
      },
    })),

  selectedFormat: "mp3",
  setSelectedFormat: (fmt) => set({ selectedFormat: fmt }),

  soundcloud: (() => {
    const cached = loadSoundcloudCache();
    return {
      username: cached?.username ?? "",
      tracks: cached?.tracks ?? [],
      loading: false,
      error: null,
      queuedJobIds: {},
    };
  })(),
  setSoundcloudUsername: (username) =>
    set((state) => ({ soundcloud: { ...state.soundcloud, username } })),
  fetchSoundcloudLikes: async () => {
    const u = get().soundcloud.username.trim().replace(/^@/, "");
    if (!u) return;
    set((state) => ({ soundcloud: { ...state.soundcloud, loading: true, error: null } }));
    try {
      const tracks = await api.fetchSoundcloudLikes(u);
      saveSoundcloudCache({ username: u, tracks });
      set((state) => ({ soundcloud: { ...state.soundcloud, tracks, loading: false } }));
    } catch (e: any) {
      set((state) => ({
        soundcloud: {
          ...state.soundcloud,
          error: e?.toString() || "Failed to fetch likes",
          tracks: [],
          loading: false,
        },
      }));
    }
  },
  queueSoundcloudDownload: async (track: ScTrack) => {
    try {
      const created = await get().enqueue(track.url);
      const jobId = created[0]?.id;
      if (jobId) {
        set((state) => ({
          soundcloud: {
            ...state.soundcloud,
            queuedJobIds: { ...state.soundcloud.queuedJobIds, [track.id]: jobId },
          },
        }));
      }
    } catch (e: any) {
      set((state) => ({
        soundcloud: {
          ...state.soundcloud,
          error: `Failed to queue "${track.title}": ${e?.toString() || "unknown error"}`,
        },
      }));
    }
  },
}));
