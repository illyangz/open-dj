import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore } from "../store/useAppStore";
import { JobStateBadge } from "./JobStateBadge";
import type { JobState } from "../types";

const ROW_HEIGHT = 68;

type FilterId = "all" | "active" | "needs_review" | "complete" | "failed" | "paused";

const ACTIVE_STATES: JobState[] = ["waiting", "resolving", "downloading", "converting", "tagging", "organizing"];

const FILTERS: { id: FilterId; label: string; match: (s: JobState) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "active", label: "Active", match: (s) => ACTIVE_STATES.includes(s) },
  { id: "needs_review", label: "Needs Review", match: (s) => s === "awaiting_confirmation" },
  { id: "complete", label: "Complete", match: (s) => s === "complete" },
  { id: "failed", label: "Failed", match: (s) => s === "failed" },
  { id: "paused", label: "Paused/Cancelled", match: (s) => s === "paused" || s === "cancelled" },
];

export function QueueList() {
  const allJobs = useAppStore((s) => s.jobs);
  const selectedJobId = useAppStore((s) => s.selectedJobId);
  const selectJob = useAppStore((s) => s.selectJob);
  const removeJobs = useAppStore((s) => s.removeJobs);
  const parentRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const [clearing, setClearing] = useState(false);

  const activeFilter = FILTERS.find((f) => f.id === filter)!;
  const jobs = useMemo(
    () => (filter === "all" ? allJobs : allJobs.filter((j) => activeFilter.match(j.state))),
    [allJobs, filter, activeFilter],
  );

  const virtualizer = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  if (allJobs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-8">
        <div className="max-w-sm">
          <p className="text-sm text-parchment-dim">
            Nothing queued yet. Paste a link or a search line above, or drop an audio file
            anywhere in this window.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-1.5 px-6 pb-3 flex-wrap">
        {FILTERS.map((f) => {
          const count = f.id === "all" ? allJobs.length : allJobs.filter((j) => f.match(j.state)).length;
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={[
                "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                active
                  ? "bg-signal text-charcoal-950 border-signal"
                  : "border-charcoal-700 text-parchment-dim hover:text-parchment hover:border-teal/60",
              ].join(" ")}
            >
              {f.label} <span className={active ? "opacity-70" : "opacity-50"}>{count}</span>
            </button>
          );
        })}
        {filter !== "all" && jobs.length > 0 && (
          <button
            onClick={async () => {
              setClearing(true);
              try {
                await removeJobs(jobs.map((j) => j.id));
              } finally {
                setClearing(false);
              }
            }}
            disabled={clearing}
            className="px-3 py-1 rounded-full text-xs font-medium border border-danger/40 text-danger/80 hover:bg-danger/10 transition-colors disabled:opacity-40"
          >
            {clearing ? "Clearing…" : `Clear ${activeFilter.label} (${jobs.length})`}
          </button>
        )}
      </div>

      {jobs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-8">
          <p className="text-sm text-parchment-dim">No jobs in "{activeFilter.label}" right now.</p>
        </div>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-y-auto px-6 pb-8">
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const job = jobs[virtualRow.index];
              return (
                <div
                  key={job.id}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="pt-1.5 relative group">
                    <button
                      onClick={() => void removeJobs([job.id])}
                      title="Delete"
                      className="absolute -top-1.5 -right-1.5 z-10 w-5 h-5 rounded-full flex items-center justify-center text-parchment-dim bg-charcoal-700 border border-charcoal-700 hover:text-danger hover:border-danger/50 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ×
                    </button>
                    <button
                      onClick={() => selectJob(job.id)}
                      className={[
                        "w-full text-left rounded-lg border px-4 py-3 transition-colors duration-150",
                        selectedJobId === job.id
                          ? "border-signal/50 bg-charcoal-700/60"
                          : "border-charcoal-700 bg-charcoal-800/40 hover:border-charcoal-700 hover:bg-charcoal-800/70",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {job.title ?? "Resolving…"}
                            {job.artist && (
                              <span className="text-parchment-dim font-normal">
                                {" — "}
                                {job.artist}
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] font-mono text-parchment-dim mt-0.5 truncate">
                            {job.destination ?? job.provider_id ?? "detecting provider"}
                          </p>
                        </div>
                        <JobStateBadge state={job.state} />
                      </div>
                      {["downloading", "converting", "resolving"].includes(job.state) && (
                        <div className="mt-2 h-1 rounded-full bg-charcoal-700 overflow-hidden">
                          <div
                            className="h-full bg-signal transition-[width] duration-200 ease-out"
                            style={{ width: `${Math.round(job.progress * 100)}%` }}
                          />
                        </div>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
