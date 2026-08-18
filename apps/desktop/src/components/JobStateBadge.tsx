import type { JobState } from "../types";

const LABELS: Record<JobState, string> = {
  waiting: "Waiting",
  resolving: "Resolving",
  awaiting_confirmation: "Needs review",
  downloading: "Downloading",
  converting: "Converting",
  tagging: "Tagging",
  organizing: "Organizing",
  complete: "Complete",
  paused: "Paused",
  cancelled: "Cancelled",
  failed: "Failed",
};

const STYLES: Record<JobState, string> = {
  waiting: "text-parchment-dim border-charcoal-700",
  resolving: "text-teal border-teal/40",
  awaiting_confirmation: "text-signal border-signal/40",
  downloading: "text-signal border-signal/40",
  converting: "text-signal border-signal/40",
  tagging: "text-signal border-signal/40",
  organizing: "text-signal border-signal/40",
  complete: "text-teal border-teal/40",
  paused: "text-parchment-dim border-charcoal-700",
  cancelled: "text-parchment-dim/60 border-charcoal-700",
  failed: "text-danger border-danger/40",
};

export function JobStateBadge({ state }: { state: JobState }) {
  const isActive = ["resolving", "downloading", "converting", "tagging", "organizing"].includes(state);
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-mono uppercase tracking-wide",
        STYLES[state],
      ].join(" ")}
    >
      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {LABELS[state]}
    </span>
  );
}
