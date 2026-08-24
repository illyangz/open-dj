import { useAppStore } from "../store/useAppStore";
import { PlayIcon, PauseIcon, PrevIcon, NextIcon } from "./icons";
import { formatTime } from "../lib/format";

/** Persistent transport bar in the left nav column. Shows the current
 * track, prev/play-pause/next, and a thin scrubber. Renders nothing
 * when nothing has ever been played. */
export function PlayerBar() {
  const current = useAppStore((s) => s.player.current);
  const isPlaying = useAppStore((s) => s.player.isPlaying);
  const position = useAppStore((s) => s.player.position);
  const contextQueue = useAppStore((s) => s.player.contextQueue);
  const togglePlay = useAppStore((s) => s.togglePlay);
  const seek = useAppStore((s) => s.seek);
  const next = useAppStore((s) => s.next);
  const prev = useAppStore((s) => s.prev);

  if (!current) return null;

  const duration = current.durationSec ?? 0;
  const fraction = duration > 0 ? Math.min(position / duration, 1) : 0;

  const atStart = contextQueue.findIndex((t) => t.jobId === current.jobId) <= 0;
  const atEnd =
    contextQueue.findIndex((t) => t.jobId === current.jobId) >=
    contextQueue.length - 1;

  function handleScrub(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, x / rect.width));
    seek(frac * duration);
  }

  return (
    <div className="px-3 py-3 border-t border-charcoal-700">
      {/* Track info */}
      <p className="text-xs font-medium truncate text-parchment">
        {current.title ?? "Unknown"}
      </p>
      {current.artist && (
        <p className="text-[10px] truncate text-parchment-dim">{current.artist}</p>
      )}

      {/* Transport controls */}
      <div className="flex items-center justify-center gap-2 mt-2">
        <button
          onClick={prev}
          disabled={atStart}
          className="w-6 h-6 rounded flex items-center justify-center text-parchment-dim hover:text-parchment disabled:opacity-30 transition-colors"
          title="Previous"
        >
          <PrevIcon className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={togglePlay}
          className="w-8 h-8 rounded-full bg-signal text-charcoal-950 flex items-center justify-center hover:bg-signal-dim transition-colors"
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <PauseIcon className="w-4 h-4" />
          ) : (
            <PlayIcon className="w-4 h-4 ml-0.5" />
          )}
        </button>
        <button
          onClick={next}
          disabled={atEnd}
          className="w-6 h-6 rounded flex items-center justify-center text-parchment-dim hover:text-parchment disabled:opacity-30 transition-colors"
          title="Next"
        >
          <NextIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Scrubber */}
      <div className="mt-2">
        <div
          onClick={handleScrub}
          className="h-1 rounded-full bg-charcoal-700 cursor-pointer group relative"
        >
          <div
            className="h-full rounded-full bg-signal transition-[width] duration-100"
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
        <div className="flex justify-between mt-0.5">
          <span className="text-[9px] font-mono text-parchment-dim/60">
            {formatTime(position)}
          </span>
          <span className="text-[9px] font-mono text-parchment-dim/60">
            {formatTime(duration)}
          </span>
        </div>
      </div>
    </div>
  );
}
