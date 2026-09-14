import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/useAppStore";
import { api } from "../lib/api";
import { DOWNLOAD_FORMATS, type DownloadFormat } from "../types";
import { DropIcon } from "./icons";

function hasSpotifyUrl(text: string): boolean {
  return text.toLowerCase().includes("spotify.com") || text.toLowerCase().startsWith("spotify:");
}

/** FR-001–FR-005, UX Requirements §9: the primary ingest surface. Accepts
 * multiline paste, OS file drag-and-drop, and exposes "Paste", "Search",
 * and "Repair a file" as visible affordances rather than hidden gestures —
 * the exact gap the reference-product audit (recreation-plan.md §2.2)
 * flagged. */
export function IngestDial() {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveAsCrate, setSaveAsCrate] = useState(false);
  const [crateName, setCrateName] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ingest = useAppStore((s) => s.ingest);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const selectedFormat = useAppStore((s) => s.selectedFormat);
  const setSelectedFormat = useAppStore((s) => s.setSelectedFormat);
  const extendedVersions = useAppStore((s) => s.extendedVersions);
  const setExtendedVersions = useAppStore((s) => s.setExtendedVersions);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setDragging(true);
      } else if (event.payload.type === "drop") {
        setDragging(false);
        const paths = event.payload.paths;
        if (paths.length > 0) void handleDrop(paths);
      } else {
        setDragging(false);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await ingest(trimmed, saveAsCrate ? crateName : undefined);
      setText("");
    } finally {
      setSubmitting(false);
    }
  }

  function nameFromPath(path: string): string {
    return path.split(/[\\/]/).pop()?.replace(/\.txt$/i, "") ?? "";
  }

  async function handleDrop(paths: string[]) {
    const txtPaths = paths.filter((p) => p.toLowerCase().endsWith(".txt"));
    const otherPaths = paths.filter((p) => !p.toLowerCase().endsWith(".txt"));
    if (txtPaths.length > 0) {
      const parts = await Promise.all(
        txtPaths.map(async (p) => {
          try {
            return (await api.readPlaylistFile(p)).trim();
          } catch {
            return "";
          }
        }),
      );
      const loaded = parts.filter(Boolean).join("\n");
      if (loaded) {
        setText((prev) => (prev ? `${prev}\n${loaded}` : loaded));
        setSaveAsCrate(true);
        setCrateName((prev) => prev || nameFromPath(txtPaths[0]));
      }
    }
    if (otherPaths.length > 0) void submit(otherPaths.join("\n"));
  }

  async function handleLoadPlaylist() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Playlist (.txt)", extensions: ["txt"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const content = await api.readPlaylistFile(selected);
      if (content.trim()) {
        setText((prev) => (prev ? `${prev}\n${content.trim()}` : content.trim()));
        setSaveAsCrate(true);
        setCrateName(nameFromPath(selected));
      }
    } catch (e: unknown) {
      console.error("Failed to load playlist:", e);
    }
  }

  async function handleRepairFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["mp3", "flac", "wav", "aiff", "m4a", "ogg"] }],
    });
    if (typeof selected === "string") {
      window.dispatchEvent(new CustomEvent("opendj:repair-file", { detail: selected }));
      setWorkspace("repair");
    }
  }

  return (
    <div
      className={[
        "relative rounded-[28px] border p-8 transition-colors duration-150",
        dragging ? "border-signal bg-charcoal-700/60" : "border-charcoal-700 bg-charcoal-800/50",
      ].join(" ")}
    >
      <div className="flex flex-col items-center text-center gap-4">
        <div
          className={[
            "w-14 h-14 rounded-full border-2 flex items-center justify-center",
            submitting ? "border-signal animate-pulse" : "border-signal/70",
          ].join(" ")}
        >
          <DropIcon className="w-6 h-6 text-signal" />
        </div>

        <div>
          <h2 className="font-display font-semibold text-xl">Drop a track. Keep control.</h2>
          <p className="text-sm text-parchment-dim mt-1 max-w-md">
            Paste links or search text below, or drop .txt playlists and audio files anywhere in this window.
          </p>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit(text);
            }
          }}
          placeholder="YouTube, Spotify, SoundCloud... paste links or song names (one per line)"
          rows={3}
          className="w-full max-w-xl resize-none rounded-xl bg-charcoal-900/70 border border-charcoal-700 focus:border-signal/70 focus:outline-none px-4 py-3 text-sm font-mono placeholder:text-parchment-dim/50"
        />

        {hasSpotifyUrl(text) && (
          <p className="text-xs text-amber/80 max-w-xl">
            Spotify links: audio will be sourced from YouTube — quality varies by track availability.
          </p>
        )}

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-parchment-dim">Format:</label>
            <select
              value={selectedFormat}
              onChange={(e) => setSelectedFormat(e.target.value as DownloadFormat)}
              className="bg-charcoal-900 border border-charcoal-700 rounded-md px-2 py-1 text-xs text-parchment focus:outline-none focus:border-teal/60"
            >
              {DOWNLOAD_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-parchment-dim cursor-pointer select-none">
            <input
              type="checkbox"
              checked={extendedVersions}
              onChange={(e) => setExtendedVersions(e.target.checked)}
              className="accent-teal"
            />
            Extended versions
          </label>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-parchment-dim cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveAsCrate}
              onChange={(e) => setSaveAsCrate(e.target.checked)}
              className="accent-teal"
            />
            Save as crate
          </label>
          <input
            value={crateName}
            onChange={(e) => setCrateName(e.target.value)}
            disabled={!saveAsCrate}
            placeholder="Crate name"
            className="bg-charcoal-900 border border-charcoal-700 rounded-md px-2 py-1 text-xs text-parchment focus:outline-none focus:border-teal/60 disabled:opacity-40 placeholder:text-parchment-dim/50 w-44"
          />
          <span className="text-[10px] text-parchment-dim/70">
            each finished download is added to the crate
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleLoadPlaylist}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
          >
            Load .txt
          </button>
          <button
            onClick={() => textareaRef.current?.focus()}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
          >
            Paste
          </button>
          <button
            onClick={() => setWorkspace("soundcloud")}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
          >
            SoundCloud
          </button>
          <button
            onClick={handleRepairFile}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
          >
            Repair a file
          </button>
          <button
            onClick={() => void submit(text)}
            disabled={!text.trim() || submitting}
            className="px-4 py-1.5 rounded-full text-xs font-semibold bg-signal text-charcoal-950 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-signal-dim transition-colors"
          >
            Add to queue
          </button>
        </div>
      </div>
    </div>
  );
}
