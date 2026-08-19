import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import { useTrackAnalysis } from "../lib/useTrackAnalysis";
import { ZoomControl } from "../components/ZoomControl";
import type { Crate, CuePoint, Job } from "../types";

/** Same fixed 8-color palette Library's hot cue pads use — kept in sync
 * so a cue exported without its own stored color (shouldn't happen, but
 * defensive) still lands on the same color a user would see in-app. */
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

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** FR-not-numbered: named, ordered track lists ("crates" in DJ terminology)
 * that can be exported to Rekordbox (XML, including hot cues as
 * POSITION_MARK entries) or Serato (a native .crate file per crate).
 * Deliberately does NOT attempt to write cue points into the track's own
 * Serato tag (the "Serato Markers2" GEOB frame) — that's a reverse-
 * engineered binary format, and getting it wrong risks corrupting a tag on
 * the user's actual audio file. Crate export is safe because it only ever
 * writes a new sidecar file, never touches the track itself. */
export function CratesWorkspace() {
  const jobs = useAppStore((s) => s.jobs);
  const zoomPercent = useAppStore((s) => s.zoomPercent);
  const jobByPath = useMemo(() => {
    const map = new Map<string, Job>();
    for (const j of jobs) if (j.destination) map.set(j.destination, j);
    return map;
  }, [jobs]);

  const [crates, setCrates] = useState<Crate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trackPaths, setTrackPaths] = useState<string[]>([]);
  const [newCrateName, setNewCrateName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    api.listCrates().then((result) => {
      setCrates(result);
      if (result.length > 0 && !selectedId) setSelectedId(result[0].id);
    });
    // Only run once on mount — selection changes are handled by the effect
    // below, and re-running this on every `selectedId` change would fight
    // that effect over who owns fetching the track list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setTrackPaths([]);
      return;
    }
    api.listCrateTracks(selectedId).then(setTrackPaths);
  }, [selectedId]);

  const selected = crates.find((c) => c.id === selectedId) ?? null;

  async function createCrate() {
    const name = newCrateName.trim();
    if (!name) return;
    const created = await api.createCrate(name);
    setCrates((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
    setSelectedId(created.id);
    setNewCrateName("");
  }

  async function deleteCrate(id: string) {
    await api.deleteCrate(id);
    setCrates((prev) => prev.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function commitRename() {
    if (!selected) return;
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === selected.name) return;
    const updated = await api.renameCrate(selected.id, name);
    setCrates((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  async function removeTrack(path: string) {
    if (!selectedId) return;
    await api.removeTrackFromCrate(selectedId, path);
    setTrackPaths((prev) => prev.filter((p) => p !== path));
  }

  async function move(index: number, direction: -1 | 1) {
    if (!selectedId) return;
    const next = [...trackPaths];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setTrackPaths(next);
    await api.reorderCrateTracks(selectedId, next);
  }

  async function exportRekordboxXml() {
    if (!selected) return;
    const xml = await buildRekordboxXml(selected.name, trackPaths, jobByPath);
    const path = await save({ defaultPath: `${selected.name}.xml` });
    if (path) await api.writeTextFile(path, xml);
  }

  async function exportSeratoCrate() {
    if (!selected) return;
    const bytes = buildSeratoCrate(trackPaths);
    const path = await save({ defaultPath: `${selected.name}.crate` });
    if (path) await api.writeBinaryFile(path, bytes);
  }

  return (
    <div className="flex-1 min-w-0 flex">
      <div className="w-64 shrink-0 border-r border-charcoal-700 flex flex-col">
        <div className="p-4">
          <h1 className="font-display font-semibold text-lg">Crates</h1>
          <p className="text-xs text-parchment-dim mt-1">
            Ordered track lists, exportable to Rekordbox or Serato.
          </p>
        </div>
        <div className="px-4 pb-3 flex gap-1.5">
          <input
            value={newCrateName}
            onChange={(e) => setNewCrateName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createCrate()}
            placeholder="New crate…"
            className="flex-1 min-w-0 bg-charcoal-900 border border-charcoal-700 rounded-md px-2.5 py-1.5 text-xs text-parchment placeholder:text-parchment-dim/60 focus:outline-none focus:border-teal/60"
          />
          <button
            onClick={() => void createCrate()}
            disabled={!newCrateName.trim()}
            className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-signal text-charcoal-950 hover:bg-signal-dim transition-colors disabled:opacity-30"
          >
            Add
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {crates.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setSelectedId(c.id)}
                className={[
                  "w-full text-left rounded-md px-3 py-2 text-sm truncate transition-colors",
                  selectedId === c.id
                    ? "bg-charcoal-700 text-signal"
                    : "text-parchment-dim hover:text-parchment hover:bg-charcoal-800",
                ].join(" ")}
              >
                {c.name}
              </button>
            </li>
          ))}
          {crates.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-parchment-dim/60">
              No crates yet — add one above, or drop tracks in from Library.
            </li>
          )}
        </ul>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto p-6" style={{ zoom: `${zoomPercent}%` }}>
        {!selected ? (
          <p className="text-sm text-parchment-dim">Select or create a crate to get started.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              {renaming ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => e.key === "Enter" && void commitRename()}
                  className="font-display font-semibold text-xl bg-transparent border-b border-teal/60 focus:outline-none"
                />
              ) : (
                <h1
                  onClick={() => {
                    setRenameValue(selected.name);
                    setRenaming(true);
                  }}
                  className="font-display font-semibold text-xl cursor-text"
                  title="Click to rename"
                >
                  {selected.name}
                </h1>
              )}
              <div className="flex items-center gap-2 shrink-0">
                <ZoomControl />
                <button
                  onClick={() => void exportSeratoCrate()}
                  disabled={trackPaths.length === 0}
                  className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors disabled:opacity-30"
                >
                  Export Serato Crate
                </button>
                <button
                  onClick={() => void exportRekordboxXml()}
                  disabled={trackPaths.length === 0}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-signal text-charcoal-950 hover:bg-signal-dim transition-colors disabled:opacity-30"
                >
                  Export Rekordbox XML
                </button>
                <button
                  onClick={() => void deleteCrate(selected.id)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-red-400/80 hover:text-red-400 hover:border-red-400/60 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>

            <ul className="mt-4 w-full max-w-[1600px] space-y-1.5">
              {trackPaths.map((path, i) => (
                <CrateTrackRow
                  key={path}
                  path={path}
                  job={jobByPath.get(path)}
                  onMoveUp={i > 0 ? () => void move(i, -1) : undefined}
                  onMoveDown={i < trackPaths.length - 1 ? () => void move(i, 1) : undefined}
                  onRemove={() => void removeTrack(path)}
                />
              ))}
              {trackPaths.length === 0 && (
                <li className="text-sm text-parchment-dim py-6 text-center">
                  Empty — add tracks from the Library tab's "+ Crate" button.
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function CrateTrackRow({
  path,
  job,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  path: string;
  job: Job | undefined;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
  onRemove: () => void;
}) {
  const { bpm, key } = useTrackAnalysis(path);
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">
          {job?.title ?? path}
          {job?.artist && <span className="text-parchment-dim font-normal"> — {job.artist}</span>}
        </p>
        <p className="text-[11px] font-mono text-parchment-dim truncate">{path}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {bpm && (
          <span className="text-[10px] text-amber/70 bg-amber/10 px-1.5 py-0.5 rounded">
            {Math.round(bpm)} BPM
          </span>
        )}
        {key && (
          <span className="text-[10px] text-sky-400/70 bg-sky-400/10 px-1.5 py-0.5 rounded">{key}</span>
        )}
        <button
          onClick={onMoveUp}
          disabled={!onMoveUp}
          className="w-6 h-6 rounded flex items-center justify-center text-parchment-dim hover:text-parchment hover:bg-charcoal-700 disabled:opacity-20 transition-colors"
          title="Move up"
        >
          ↑
        </button>
        <button
          onClick={onMoveDown}
          disabled={!onMoveDown}
          className="w-6 h-6 rounded flex items-center justify-center text-parchment-dim hover:text-parchment hover:bg-charcoal-700 disabled:opacity-20 transition-colors"
          title="Move down"
        >
          ↓
        </button>
        <button
          onClick={onRemove}
          className="w-6 h-6 rounded flex items-center justify-center text-parchment-dim hover:text-red-400 hover:bg-charcoal-700 transition-colors"
          title="Remove from crate"
        >
          ×
        </button>
      </div>
    </li>
  );
}

/** Builds a Rekordbox-importable DJ_PLAYLISTS XML for one crate: a
 * COLLECTION of TRACK entries (each carrying its hot cues as POSITION_MARK
 * children, Type="0" = hot cue, Num = pad slot) plus one PLAYLISTS node
 * listing them in the crate's own order. */
async function buildRekordboxXml(
  crateName: string,
  trackPaths: string[],
  jobByPath: Map<string, Job>,
): Promise<string> {
  const cuesByPath = new Map<string, CuePoint[]>(
    await Promise.all(
      trackPaths.map(async (path) => [path, await api.listCuePoints(path)] as [string, CuePoint[]]),
    ),
  );

  const tracks = trackPaths.map((path, i) => {
    const trackId = i + 1;
    const job = jobByPath.get(path);
    const location = "file://" + path.split("/").map(encodeURIComponent).join("/");
    const attrs = [
      `TrackID="${trackId}"`,
      `Name="${xmlEscape(job?.title ?? path.split("/").pop() ?? path)}"`,
      `Artist="${xmlEscape(job?.artist ?? "")}"`,
      `Location="${xmlEscape(location)}"`,
      `Kind="MP3 File"`,
    ].join(" ");

    const cues = cuesByPath.get(path) ?? [];
    if (cues.length === 0) {
      return `      <TRACK ${attrs}/>`;
    }
    const marks = cues
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((cue) => {
        const { r, g, b } = hexToRgb(cue.color ?? CUE_COLORS[cue.slot]);
        const startSec = (cue.position_ms / 1000).toFixed(3);
        const name = cue.label ? ` Name="${xmlEscape(cue.label)}"` : "";
        return `        <POSITION_MARK${name} Type="0" Start="${startSec}" Num="${cue.slot}" Red="${r}" Green="${g}" Blue="${b}"/>`;
      })
      .join("\n");
    return `      <TRACK ${attrs}>\n${marks}\n      </TRACK>`;
  });

  const playlistEntries = trackPaths.map((_, i) => `        <TRACK Key="${i + 1}"/>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="OpenDJ" Version="0.2.0" Company="OpenDJ"/>',
    `  <COLLECTION Entries="${trackPaths.length}">`,
    ...tracks,
    "  </COLLECTION>",
    "  <PLAYLISTS>",
    '    <NODE Type="0" Name="ROOT" Count="1">',
    `      <NODE Name="${xmlEscape(crateName)}" Type="1" KeyType="0" Entries="${trackPaths.length}">`,
    ...playlistEntries,
    "      </NODE>",
    "    </NODE>",
    "  </PLAYLISTS>",
    "</DJ_PLAYLISTS>",
    "",
  ].join("\n");
}

/** Builds a native Serato `.crate` file: a sequence of tag-length-value
 * (TLV) records, big-endian, as documented by the community (Serato has
 * never published this format officially, but it's simple and has been
 * cross-checked against real crate files by several independent open-
 * source projects). Structure:
 *   - "vrsn" tag: a UTF-16BE version string (required first record)
 *   - one "otrk" tag per track, itself containing a nested "ptrk" tag
 *     whose value is the track's path as UTF-16BE
 * This only ever produces a new file — it never touches the user's
 * audio files, so a mistake here can't corrupt anything they own. */
function buildSeratoCrate(trackPaths: string[]): Uint8Array {
  const chunks: Uint8Array[] = [];

  function utf16be(s: string): Uint8Array {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      out[i * 2] = (code >> 8) & 0xff;
      out[i * 2 + 1] = code & 0xff;
    }
    return out;
  }

  function tlv(tag: string, value: Uint8Array): Uint8Array {
    const tagBytes = new TextEncoder().encode(tag);
    const out = new Uint8Array(4 + 4 + value.length);
    out.set(tagBytes, 0);
    const len = value.length;
    out[4] = (len >>> 24) & 0xff;
    out[5] = (len >>> 16) & 0xff;
    out[6] = (len >>> 8) & 0xff;
    out[7] = len & 0xff;
    out.set(value, 8);
    return out;
  }

  chunks.push(tlv("vrsn", utf16be("1.0/Serato ScratchLive Crate")));

  for (const path of trackPaths) {
    // Serato crate track paths are relative to the user's music root and
    // use forward slashes without a leading slash; we don't know their
    // configured root, so store the absolute path with the leading
    // slash stripped — Serato treats an unresolvable relative path as
    // "missing," same as it would for a track moved outside its library,
    // so this degrades to "re-locate the track" rather than failing to
    // import the crate at all.
    const relative = path.startsWith("/") ? path.slice(1) : path;
    const ptrk = tlv("ptrk", utf16be(relative));
    chunks.push(tlv("otrk", ptrk));
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
