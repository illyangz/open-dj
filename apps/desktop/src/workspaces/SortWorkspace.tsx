import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { useTrackAnalysis, type TrackAnalysisState } from "../lib/useTrackAnalysis";
import { useAppStore } from "../store/useAppStore";
import { PlayIcon, PauseIcon } from "../components/icons";
import { ZoomControl } from "../components/ZoomControl";
import type { Job } from "../types";

/** Camelot notation is "<1-12><A|B>" — A is the minor (inner) wheel, B the
 * major (outer) wheel. Adjacent numbers (or same number, other letter) are
 * harmonically compatible, which is why DJs sort/group by this instead of
 * plain alphabetical key name. */
function parseCamelot(key: string | null): { num: number; letter: "A" | "B" } | null {
  if (!key) return null;
  const m = /^(\d{1,2})([AB])$/.exec(key.trim().toUpperCase());
  if (!m) return null;
  const num = Number(m[1]);
  if (num < 1 || num > 12) return null;
  return { num, letter: m[2] as "A" | "B" };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** FR-not-numbered: a DJ-prep view of everything downloaded — grouped by
 * Camelot key then sorted by BPM within each group, so a set can be walked
 * key-by-key without leaving the app, plus export to Rekordbox XML or CSV
 * for anyone who wants to finish prep elsewhere. Inspired by `rbsort` from
 * the baken toolkit, reimplemented natively rather than depending on it. */
export function SortWorkspace() {
  const jobs = useAppStore((s) => s.jobs);
  const zoomPercent = useAppStore((s) => s.zoomPercent);
  const downloads = useMemo(
    () => jobs.filter((j) => j.state === "complete" && j.destination),
    [jobs],
  );

  // Each track's BPM/key/duration is resolved by a hidden worker instance
  // (below) and lifted here by job id — the visible, grouped rows are pure
  // presentation over this map, so grouping/sorting only has to happen in
  // one place instead of re-deriving it inside N hook-bearing rows.
  const [analysisById, setAnalysisById] = useState<Record<string, TrackAnalysisState>>({});

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

  const groups = useMemo(() => {
    const buckets = new Map<string, { job: Job; analysis: TrackAnalysisState }[]>();
    const unsorted: { job: Job; analysis: TrackAnalysisState }[] = [];

    for (const job of downloads) {
      const analysis = analysisById[job.id] ?? { bpm: null, key: null, durationSec: 0, analyzing: true };
      const camelot = parseCamelot(analysis.key);
      if (!camelot) {
        unsorted.push({ job, analysis });
        continue;
      }
      const bucketKey = analysis.key!.toUpperCase();
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      buckets.get(bucketKey)!.push({ job, analysis });
    }

    for (const list of buckets.values()) {
      list.sort((a, b) => (a.analysis.bpm ?? 0) - (b.analysis.bpm ?? 0));
    }
    unsorted.sort((a, b) => (a.job.title ?? "").localeCompare(b.job.title ?? ""));

    const sortedKeys = [...buckets.keys()].sort((a, b) => {
      const pa = parseCamelot(a)!;
      const pb = parseCamelot(b)!;
      return pa.num - pb.num || pa.letter.localeCompare(pb.letter);
    });

    return { sortedKeys, buckets, unsorted };
  }, [downloads, analysisById]);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6" style={{ zoom: `${zoomPercent}%` }}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display font-semibold text-xl">Sort</h1>
          <p className="text-sm text-parchment-dim mt-1 max-w-lg">
            Every download, grouped by Camelot key and sorted by BPM within each group — walk a
            set key-by-key, or export for Rekordbox.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ZoomControl />
          <ExportButtons downloads={downloads} analysisById={analysisById} />
        </div>
      </div>

      {/* Hidden workers: resolve each track's BPM/key/duration and lift it
       * into analysisById. Nothing here renders visibly. */}
      <div className="hidden">
        {downloads.map((job) => (
          <AnalysisWorker key={job.id} job={job} onResolved={(a) => setAnalysisById((s) => ({ ...s, [job.id]: a }))} />
        ))}
      </div>

      {downloads.length === 0 ? (
        <div className="mt-12 text-center text-sm text-parchment-dim">
          Nothing downloaded yet — finished tracks from the Queue show up here once they've
          completed.
        </div>
      ) : (
        <div className="mt-6 w-full max-w-[1600px] space-y-6">
          {groups.sortedKeys.map((key) => (
            <div key={key}>
              <h2 className="text-xs font-mono uppercase tracking-wide text-signal/80 mb-1.5">
                {key} <span className="text-parchment-dim/60">· {groups.buckets.get(key)!.length} track(s)</span>
              </h2>
              <ul className="space-y-1.5">
                {groups.buckets.get(key)!.map(({ job, analysis }) => (
                  <TrackRow
                    key={job.id}
                    job={job}
                    analysis={analysis}
                    playing={playingId === job.id}
                    onTogglePlay={() => togglePlay(job)}
                  />
                ))}
              </ul>
            </div>
          ))}

          {groups.unsorted.length > 0 && (
            <div>
              <h2 className="text-xs font-mono uppercase tracking-wide text-parchment-dim/60 mb-1.5">
                Unsorted <span>· {groups.unsorted.length} track(s)</span>
              </h2>
              <p className="text-[11px] text-parchment-dim/60 mb-1.5">
                No confident key detected — can't be placed on the Camelot wheel yet.
              </p>
              <ul className="space-y-1.5">
                {groups.unsorted.map(({ job, analysis }) => (
                  <TrackRow
                    key={job.id}
                    job={job}
                    analysis={analysis}
                    playing={playingId === job.id}
                    onTogglePlay={() => togglePlay(job)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <audio ref={audioRef} onEnded={() => setPlayingId(null)} className="hidden" />
    </div>
  );
}

function AnalysisWorker({ job, onResolved }: { job: Job; onResolved: (a: TrackAnalysisState) => void }) {
  const analysis = useTrackAnalysis(job.destination);
  // Only fires when the resolved analysis itself changes — not on every
  // parent re-render — which is what keeps this from looping (the parent
  // re-renders in response to onResolved, which would otherwise recreate
  // this callback and re-trigger the effect).
  useEffect(() => {
    onResolved(analysis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);
  return null;
}

function TrackRow({
  job,
  analysis,
  playing,
  onTogglePlay,
}: {
  job: Job;
  analysis: TrackAnalysisState;
  playing: boolean;
  onTogglePlay: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-2 text-sm">
      <button
        onClick={onTogglePlay}
        className="shrink-0 w-7 h-7 rounded-full bg-signal text-charcoal-950 flex items-center justify-center hover:bg-signal-dim transition-colors"
      >
        {playing ? <PauseIcon className="w-3.5 h-3.5" /> : <PlayIcon className="w-3.5 h-3.5 ml-0.5" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="font-medium truncate">
          {job.title ?? job.destination}
          {job.artist && <span className="text-parchment-dim font-normal"> — {job.artist}</span>}
        </p>
      </div>
      {analysis.analyzing && <span className="text-[10px] text-parchment-dim/60 shrink-0">Analyzing…</span>}
      {analysis.bpm && (
        <span className="text-[10px] text-amber/70 bg-amber/10 px-1.5 py-0.5 rounded shrink-0">
          {Math.round(analysis.bpm)} BPM
        </span>
      )}
      <span className="text-[11px] font-mono text-parchment-dim/60 shrink-0 w-10 text-right">
        {formatTime(analysis.durationSec)}
      </span>
    </li>
  );
}

interface ExportRow {
  job: Job;
  analysis: TrackAnalysisState;
}

function ExportButtons({
  downloads,
  analysisById,
}: {
  downloads: Job[];
  analysisById: Record<string, TrackAnalysisState>;
}) {
  const rows: ExportRow[] = downloads.map((job) => ({
    job,
    analysis: analysisById[job.id] ?? { bpm: null, key: null, durationSec: 0, analyzing: true },
  }));

  async function exportCsv() {
    const header = "Title,Artist,BPM,Key,Duration (s),Path";
    const lines = rows.map(({ job, analysis }) =>
      [
        csvField(job.title ?? ""),
        csvField(job.artist ?? ""),
        analysis.bpm ? Math.round(analysis.bpm * 100) / 100 : "",
        csvField(analysis.key ?? ""),
        Math.round(analysis.durationSec),
        csvField(job.destination ?? ""),
      ].join(","),
    );
    const path = await save({ defaultPath: "opendj-sort.csv" });
    if (path) await api.writeTextFile(path, [header, ...lines].join("\n"));
  }

  async function exportRekordboxXml() {
    const xml = buildRekordboxXml(rows);
    const path = await save({ defaultPath: "opendj-rekordbox.xml" });
    if (path) await api.writeTextFile(path, xml);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => void exportCsv()}
        disabled={rows.length === 0}
        className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors disabled:opacity-30"
      >
        Export CSV
      </button>
      <button
        onClick={() => void exportRekordboxXml()}
        disabled={rows.length === 0}
        className="px-3 py-1.5 rounded-full text-xs font-medium bg-signal text-charcoal-950 hover:bg-signal-dim transition-colors disabled:opacity-30"
      >
        Export Rekordbox XML
      </button>
    </div>
  );
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Builds a Rekordbox-importable DJ_PLAYLISTS XML: a COLLECTION of TRACK
 * entries plus one PLAYLISTS node listing them in our sorted (key, then
 * BPM) order. Location uses file:// URIs, which is what Rekordbox expects
 * on import. */
function buildRekordboxXml(rows: ExportRow[]): string {
  const sorted = [...rows].sort((a, b) => {
    const ka = parseCamelot(a.analysis.key);
    const kb = parseCamelot(b.analysis.key);
    if (ka && kb) {
      return ka.num - kb.num || ka.letter.localeCompare(kb.letter) || (a.analysis.bpm ?? 0) - (b.analysis.bpm ?? 0);
    }
    if (ka) return -1;
    if (kb) return 1;
    return (a.job.title ?? "").localeCompare(b.job.title ?? "");
  });

  const tracks = sorted.map(({ job, analysis }, i) => {
    const trackId = i + 1;
    const location = job.destination
      ? "file://" + job.destination.split("/").map(encodeURIComponent).join("/")
      : "";
    const attrs = [
      `TrackID="${trackId}"`,
      `Name="${xmlEscape(job.title ?? "Unknown")}"`,
      `Artist="${xmlEscape(job.artist ?? "")}"`,
      `TotalTime="${Math.round(analysis.durationSec)}"`,
      `Location="${xmlEscape(location)}"`,
      `Kind="MP3 File"`,
      analysis.bpm ? `AverageBpm="${analysis.bpm.toFixed(2)}"` : null,
      analysis.key ? `Tonality="${xmlEscape(analysis.key)}"` : null,
    ].filter(Boolean);
    return `      <TRACK ${attrs.join(" ")}/>`;
  });

  const playlistEntries = sorted.map((_, i) => `        <TRACK Key="${i + 1}"/>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="OpenDJ" Version="0.2.0" Company="OpenDJ"/>',
    `  <COLLECTION Entries="${sorted.length}">`,
    ...tracks,
    "  </COLLECTION>",
    "  <PLAYLISTS>",
    '    <NODE Type="0" Name="ROOT" Count="1">',
    `      <NODE Name="OpenDJ Sort" Type="1" KeyType="0" Entries="${sorted.length}">`,
    ...playlistEntries,
    "      </NODE>",
    "    </NODE>",
    "  </PLAYLISTS>",
    "</DJ_PLAYLISTS>",
    "",
  ].join("\n");
}
