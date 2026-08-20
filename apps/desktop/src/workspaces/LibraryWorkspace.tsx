import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, onStemModelDownloadProgress, onStemSplitProgress } from "../lib/api";
import { useTrackAnalysis } from "../lib/useTrackAnalysis";
import { useTrackWaveform } from "../lib/useTrackWaveform";
import { useAppStore } from "../store/useAppStore";
import { PlayIcon, PauseIcon, ExpandIcon, CloseIcon } from "../components/icons";
import { ZoomControl } from "../components/ZoomControl";
import { recolor } from "../lib/waveformColor";
import type {
  BandWaveform,
  Crate,
  CuePoint,
  Job,
  PlannedMove,
  StemDownloadResult,
  StemName,
  TrackFields,
  WaveformColorMode,
  WaveformCustomColors,
} from "../types";

const COLLISION_LABEL: Record<PlannedMove["collision"], string> = {
  none: "OK",
  skip: "Skip",
  rename: "Rename",
  replace_with_backup: "Replace w/ backup",
  manual_review: "Needs review",
};

/** FR-040–FR-044: scan a folder, preview a dry-run organization plan
 * against a folder template, flag duplicates by checksum, and export the
 * plan without applying it. Applying moves is intentionally not wired up
 * yet — see docs/planning/product-requirements.md §16 "definition of done"
 * for why a preview-only Library pass ships first. */
export function LibraryWorkspace() {
  const jobs = useAppStore((s) => s.jobs);
  const zoomPercent = useAppStore((s) => s.zoomPercent);
  const downloads = useMemo(
    () => jobs.filter((j) => j.state === "complete" && j.destination),
    [jobs],
  );
  const [tracks, setTracks] = useState<TrackFields[]>([]);
  const [scanning, setScanning] = useState(false);
  const [template, setTemplate] = useState("{artist}/{album}/{title}");
  const [destinationRoot, setDestinationRoot] = useState("");
  const [plan, setPlan] = useState<PlannedMove[] | null>(null);
  const [duplicates, setDuplicates] = useState<string[][]>([]);
  const [crates, setCrates] = useState<Crate[]>([]);

  useEffect(() => {
    api.listCrates().then(setCrates);
  }, []);

  async function createCrateAndAdd(name: string, trackPath: string) {
    const created = await api.createCrate(name);
    await api.addTrackToCrate(created.id, trackPath);
    setCrates((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
  }

  const audioRef = useRef<HTMLAudioElement>(null);
  // `selectedId` (which track is loaded into the shared <audio> element) is
  // deliberately separate from `isPlaying` (whether it's audibly playing) —
  // they used to be the same flag, which meant pausing fully deselected a
  // track and lost its playhead/cue context. Keeping them apart lets a
  // paused track stay "loaded": its playhead stays visible and its cues
  // stay jump-to-able without reloading.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // The shared <audio> element's play/pause state can change from several
  // call sites (togglePlay, jumpToCue, native `ended`) — mirror it into
  // React state from the element itself rather than setting `isPlaying` by
  // hand at every call site, so it can't drift out of sync.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
    };
  }, []);

  function togglePlay(job: Job) {
    if (!job.destination) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (selectedId === job.id) {
      if (audio.paused) void audio.play();
      else audio.pause();
    } else {
      audio.src = convertFileSrc(job.destination);
      setSelectedId(job.id);
      void audio.play();
    }
  }

  /** Jump to (and audibly confirm) a saved cue: loads+plays the track if it
   * isn't already selected, otherwise just retargets playback in place.
   * Distinct from `seekPreview` below — this one is allowed to start audio
   * because the user asked to hear a specific cue, not just to mark a
   * position. */
  function jumpToCue(job: Job, seconds: number) {
    if (!job.destination) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (selectedId !== job.id) {
      audio.src = convertFileSrc(job.destination);
      setSelectedId(job.id);
      const onLoaded = () => {
        audio.currentTime = seconds;
        audio.removeEventListener("loadedmetadata", onLoaded);
      };
      audio.addEventListener("loadedmetadata", onLoaded);
      void audio.play();
    } else {
      audio.currentTime = seconds;
      if (audio.paused) void audio.play();
    }
  }

  /** Waveform click: repositions the loaded track's playback if this row
   * is already selected, but — unlike `jumpToCue` — never starts playback
   * on its own. A row that isn't selected yet has no shared-audio-element
   * effect at all; its own local cursor (in DownloadRow) still updates for
   * visual feedback and cue-setting purposes independent of this, which is
   * what lets you set every cue on a track without ever pressing play. */
  function seekPreview(job: Job, seconds: number) {
    if (!job.destination) return;
    const audio = audioRef.current;
    if (!audio || selectedId !== job.id) return;
    audio.currentTime = seconds;
  }

  async function scanFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setScanning(true);
    setPlan(null);
    try {
      const paths = await api.scanLibraryFolder(dir);
      const scans = await Promise.all(paths.map((p) => api.scanFile(p).catch(() => null)));
      const nextTracks: TrackFields[] = scans
        .map((scan, i): TrackFields | null =>
          scan
            ? {
                source_path: paths[i],
                checksum: scan.checksum,
                artist: scan.probe.tags.artist,
                album: scan.probe.tags.album,
                year: scan.probe.tags.year,
                playlist: null,
                title: scan.probe.tags.title,
              }
            : null,
        )
        .filter((t): t is TrackFields => t !== null);
      setTracks(nextTracks);
      setDuplicates(await api.findDuplicateTracks(nextTracks));
    } finally {
      setScanning(false);
    }
  }

  async function preview() {
    if (tracks.length === 0 || !destinationRoot) return;
    setPlan(await api.buildOrganizationPlan(tracks, template, destinationRoot, []));
  }

  async function exportPlan(format: "csv" | "json") {
    if (!plan) return;
    const content =
      format === "json"
        ? JSON.stringify(plan, null, 2)
        : ["from,to,collision", ...plan.map((p) => `"${p.from}","${p.to}",${p.collision}`)].join("\n");
    const path = await save({ defaultPath: `opendj-organization-plan.${format}` });
    if (path) await api.writeTextFile(path, content);
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6" style={{ zoom: `${zoomPercent}%` }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display font-semibold text-xl">Library</h1>
          <p className="text-sm text-parchment-dim mt-1 max-w-lg">
            Scan a folder, preview how a folder template would organize it, and check for
            duplicate files by checksum — nothing moves until you apply it manually.
          </p>
        </div>
        <ZoomControl />
      </div>

      {downloads.length > 0 && (
        <div className="mt-6 w-full max-w-[1600px]">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Downloads</h2>
            <span className="text-xs text-parchment-dim">{downloads.length} track(s)</span>
          </div>
          <p className="text-xs text-parchment-dim mt-1">
            Reveal a file in Finder, then drag it straight into your DJ software or any folder.
          </p>
          <ul className="mt-3 space-y-1.5">
            {downloads.map((job) => (
              <DownloadRow
                key={job.id}
                job={job}
                selected={selectedId === job.id}
                playing={isPlaying && selectedId === job.id}
                onTogglePlay={() => togglePlay(job)}
                onSeekPreview={(seconds) => seekPreview(job, seconds)}
                onJumpToCue={(seconds) => jumpToCue(job, seconds)}
                audioRef={audioRef}
                crates={crates}
                onAddToCrate={(crateId) => job.destination && void api.addTrackToCrate(crateId, job.destination)}
                onCreateCrateAndAdd={(name) => job.destination && void createCrateAndAdd(name, job.destination)}
              />
            ))}
          </ul>
          <audio ref={audioRef} className="hidden" />
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <button
          onClick={scanFolder}
          disabled={scanning}
          className="px-4 py-2 rounded-lg text-sm font-semibold border border-charcoal-700 hover:border-teal/50 transition-colors disabled:opacity-40"
        >
          {scanning ? "Scanning…" : "Scan folder"}
        </button>
        <span className="text-xs text-parchment-dim">{tracks.length} file(s) scanned</span>
      </div>

      {tracks.length > 0 && (
        <div className="mt-6 w-full max-w-[1600px] space-y-4">
          <div className="flex flex-wrap gap-3">
            <Field label="Folder template">
              <input
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-2 text-sm font-mono w-64"
              />
            </Field>
            <Field label="Destination root">
              <input
                value={destinationRoot}
                onChange={(e) => setDestinationRoot(e.target.value)}
                placeholder="/Users/you/Music/Library"
                className="rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-2 text-sm font-mono w-72"
              />
            </Field>
          </div>
          <button
            onClick={preview}
            disabled={!destinationRoot}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim disabled:opacity-30 transition-colors"
          >
            Preview dry run
          </button>

          {duplicates.length > 0 && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
              <p className="text-sm font-medium text-danger">{duplicates.length} duplicate group(s) found</p>
              <ul className="mt-2 space-y-2 text-xs font-mono text-parchment-dim">
                {duplicates.map((group, i) => (
                  <li key={i}>{group.join("  ==  ")}</li>
                ))}
              </ul>
            </div>
          )}

          {plan && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{plan.length} planned move(s)</p>
                <div className="flex gap-2">
                  <button onClick={() => exportPlan("csv")} className="text-xs text-parchment-dim hover:text-parchment">
                    Export CSV
                  </button>
                  <button onClick={() => exportPlan("json")} className="text-xs text-parchment-dim hover:text-parchment">
                    Export JSON
                  </button>
                </div>
              </div>
              <ul className="space-y-1.5">
                {plan.map((p, i) => (
                  <li key={i} className="rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-2.5 text-xs font-mono">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate">{p.to}</span>
                      <span
                        className={
                          p.collision === "none"
                            ? "text-teal shrink-0"
                            : "text-signal shrink-0"
                        }
                      >
                        {COLLISION_LABEL[p.collision]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 8 pads/track — the pad count both Rekordbox and Serato use, so every
 * cue set here maps onto a real pad on export instead of getting dropped
 * or renumbered. Colors are fixed per slot (not user-chosen) to keep v1
 * simple; they're still carried through to Rekordbox/Serato on export so
 * pads show up color-coded there too. */
const CUE_COLORS = [
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#00c7be",
  "#0a84ff",
  "#af52de",
  "#ff2d92",
];

function AddToCrateButton({
  crates,
  onAdd,
  onCreateAndAdd,
}: {
  crates: Crate[];
  onAdd: (crateId: string) => void;
  onCreateAndAdd: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
      >
        + Crate
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-charcoal-700 bg-charcoal-800 shadow-xl py-1">
          {crates.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                onAdd(c.id);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-parchment hover:bg-charcoal-700 truncate"
            >
              {c.name}
            </button>
          ))}
          {crates.length > 0 && <div className="my-1 border-t border-charcoal-700" />}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              onCreateAndAdd(name);
              setNewName("");
              setOpen(false);
            }}
            className="px-2 py-1"
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New crate…"
              className="w-full bg-charcoal-900 border border-charcoal-700 rounded px-2 py-1 text-xs text-parchment placeholder:text-parchment-dim/60 focus:outline-none focus:border-teal/60"
            />
          </form>
        </div>
      )}
    </div>
  );
}

/** Default colors for 3-Band mode's stacked bands. "classic-blue" doesn't
 * render through this component at all (see `ClassicWaveform`) — its entry
 * here is unused, kept only so `MODE_COLORS` stays total over
 * `WaveformColorMode`. RGB mode has no entry: it renders literal
 * red/green/blue computed per column from real spectral energy, not a fixed
 * palette. */
const MODE_COLORS: Record<Exclude<WaveformColorMode, "rgb">, WaveformCustomColors> = {
  "three-band": { low: "#0a84ff", mid: "#ff9f0a", high: "#ececec" },
  "classic-blue": { low: "#0a84ff", mid: "#0a84ff", high: "#0a84ff" },
};

const WAVEFORM_CANVAS_HEIGHT = 260;

/** Renders the low/mid/high per-column STFT energy (see `BandWaveform` /
 * `generate_band_waveform`) straight to a canvas — real spectral analysis,
 * not a pre-rendered image, so height and color both reflect true
 * per-instant loudness rather than an independently max-normalized band.
 *
 * RGB Mode: one waveform, colored per column from the true low/mid/high
 * energy ratio (dB-compressed, each channel independently normalized) —
 * literal red/green/blue, the way Serato/Rekordbox color their waveforms.
 * Height comes from the overall peak envelope, independent of color.
 *
 * 3-Band Mode: the same per-column energies drawn as three full-height
 * bands stacked with additive `screen` blending, scaled against one shared
 * max across all three bands (not normalized independently) so relative
 * loudness between bands survives into the render. */
function GradientWaveform({
  bands,
  mode,
  customColors,
  className = "",
}: {
  bands: BandWaveform | null;
  mode: Exclude<WaveformColorMode, "classic-blue">;
  customColors: WaveformCustomColors | null;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bands || bands.low.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const n = bands.low.length;
    canvas.width = n;
    canvas.height = WAVEFORM_CANVAS_HEIGHT;
    const mid = WAVEFORM_CANVAS_HEIGHT / 2;
    ctx.clearRect(0, 0, n, WAVEFORM_CANVAS_HEIGHT);

    if (mode === "rgb") {
      // Color comes from each column's *relative* low/mid/high balance
      // (normalized against that column's own max), not from how each
      // channel compares to its behavior elsewhere in the track — a
      // channel normalized against its own history collapses to "how loud
      // is this channel right now vs. its own loudest moment," and on real
      // music where bands largely rise and fall together with the overall
      // mix, that reads as near-identical brightness in all three channels
      // at once (i.e. white) regardless of actual spectral color. Per-column
      // normalization instead asks "which band dominates *this instant*,"
      // which genuinely varies moment to moment (a kick reads bass-heavy,
      // a hat reads treble-heavy) even within a consistently loud track.
      // Height is unaffected — it still comes from the overall peak
      // envelope, independent of color.
      const peakMax = Math.max(...bands.peak) || 1;
      for (let x = 0; x < n; x++) {
        const l = bands.low[x], m = bands.mid[x], h = bands.high[x];
        const localMax = Math.max(l, m, h) || 1;
        const r = Math.round(Math.pow(l / localMax, 0.8) * 255);
        const g = Math.round(Math.pow(m / localMax, 0.8) * 255);
        const b = Math.round(Math.pow(h / localMax, 0.8) * 255);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const half = Math.pow(bands.peak[x] / peakMax, 0.6) * mid;
        ctx.fillRect(x, mid - half, 1, half * 2);
      }
      return;
    }

    const colors = customColors ?? MODE_COLORS["three-band"];
    const channels: [number[], string][] = [
      [bands.low, colors.low],
      [bands.mid, colors.mid],
      [bands.high, colors.high],
    ];
    const gMax = Math.max(...bands.low, ...bands.mid, ...bands.high) || 1;
    ctx.globalCompositeOperation = "screen";
    for (const [values, color] of channels) {
      ctx.fillStyle = color;
      for (let x = 0; x < n; x++) {
        const half = Math.pow(values[x] / gMax, 0.5) * mid;
        ctx.fillRect(x, mid - half, 1, half * 2);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }, [bands, mode, customColors]);

  if (!bands) return <div className={`bg-black ${className}`} />;

  return <canvas ref={canvasRef} className={`bg-black ${className}`} />;
}

/** "Classic Blue" mode: the plain pre-existing single-band amplitude
 * waveform (no frequency-color info), recolored to blue for naming
 * consistency — its backend render (`generate_waveform`) actually produces
 * a yellow-green shape by default. */
function ClassicWaveform({ src, className = "" }: { src: string | null; className?: string }) {
  const [blue, setBlue] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setBlue(null);
      return;
    }
    let cancelled = false;
    recolor(src, "#0a84ff")
      .then((uri) => {
        if (!cancelled) setBlue(uri);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div className={`bg-black ${className}`}>
      {blue && <img src={blue} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill pointer-events-none" />}
    </div>
  );
}

const WAVEFORM_MODE_LABEL: Record<WaveformColorMode, string> = {
  rgb: "RGB",
  "three-band": "3-Band",
  "classic-blue": "Classic Blue",
};

const STEM_LABELS: Record<StemName, string> = {
  vocals: "Vocals",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
};
const ALL_STEMS: StemName[] = ["vocals", "drums", "bass", "other"];

/** Real ML-based stem separation (isolated vocals/drums/bass/other via a
 * Demucs model) — distinct from the low/mid/high EQ-band waveform above,
 * which is a visual aid only and can't produce isolated stems. A checkbox
 * picker lets the user choose what to keep, but the note under the
 * checkboxes is honest that Demucs always computes all four together —
 * unchecking a stem only skips saving it, not the processing cost. */
function StemDownloadButton({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<StemName>>(new Set(ALL_STEMS));
  const [status, setStatus] = useState<"idle" | "downloading-model" | "splitting" | "done" | "error">("idle");
  const [percent, setPercent] = useState(0);
  const [result, setResult] = useState<StemDownloadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    if (!job.destination) return;
    const destination = job.destination;
    const unlistenModel = onStemModelDownloadProgress(({ downloaded, total }) => {
      setStatus("downloading-model");
      setPercent(total > 0 ? (downloaded / total) * 100 : 0);
    });
    const unlistenSplit = onStemSplitProgress((p) => {
      if (p.path !== destination) return;
      setStatus("splitting");
      setPercent(p.percent);
    });
    return () => {
      void unlistenModel.then((f) => f());
      void unlistenSplit.then((f) => f());
    };
  }, [job.destination]);

  function toggle(stem: StemName) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(stem)) next.delete(stem);
      else next.add(stem);
      return next;
    });
  }

  async function startDownload() {
    if (!job.destination || selected.size === 0) return;
    setStatus("downloading-model");
    setPercent(0);
    setError(null);
    try {
      const outcome = await api.separateTrackStems(job.destination, Array.from(selected));
      setResult(outcome);
      setStatus("done");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }

  const busy = status === "downloading-model" || status === "splitting";

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="px-2.5 py-1 rounded-full text-[11px] font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors disabled:opacity-40"
      >
        {busy ? `${status === "downloading-model" ? "Downloading model" : "Splitting"}… ${Math.round(percent)}%` : "Download Stems"}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-charcoal-700 bg-charcoal-800 shadow-xl p-3">
          <p className="text-[11px] font-semibold text-parchment-dim uppercase tracking-wide">Stems to save</p>
          <div className="mt-2 space-y-1.5">
            {ALL_STEMS.map((stem) => (
              <label key={stem} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(stem)}
                  onChange={() => toggle(stem)}
                  className="accent-signal"
                />
                {STEM_LABELS[stem]}
              </label>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-parchment-dim/70">
            Separation always processes the full track — unchecking a stem just skips saving it,
            not the processing time. First use downloads a ~200MB model; separation itself can
            take a couple minutes.
          </p>
          {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}
          {status === "done" && result ? (
            <div className="mt-2 space-y-1">
              {ALL_STEMS.filter((s) => result[s]).map((stem) => (
                <button
                  key={stem}
                  onClick={() => result[stem] && void revealItemInDir(result[stem]!)}
                  className="block w-full text-left text-xs text-signal hover:text-signal-dim"
                >
                  Reveal {STEM_LABELS[stem]} in Finder
                </button>
              ))}
            </div>
          ) : (
            <button
              onClick={() => void startDownload()}
              disabled={busy || selected.size === 0}
              className="mt-3 w-full px-3 py-1.5 rounded-md text-xs font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim disabled:opacity-30 transition-colors"
            >
              {busy ? "Working…" : "Download"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Full-screen detail view for one track: a large colored (low/mid/high
 * band) waveform plus the same 8 hot-cue pads as the row, sized and
 * hotkeyed (number keys 1-8) for actually dropping/checking cues rather
 * than just eyeballing them in a 40px-tall strip. Reuses the row's cue
 * state and cursor rather than owning a second copy, so cues set here
 * show up in the row immediately and vice versa. */
function TrackDetailModal({
  job,
  selected,
  playing,
  position,
  durationSec,
  cues,
  cueBySlot,
  onClose,
  onTogglePlay,
  onSeek,
  onJumpToCue,
  onSetCue,
  onDeleteCue,
}: {
  job: Job;
  selected: boolean;
  playing: boolean;
  position: number;
  durationSec: number;
  cues: CuePoint[];
  cueBySlot: Map<number, CuePoint>;
  onClose: () => void;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onJumpToCue: (seconds: number) => void;
  onSetCue: (slot: number) => void;
  onDeleteCue: (slot: number, e: React.MouseEvent) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const waveformColorMode = settings?.waveform_color_mode ?? "three-band";
  const customColors = settings?.waveform_custom_colors ?? null;

  const { bands, mono: monoWaveform } = useTrackWaveform(job.destination, waveformColorMode);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Number keys 1-8 jump to (or, if empty, drop) the matching hot cue;
  // space toggles playback; escape closes. This is the "hotkeys" surface
  // the enlarged view exists for — the small row waveform is too cramped
  // to comfortably rehearse a cue layout against.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key >= "1" && e.key <= "8") {
        const slot = Number(e.key) - 1;
        const cue = cueBySlot.get(slot);
        if (cue) onJumpToCue(cue.position_ms / 1000);
        else if (durationSec > 0) onSetCue(slot);
        e.preventDefault();
      } else if (e.key === " ") {
        onTogglePlay();
        e.preventDefault();
      } else if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cueBySlot, durationSec, onJumpToCue, onSetCue, onTogglePlay, onClose]);

  function fractionFromEvent(e: React.MouseEvent): number {
    const box = boxRef.current;
    if (!box) return 0;
    const rect = box.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  const playedFraction = durationSec > 0 ? Math.min(1, position / durationSec) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-charcoal-950/90 backdrop-blur-sm flex items-center justify-center p-8" onClick={onClose}>
      <div
        className="w-full max-w-4xl rounded-xl border border-charcoal-700 bg-charcoal-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold truncate">{job.title ?? job.destination}</p>
            {job.artist && <p className="text-sm text-parchment-dim truncate">{job.artist}</p>}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-8 h-8 rounded-full border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 flex items-center justify-center transition-colors"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={onTogglePlay}
            className="shrink-0 w-10 h-10 rounded-full bg-signal text-charcoal-950 flex items-center justify-center hover:bg-signal-dim transition-colors"
          >
            {playing ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 ml-0.5" />}
          </button>
          <span className="text-xs font-mono text-parchment-dim">
            {formatTime(position)} / {formatTime(durationSec)}
          </span>
          <span className="text-xs text-parchment-dim/60 flex-1">
            Click the waveform to set a position — the track doesn't need to be playing. Press 1-8 to jump to or drop a hot cue.
          </span>
          <div className="flex items-center gap-1 shrink-0 rounded-full border border-charcoal-700 p-0.5">
            {(Object.keys(WAVEFORM_MODE_LABEL) as WaveformColorMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => settings && void saveSettings({ ...settings, waveform_color_mode: mode })}
                className={[
                  "px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors",
                  waveformColorMode === mode
                    ? "bg-charcoal-700 text-signal"
                    : "text-parchment-dim hover:text-parchment",
                ].join(" ")}
              >
                {WAVEFORM_MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          <StemDownloadButton job={job} />
        </div>

        <div
          ref={boxRef}
          onClick={(e) => durationSec > 0 && onSeek(fractionFromEvent(e) * durationSec)}
          onMouseMove={(e) => setHoverFraction(fractionFromEvent(e))}
          onMouseLeave={() => setHoverFraction(null)}
          className="relative mt-4 h-56 rounded-lg overflow-hidden cursor-pointer select-none"
        >
          {waveformColorMode === "classic-blue" ? (
            <ClassicWaveform src={monoWaveform} className="absolute inset-0 w-full h-full" />
          ) : (
            <GradientWaveform
              bands={bands}
              mode={waveformColorMode}
              customColors={customColors}
              className="absolute inset-0 w-full h-full"
            />
          )}
          {((waveformColorMode === "classic-blue" && !monoWaveform) ||
            (waveformColorMode !== "classic-blue" && !bands)) && (
            <div className="absolute inset-0 animate-pulse bg-charcoal-800/50 flex items-center justify-center">
              <span className="text-xs text-parchment-dim/70">Rendering waveform…</span>
            </div>
          )}

          {durationSec > 0 && (selected || position > 0) && (
            <div
              className="absolute top-0 bottom-0 w-px bg-signal pointer-events-none"
              style={{ left: `${playedFraction * 100}%` }}
            >
              <span className="absolute -top-0.5 left-1.5 text-[11px] font-mono text-signal whitespace-nowrap bg-charcoal-950/70 px-1 rounded">
                {formatTime(position)}
              </span>
            </div>
          )}

          {hoverFraction !== null && durationSec > 0 && (
            <div
              className="absolute top-0 bottom-0 w-px bg-parchment/60 pointer-events-none"
              style={{ left: `${hoverFraction * 100}%` }}
            >
              <span className="absolute bottom-1 left-1.5 text-[11px] font-mono text-parchment/80 whitespace-nowrap bg-charcoal-950/70 px-1 rounded">
                {formatTime(hoverFraction * durationSec)}
              </span>
            </div>
          )}

          {durationSec > 0 &&
            cues.map((cue) => (
              <div
                key={cue.slot}
                className="absolute top-0 bottom-0 w-0.5 pointer-events-none"
                style={{
                  left: `${(cue.position_ms / 1000 / durationSec) * 100}%`,
                  backgroundColor: cue.color ?? CUE_COLORS[cue.slot],
                }}
              />
            ))}
        </div>

        <div className="flex items-center gap-2 mt-4">
          {Array.from({ length: 8 }, (_, slot) => {
            const cue = cueBySlot.get(slot);
            const color = cue ? (cue.color ?? CUE_COLORS[slot]) : undefined;
            return (
              <button
                key={slot}
                onClick={() => (cue ? onJumpToCue(cue.position_ms / 1000) : durationSec > 0 && onSetCue(slot))}
                disabled={!cue && durationSec === 0}
                title={
                  cue
                    ? `Jump to cue ${slot + 1} (${formatTime(cue.position_ms / 1000)})`
                    : `Drop cue ${slot + 1} at ${formatTime(position)}`
                }
                className={[
                  "group relative flex-1 h-12 rounded-lg text-sm font-mono font-semibold flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                  cue ? "text-charcoal-950" : "border border-charcoal-700 text-parchment-dim hover:border-teal/60 hover:text-parchment",
                ].join(" ")}
                style={cue ? { backgroundColor: color } : undefined}
              >
                {slot + 1}
                {cue && (
                  <span
                    onClick={(e) => onDeleteCue(slot, e)}
                    className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-5 h-5 rounded-full bg-charcoal-900 border border-charcoal-700 text-parchment-dim hover:text-parchment items-center justify-center text-[11px] leading-none"
                  >
                    ×
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DownloadRow({
  job,
  selected,
  playing,
  onTogglePlay,
  onSeekPreview,
  onJumpToCue,
  audioRef,
  crates,
  onAddToCrate,
  onCreateCrateAndAdd,
}: {
  job: Job;
  selected: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  onSeekPreview: (seconds: number) => void;
  onJumpToCue: (seconds: number) => void;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  crates: Crate[];
  onAddToCrate: (crateId: string) => void;
  onCreateCrateAndAdd: (name: string) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const waveformColorMode = settings?.waveform_color_mode ?? "three-band";
  const customColors = settings?.waveform_custom_colors ?? null;
  const { bands, mono: waveform } = useTrackWaveform(job.destination, waveformColorMode);
  const { bpm, key, durationSec, analyzing } = useTrackAnalysis(job.destination);
  // The cue-setting cursor: while `selected`, this tracks the shared
  // <audio> element's real position (so it moves during playback and
  // after a seek); while not selected, it's purely local, moved only by
  // clicking the waveform — which is what lets every cue on a track be
  // set without ever loading it into the shared player.
  const [position, setPosition] = useState(0);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);
  const [cues, setCues] = useState<CuePoint[]>([]);
  const [expanded, setExpanded] = useState(false);
  const waveformBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!job.destination) return;
    let cancelled = false;
    const destination = job.destination;
    api.listCuePoints(destination).then(async (result) => {
      if (cancelled) return;
      setCues(result);
      // Only worth asking the cloud for state when this track has none
      // locally yet — the Rust side re-checks this itself too, but
      // skipping the call entirely here avoids a pointless round trip on
      // every track that already has local cues (the common case).
      if (settings?.sync_enabled && result.length === 0) {
        const applied = await api.pullTrackSync(destination).catch(() => false);
        if (!cancelled && applied) {
          const refreshed = await api.listCuePoints(destination).catch(() => result);
          if (!cancelled) setCues(refreshed);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [job.destination, settings?.sync_enabled]);

  const cueBySlot = new Map(cues.map((c) => [c.slot, c]));

  async function setCueAtCurrentPosition(slot: number) {
    if (!job.destination) return;
    const cue = await api.setCuePoint(job.destination, slot, Math.round(position * 1000));
    setCues((prev) => [...prev.filter((c) => c.slot !== slot), cue]);
    if (settings?.sync_enabled) void api.pushTrackSync(job.destination).catch(() => {});
  }

  async function deleteCue(slot: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!job.destination) return;
    await api.deleteCuePoint(job.destination, slot);
    setCues((prev) => prev.filter((c) => c.slot !== slot));
    if (settings?.sync_enabled) void api.pushTrackSync(job.destination).catch(() => {});
  }

  // Keep `position` glued to the shared <audio> element's real time
  // whenever this row is the loaded one — including while paused, so a
  // manual seek (or the cue-jump landing point) is reflected immediately
  // rather than waiting for the next `timeupdate` tick during playback.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !selected) return;
    const sync = () => setPosition(audio.currentTime);
    audio.addEventListener("timeupdate", sync);
    audio.addEventListener("seeked", sync);
    sync();
    return () => {
      audio.removeEventListener("timeupdate", sync);
      audio.removeEventListener("seeked", sync);
    };
  }, [audioRef, selected]);

  function fractionFromEvent(e: React.MouseEvent): number {
    const box = waveformBoxRef.current;
    if (!box) return 0;
    const rect = box.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  /** Set the cue-setting cursor and, if this track happens to be the one
   * loaded into the shared player, retarget playback to match — but never
   * start playback on its own. */
  function handleSeek(seconds: number) {
    setPosition(seconds);
    onSeekPreview(seconds);
  }

  const playedFraction = durationSec > 0 ? Math.min(1, position / durationSec) : 0;

  return (
    <li className="rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          <button
            onClick={onTogglePlay}
            className="shrink-0 w-8 h-8 rounded-full bg-signal text-charcoal-950 flex items-center justify-center hover:bg-signal-dim transition-colors"
          >
            {playing ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4 ml-0.5" />}
          </button>
          <button
            onClick={() => setExpanded(true)}
            className="min-w-0 text-left group"
            title="Open enlarged waveform"
          >
            <p className="text-sm font-medium truncate group-hover:text-teal transition-colors">
              {job.title ?? job.destination}
              {job.artist && <span className="text-parchment-dim font-normal"> — {job.artist}</span>}
            </p>
            <p className="text-[11px] font-mono text-parchment-dim truncate">{job.destination}</p>
          </button>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {analyzing && (
            <span className="text-[10px] text-parchment-dim/60 px-1.5 py-0.5">Analyzing…</span>
          )}
          {bpm && (
            <span className="text-[10px] text-amber/70 bg-amber/10 px-1.5 py-0.5 rounded">
              {Math.round(bpm)} BPM
            </span>
          )}
          {key && (
            <span className="text-[10px] text-sky-400/70 bg-sky-400/10 px-1.5 py-0.5 rounded">
              {key}
            </span>
          )}
          <button
            onClick={() => setExpanded(true)}
            className="w-7 h-7 rounded-full border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 flex items-center justify-center transition-colors"
            title="Open enlarged waveform"
          >
            <ExpandIcon className="w-3.5 h-3.5" />
          </button>
          <AddToCrateButton crates={crates} onAdd={onAddToCrate} onCreateAndAdd={onCreateCrateAndAdd} />
          <button
            onClick={() => job.destination && void revealItemInDir(job.destination)}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
          >
            Reveal in Finder
          </button>
        </div>
      </div>

      <div
        ref={waveformBoxRef}
        onClick={(e) => durationSec > 0 && handleSeek(fractionFromEvent(e) * durationSec)}
        onMouseMove={(e) => setHoverFraction(fractionFromEvent(e))}
        onMouseLeave={() => setHoverFraction(null)}
        className="relative mt-2 h-10 rounded-md overflow-hidden bg-charcoal-900/60 cursor-pointer select-none"
      >
        {waveformColorMode === "classic-blue" ? (
          waveform ? (
            <ClassicWaveform src={waveform} className="w-full h-full" />
          ) : (
            <div className="w-full h-full animate-pulse bg-charcoal-800/50" />
          )
        ) : bands ? (
          <GradientWaveform bands={bands} mode={waveformColorMode} customColors={customColors} className="w-full h-full" />
        ) : (
          <div className="w-full h-full animate-pulse bg-charcoal-800/50" />
        )}

        {/* Cursor: current playback position while loaded, or the last
            clicked cue-setting point while not — visible either way so a
            cue can be placed and eyeballed without pressing play. */}
        {durationSec > 0 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-signal pointer-events-none"
            style={{ left: `${playedFraction * 100}%` }}
          >
            <span className="absolute -top-0.5 left-1 text-[10px] font-mono text-signal whitespace-nowrap">
              {formatTime(position)}
            </span>
          </div>
        )}

        {/* Hover preview: where a click would seek to */}
        {hoverFraction !== null && durationSec > 0 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-parchment/60 pointer-events-none"
            style={{ left: `${hoverFraction * 100}%` }}
          >
            <span className="absolute -bottom-0.5 left-1 text-[10px] font-mono text-parchment/80 whitespace-nowrap">
              {formatTime(hoverFraction * durationSec)}
            </span>
          </div>
        )}

        {/* Cue markers: colored ticks at each set pad's position */}
        {durationSec > 0 &&
          cues.map((cue) => (
            <div
              key={cue.slot}
              className="absolute top-0 bottom-0 w-0.5 pointer-events-none"
              style={{
                left: `${(cue.position_ms / 1000 / durationSec) * 100}%`,
                backgroundColor: cue.color ?? CUE_COLORS[cue.slot],
              }}
            />
          ))}
      </div>

      {/* Hot cue pads: click an empty pad anytime to drop a cue at the
          current cursor position (no need to be playing — click the
          waveform above first to move the cursor, then drop the pad);
          click a set pad anytime to jump there and start playback; hover
          a set pad to reveal a small delete affordance. */}
      <div className="flex items-center gap-1 mt-1.5">
        {Array.from({ length: 8 }, (_, slot) => {
          const cue = cueBySlot.get(slot);
          const color = cue ? (cue.color ?? CUE_COLORS[slot]) : undefined;
          return (
            <button
              key={slot}
              onClick={() => (cue ? onJumpToCue(cue.position_ms / 1000) : durationSec > 0 && void setCueAtCurrentPosition(slot))}
              disabled={!cue && durationSec === 0}
              title={
                cue
                  ? `Jump to cue ${slot + 1} (${formatTime(cue.position_ms / 1000)})`
                  : `Drop cue ${slot + 1} at ${formatTime(position)}`
              }
              className={[
                "group relative w-6 h-6 rounded text-[10px] font-mono font-semibold flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                cue ? "text-charcoal-950" : "border border-charcoal-700 text-parchment-dim hover:border-teal/60 hover:text-parchment",
              ].join(" ")}
              style={cue ? { backgroundColor: color } : undefined}
            >
              {slot + 1}
              {cue && (
                <span
                  onClick={(e) => void deleteCue(slot, e)}
                  className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-3.5 h-3.5 rounded-full bg-charcoal-900 border border-charcoal-700 text-parchment-dim hover:text-parchment items-center justify-center text-[9px] leading-none"
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
      </div>

      {expanded && (
        <TrackDetailModal
          job={job}
          selected={selected}
          playing={playing}
          position={position}
          durationSec={durationSec}
          cues={cues}
          cueBySlot={cueBySlot}
          onClose={() => setExpanded(false)}
          onTogglePlay={onTogglePlay}
          onSeek={handleSeek}
          onJumpToCue={onJumpToCue}
          onSetCue={(slot) => void setCueAtCurrentPosition(slot)}
          onDeleteCue={(slot, e) => void deleteCue(slot, e)}
        />
      )}
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-parchment-dim/70">{label}</span>
      {children}
    </label>
  );
}
