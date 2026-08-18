import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../lib/api";
import type { ScTrack } from "../types";

// Cache the last lookup (username + results) across reloads/restarts so
// reopening this tab doesn't force a re-fetch of a likes list that can run
// into the hundreds of tracks. This is a convenience cache, not a database —
// a new successful search just overwrites it.
const CACHE_KEY = "opendj:soundcloud:last-lookup";

interface CachedLookup {
  username: string;
  tracks: ScTrack[];
}

function loadCache(): CachedLookup | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedLookup) : null;
  } catch {
    return null;
  }
}

function saveCache(entry: CachedLookup) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage full/unavailable — caching is a convenience, not required.
  }
}

// w-10 h-10 artwork (40px) + py-2 (16px) — matches TrackRow's rendered height.
const ROW_HEIGHT = 56;

/** SoundCloud likes extractor — paste a username, fetch their likes, download tracks. */
export function SoundcloudWorkspace() {
  const cached = useMemo(loadCache, []);
  const [username, setUsername] = useState(cached?.username ?? "");
  const [tracks, setTracks] = useState<ScTrack[]>(cached?.tracks ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Record<number, boolean>>({});
  const [downloaded, setDownloaded] = useState<Record<number, boolean>>({});
  const [search, setSearch] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  async function fetchLikes() {
    const u = username.trim().replace(/^@/, "");
    if (!u) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.fetchSoundcloudLikes(u);
      setTracks(result);
      saveCache({ username: u, tracks: result });
    } catch (e: any) {
      setError(e?.toString() || "Failed to fetch likes");
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }

  async function downloadTrack(track: ScTrack) {
    setDownloading((d) => ({ ...d, [track.id]: true }));
    try {
      await api.downloadSoundcloudTrack(track);
      setDownloaded((d) => ({ ...d, [track.id]: true }));
    } catch (e: any) {
      setError(`Failed to download "${track.title}": ${e?.toString() || "unknown error"}`);
    } finally {
      setDownloading((d) => ({ ...d, [track.id]: false }));
    }
  }

  async function downloadAll() {
    const toDownload = filteredTracks.filter((t) => t.transcode_url && !downloaded[t.id]);
    for (const track of toDownload) {
      await downloadTrack(track);
    }
  }

  const filteredTracks = search
    ? tracks.filter(
        (t) =>
          t.title.toLowerCase().includes(search.toLowerCase()) ||
          t.artist.toLowerCase().includes(search.toLowerCase()),
      )
    : tracks;

  // Likes lists can run into the hundreds/thousands of tracks — virtualize
  // so only the rows actually on screen get mounted, same approach as the
  // main queue list.
  const virtualizer = useVirtualizer({
    count: filteredTracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-charcoal-700">
        <h1 className="font-display font-semibold text-lg mb-3">SoundCloud Likes</h1>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-sm text-parchment-dim">@</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void fetchLikes();
              }}
              placeholder="soundcloud username..."
              className="flex-1 rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm font-mono focus:border-signal/70 focus:outline-none"
            />
            <button
              onClick={() => void fetchLikes()}
              disabled={!username.trim() || loading}
              className="px-4 py-1.5 rounded-full text-xs font-semibold bg-signal text-charcoal-950 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-signal-dim transition-colors"
            >
              {loading ? "Loading..." : "Fetch Likes"}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 mt-2">{error}</p>
        )}

        {tracks.length > 0 && (
          <div className="flex items-center gap-3 mt-3">
            <span className="text-xs text-parchment-dim">
              {filteredTracks.length} of {tracks.length} tracks
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1 text-xs font-mono w-48 focus:border-signal/70 focus:outline-none"
            />
            <button
              onClick={() => void downloadAll()}
              className="px-3 py-1 rounded-full text-xs font-medium border border-signal text-signal hover:bg-signal hover:text-charcoal-950 transition-colors"
            >
              Download All MP3
            </button>
          </div>
        )}
      </div>

      {/* Track list */}
      <div ref={parentRef} className="flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-5 h-5 border-2 border-charcoal-700 border-t-signal rounded-full animate-spin" />
            <span className="ml-3 text-sm text-parchment-dim">Fetching likes...</span>
          </div>
        )}

        {!loading && tracks.length === 0 && !error && (
          <div className="text-center py-12 text-parchment-dim text-sm">
            Enter a SoundCloud username above to fetch their likes.
          </div>
        )}

        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const track = filteredTracks[virtualRow.index];
            return (
              <div
                key={track.id}
                className="absolute top-0 left-0 w-full"
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <TrackRow
                  track={track}
                  downloading={!!downloading[track.id]}
                  downloaded={!!downloaded[track.id]}
                  onDownload={() => void downloadTrack(track)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TrackRow({
  track,
  downloading,
  downloaded,
  onDownload,
}: {
  track: ScTrack;
  downloading: boolean;
  downloaded: boolean;
  onDownload: () => void;
}) {
  const dur = track.duration ? formatDuration(track.duration) : "";

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-charcoal-800/40 transition-colors group">
      {/* Artwork */}
      {track.artwork ? (
        <img
          src={track.artwork}
          alt=""
          className="w-10 h-10 rounded object-cover bg-charcoal-800 flex-shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded bg-charcoal-800 flex items-center justify-center text-parchment-dim/50 flex-shrink-0">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{track.title}</div>
        <div className="text-xs text-parchment-dim truncate">{track.artist}</div>
      </div>

      {/* Meta tags */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {track.bpm && (
          <span className="text-[10px] text-amber/70 bg-amber/10 px-1.5 py-0.5 rounded">
            {Math.round(track.bpm)} BPM
          </span>
        )}
        {track.key && (
          <span className="text-[10px] text-sky-400/70 bg-sky-400/10 px-1.5 py-0.5 rounded">
            {track.key}
          </span>
        )}
        {track.genre && (
          <span className="text-[10px] text-parchment-dim/60 bg-charcoal-700 px-1.5 py-0.5 rounded hidden sm:inline">
            {track.genre}
          </span>
        )}
      </div>

      {/* Duration */}
      <span className="text-xs text-parchment-dim/60 w-12 text-right flex-shrink-0">{dur}</span>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <a
          href={track.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] px-2 py-1 rounded border border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60 transition-colors"
        >
          Open
        </a>
        {track.transcode_url ? (
          <button
            onClick={onDownload}
            disabled={downloading || downloaded}
            className={[
              "text-[10px] px-2 py-1 rounded font-medium transition-colors",
              downloaded
                ? "bg-signal/20 text-signal border border-signal/30"
                : "border border-signal/50 text-signal hover:bg-signal hover:text-charcoal-950",
              downloading && "opacity-50 cursor-wait",
            ].join(" ")}
          >
            {downloading ? "..." : downloaded ? "Done" : "MP3"}
          </button>
        ) : (
          <span className="text-[10px] text-parchment-dim/30 px-2 py-1">No DL</span>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}
