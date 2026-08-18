import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { FileScan, MutationJournal, ReplacementPreview } from "../types";

const AUDIO_FILTER = { name: "Audio", extensions: ["mp3", "flac", "wav", "aiff", "m4a", "ogg"] };

function formatBytes(bitrate: number | null) {
  if (!bitrate) return "—";
  return `${bitrate} kbps`;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** FR-030–FR-038: inspect a local file, preview a proposed replacement,
 * apply it with a verified backup, and restore from history. */
export function RepairWorkspace() {
  const [original, setOriginal] = useState<FileScan | null>(null);
  const [preview, setPreview] = useState<ReplacementPreview | null>(null);
  const [candidatePath, setCandidatePath] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [journal, setJournal] = useState<MutationJournal[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshJournal();
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      void loadOriginal(path);
    };
    window.addEventListener("opendj:repair-file", handler);
    return () => window.removeEventListener("opendj:repair-file", handler);
  }, []);

  async function refreshJournal() {
    setJournal(await api.listMutationJournal());
  }

  async function loadOriginal(path: string) {
    setError(null);
    setPreview(null);
    setCandidatePath(null);
    try {
      setOriginal(await api.scanFile(path));
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseOriginal() {
    const selected = await open({ multiple: false, filters: [AUDIO_FILTER] });
    if (typeof selected === "string") void loadOriginal(selected);
  }

  async function chooseCandidate() {
    if (!original) return;
    const selected = await open({ multiple: false, filters: [AUDIO_FILTER] });
    if (typeof selected !== "string") return;
    setError(null);
    setCandidatePath(selected);
    try {
      setPreview(await api.previewReplacement(original.path, selected));
    } catch (e) {
      setError(String(e));
    }
  }

  async function apply() {
    if (!original || !candidatePath) return;
    setApplying(true);
    setError(null);
    try {
      await api.applyReplacement(original.path, candidatePath);
      await loadOriginal(original.path);
      await refreshJournal();
      setCandidatePath(null);
      setPreview(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }

  async function restore(id: string) {
    await api.restoreMutation(id);
    await refreshJournal();
    if (original) await loadOriginal(original.path);
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6">
      <h1 className="font-display font-semibold text-xl">Repair</h1>
      <p className="text-sm text-parchment-dim mt-1 max-w-lg">
        Every replacement is backed up and verified before the original file is touched, and can
        be restored from history at any time.
      </p>

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      {!original ? (
        <button
          onClick={chooseOriginal}
          className="mt-6 rounded-xl border border-dashed border-charcoal-700 px-6 py-10 text-sm text-parchment-dim hover:border-teal/50 hover:text-parchment transition-colors w-full max-w-xl text-center"
        >
          Choose a local audio file to inspect
        </button>
      ) : (
        <div className="mt-6 max-w-2xl space-y-6">
          <FileCard title="Original" scan={original} />

          {!candidatePath ? (
            <button
              onClick={chooseCandidate}
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-charcoal-700 hover:border-teal/50 transition-colors"
            >
              Choose a replacement file
            </button>
          ) : preview ? (
            <div className="space-y-4">
              <FileCard title="Proposed replacement" scan={preview.candidate} />
              <p className="text-xs font-mono text-parchment-dim">
                Backup will be written to: {preview.backup_directory}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={apply}
                  disabled={applying}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim disabled:opacity-40 transition-colors"
                >
                  {applying ? "Replacing…" : "Back up & replace"}
                </button>
                <button
                  onClick={() => {
                    setCandidatePath(null);
                    setPreview(null);
                  }}
                  className="px-4 py-2 rounded-lg text-sm border border-charcoal-700 text-parchment-dim hover:text-parchment transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <button onClick={() => setOriginal(null)} className="text-xs text-parchment-dim hover:text-parchment">
            ← Choose a different original file
          </button>
        </div>
      )}

      <h2 className="font-display font-semibold text-base mt-10">Restore history</h2>
      {journal.length === 0 ? (
        <p className="text-sm text-parchment-dim mt-2">No replacements yet.</p>
      ) : (
        <ul className="mt-3 max-w-2xl space-y-1.5">
          {journal.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-3 rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-mono truncate">{j.original_path}</p>
                <p className="text-[11px] text-parchment-dim mt-0.5">
                  {new Date(j.created_at).toLocaleString()} · {j.state}
                </p>
              </div>
              {j.state !== "restored_from_backup" && (
                <button
                  onClick={() => restore(j.id)}
                  className="shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border border-charcoal-700 hover:border-teal/50 transition-colors"
                >
                  Restore original
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileCard({ title, scan }: { title: string; scan: FileScan }) {
  return (
    <div className="rounded-xl border border-charcoal-700 bg-charcoal-800/40 p-4">
      <p className="text-[11px] uppercase tracking-wide text-parchment-dim/70">{title}</p>
      <p className="text-sm font-mono mt-1 break-all">{scan.path}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 mt-3 text-sm">
        <Row label="Codec" value={scan.probe.codec} />
        <Row label="Duration" value={formatDuration(scan.probe.duration_ms)} />
        <Row label="Bitrate" value={formatBytes(scan.probe.bitrate_kbps)} />
        <Row label="Sample rate" value={scan.probe.sample_rate_hz ? `${scan.probe.sample_rate_hz} Hz` : "—"} />
        <Row label="Title" value={scan.probe.tags.title ?? "—"} />
        <Row label="Artist" value={scan.probe.tags.artist ?? "—"} />
        <Row label="Artwork" value={scan.probe.artwork_present ? "Present" : "None"} />
        <Row label="Checksum" value={`${scan.checksum.slice(0, 12)}…`} mono />
      </dl>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-parchment-dim">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
}
