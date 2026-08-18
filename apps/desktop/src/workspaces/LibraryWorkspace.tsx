import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { useTrackAnalysis } from "../lib/useTrackAnalysis";
import { useAppStore } from "../store/useAppStore";
import { PlayIcon, PauseIcon } from "../components/icons";
import type { Job, PlannedMove, TrackFields } from "../types";

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

  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  function togglePlay(job: Job) {
    if (!job.destination) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === job.id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = convertFileSrc(job.destination);
    void audio.play();
    setPlayingId(job.id);
  }

  /** Click-to-seek on a waveform: switch to this track (if it isn't already
   * playing) and jump straight to `seekSeconds`. */
  function playFrom(job: Job, seekSeconds: number) {
    if (!job.destination) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId !== job.id) {
      audio.src = convertFileSrc(job.destination);
      setPlayingId(job.id);
      const onLoaded = () => {
        audio.currentTime = seekSeconds;
        audio.removeEventListener("loadedmetadata", onLoaded);
      };
      audio.addEventListener("loadedmetadata", onLoaded);
      void audio.play();
    } else {
      audio.currentTime = seekSeconds;
      if (audio.paused) void audio.play();
    }
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
    <div className="flex-1 min-w-0 overflow-y-auto p-6">
      <h1 className="font-display font-semibold text-xl">Library</h1>
      <p className="text-sm text-parchment-dim mt-1 max-w-lg">
        Scan a folder, preview how a folder template would organize it, and check for duplicate
        files by checksum — nothing moves until you apply it manually.
      </p>

      {downloads.length > 0 && (
        <div className="mt-6 max-w-2xl">
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
                playing={playingId === job.id}
                onTogglePlay={() => togglePlay(job)}
                onSeek={(seconds) => playFrom(job, seconds)}
                audioRef={audioRef}
              />
            ))}
          </ul>
          <audio ref={audioRef} onEnded={() => setPlayingId(null)} className="hidden" />
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
        <div className="mt-6 max-w-2xl space-y-4">
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

function DownloadRow({
  job,
  playing,
  onTogglePlay,
  onSeek,
  audioRef,
}: {
  job: Job;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  audioRef: React.RefObject<HTMLAudioElement | null>;
}) {
  const [waveform, setWaveform] = useState<string | null>(null);
  const [waveformFailed, setWaveformFailed] = useState(false);
  const { bpm, key, durationSec, analyzing } = useTrackAnalysis(job.destination);
  const [currentTime, setCurrentTime] = useState(0);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);
  const waveformBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!job.destination) return;
    let cancelled = false;
    api
      .generateWaveform(job.destination)
      .then((uri) => {
        if (!cancelled) setWaveform(uri);
      })
      .catch(() => {
        if (!cancelled) setWaveformFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [job.destination]);

  // Track playback position for the playhead — only while this row is the
  // one actually playing.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playing) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    audio.addEventListener("timeupdate", onTimeUpdate);
    setCurrentTime(audio.currentTime);
    return () => audio.removeEventListener("timeupdate", onTimeUpdate);
  }, [audioRef, playing]);

  function fractionFromEvent(e: React.MouseEvent): number {
    const box = waveformBoxRef.current;
    if (!box) return 0;
    const rect = box.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  const playedFraction = durationSec > 0 ? Math.min(1, currentTime / durationSec) : 0;

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
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {job.title ?? job.destination}
              {job.artist && <span className="text-parchment-dim font-normal"> — {job.artist}</span>}
            </p>
            <p className="text-[11px] font-mono text-parchment-dim truncate">{job.destination}</p>
          </div>
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
            onClick={() => job.destination && void revealItemInDir(job.destination)}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
          >
            Reveal in Finder
          </button>
        </div>
      </div>

      <div
        ref={waveformBoxRef}
        onClick={(e) => durationSec > 0 && onSeek(fractionFromEvent(e) * durationSec)}
        onMouseMove={(e) => setHoverFraction(fractionFromEvent(e))}
        onMouseLeave={() => setHoverFraction(null)}
        className="relative mt-2 h-10 rounded-md overflow-hidden bg-charcoal-900/60 cursor-pointer select-none"
      >
        {waveform ? (
          <img src={waveform} alt="" draggable={false} className="w-full h-full object-cover pointer-events-none" />
        ) : waveformFailed ? null : (
          <div className="w-full h-full animate-pulse bg-charcoal-800/50" />
        )}

        {/* Playhead: current playback position */}
        {playing && durationSec > 0 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-signal pointer-events-none"
            style={{ left: `${playedFraction * 100}%` }}
          >
            <span className="absolute -top-0.5 left-1 text-[10px] font-mono text-signal whitespace-nowrap">
              {formatTime(currentTime)}
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
      </div>
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
