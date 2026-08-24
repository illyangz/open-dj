import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore } from "../store/useAppStore";
import type { Job, JobState, ScTrack } from "../types";

// w-10 h-10 artwork (40px) + py-2 (16px) — matches TrackRow's rendered height.
const ROW_HEIGHT = 56;

// Mirrors QueueList's ACTIVE_STATES — only these are genuinely still in
// flight. Everything else (complete, failed, paused, cancelled,
// awaiting_confirmation) is a terminal outcome and must render as one, or a
// track SoundCloud won't fully serve looks identical to one still
// downloading: a "..." button that never changes, forever.
const ACTIVE_JOB_STATES = new Set<JobState>([
  "waiting",
  "resolving",
  "downloading",
  "converting",
  "tagging",
  "organizing",
]);

/** SoundCloud likes extractor — paste a username, fetch their likes, download
 * tracks. Lookup and download state live in the global store (see
 * useAppStore.ts) rather than local useState, so switching to another
 * workspace tab and back doesn't interrupt an in-flight fetch or lose track
 * of what's downloading. */
export function SoundcloudWorkspace() {
  const sc = useAppStore((s) => s.soundcloud);
  const setUsername = useAppStore((s) => s.setSoundcloudUsername);
  const fetchLikes = useAppStore((s) => s.fetchSoundcloudLikes);
  const queueDownload = useAppStore((s) => s.queueSoundcloudDownload);
  const jobs = useAppStore((s) => s.jobs);
  const [search, setSearch] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  const jobsById = useMemo(() => {
    const map = new Map<string, Job>();
    for (const job of jobs) map.set(job.id, job);
    return map;
  }, [jobs]);

  function jobFor(trackId: number): Job | undefined {
    const jobId = sc.queuedJobIds[trackId];
    return jobId ? jobsById.get(jobId) : undefined;
  }

  async function downloadAll() {
    const toDownload = filteredTracks.filter((t) => {
      if (!t.transcode_url) return false;
      const job = jobFor(t.id);
      return !job || job.state === "failed";
    });
    for (const track of toDownload) {
      await queueDownload(track);
    }
  }

  const filteredTracks = search
    ? sc.tracks.filter(
        (t) =>
          t.title.toLowerCase().includes(search.toLowerCase()) ||
          t.artist.toLowerCase().includes(search.toLowerCase()),
      )
    : sc.tracks;

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
              value={sc.username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void fetchLikes();
              }}
              placeholder="soundcloud username..."
              className="flex-1 rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm font-mono focus:border-signal/70 focus:outline-none"
            />
            <button
              onClick={() => void fetchLikes()}
              disabled={!sc.username.trim() || sc.loading}
              className="px-4 py-1.5 rounded-full text-xs font-semibold bg-signal text-charcoal-950 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-signal-dim transition-colors"
            >
              {sc.loading ? "Loading..." : "Fetch Likes"}
            </button>
          </div>
        </div>

        {sc.error && (
          <p className="text-xs text-red-400 mt-2">{sc.error}</p>
        )}

        {sc.tracks.length > 0 && (
          <div className="flex items-center gap-3 mt-3">
            <span className="text-xs text-parchment-dim">
              {filteredTracks.length} of {sc.tracks.length} tracks
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
        {sc.loading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-5 h-5 border-2 border-charcoal-700 border-t-signal rounded-full animate-spin" />
            <span className="ml-3 text-sm text-parchment-dim">Fetching likes...</span>
          </div>
        )}

        {!sc.loading && sc.tracks.length === 0 && !sc.error && (
          <div className="text-center py-12 text-parchment-dim text-sm">
            Enter a SoundCloud username above to fetch their likes.
          </div>
        )}

        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const track = filteredTracks[virtualRow.index];
            const job = jobFor(track.id);
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
                  job={job}
                  onDownload={() => void queueDownload(track)}
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
  job,
  onDownload,
}: {
  track: ScTrack;
  job: Job | undefined;
  onDownload: () => void;
}) {
  const dur = track.duration ? formatDuration(track.duration) : "";
  const downloading = !!job && ACTIVE_JOB_STATES.has(job.state);
  const downloaded = job?.state === "complete";
  // SoundCloud only serves a preview clip for this track (Go+/label-
  // restricted) — neither the direct API nor yt-dlp can get past that, so
  // this is a dead end, not a stuck download. Retrying the same URL would
  // just land here again.
  const unavailable = job?.state === "awaiting_confirmation";
  const failed = !!job && !downloading && !downloaded && !unavailable;

  let label = "MP3";
  if (downloading) label = "...";
  else if (downloaded) label = "Done";
  else if (unavailable) label = "Unavailable";
  else if (failed) label = "Retry";

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

      {/* Actions — kept visible (not hover-only) once a track needs
          attention, so the "Open" link (the way to check SoundCloud itself
          for a purchase/download link, or confirm it's Go+-gated) doesn't
          require the user to guess they should hover a row that will never
          finish downloading. */}
      <div
        className={[
          "flex items-center gap-1 flex-shrink-0 transition-opacity",
          unavailable || failed ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        ].join(" ")}
      >
        <a
          href={track.url}
          target="_blank"
          rel="noopener noreferrer"
          title={unavailable ? "Open on SoundCloud — check if the artist sells or licenses it elsewhere." : undefined}
          className={[
            "text-[10px] px-2 py-1 rounded border transition-colors",
            unavailable
              ? "border-teal/40 text-teal hover:text-parchment hover:border-teal/70"
              : "border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60",
          ].join(" ")}
        >
          Open
        </a>
        {track.transcode_url ? (
          <button
            onClick={onDownload}
            disabled={downloading || downloaded || unavailable}
            title={unavailable ? "SoundCloud only serves a preview of this track (Go+/label-restricted) — full download isn't available here." : undefined}
            className={[
              "text-[10px] px-2 py-1 rounded font-medium transition-colors",
              downloaded
                ? "bg-signal/20 text-signal border border-signal/30"
                : "border border-signal/50 text-signal hover:bg-signal hover:text-charcoal-950",
              downloading && "opacity-50 cursor-wait",
              unavailable && "opacity-40 cursor-not-allowed border-charcoal-700 text-parchment-dim",
              failed && "border-red-400/50 text-red-400",
            ].join(" ")}
          >
            {label}
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
