import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/useAppStore";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import type { SuggestedMatch } from "../types";
import { JobStateBadge } from "./JobStateBadge";

/** FR-011/FR-012: per-item state, provider, format, progress, destination,
 * and error reason — plus the actions valid for the current state. */
export function Inspector() {
  const jobs = useAppStore((s) => s.jobs);
  const selectedJobId = useAppStore((s) => s.selectedJobId);
  const selectJob = useAppStore((s) => s.selectJob);
  const refreshJobs = useAppStore((s) => s.refreshJobs);
  const removeJobs = useAppStore((s) => s.removeJobs);
  const job = jobs.find((j) => j.id === selectedJobId);

  if (!job) {
    return (
      <aside className="w-[320px] shrink-0 border-l border-charcoal-700 p-6">
        <p className="text-sm text-parchment-dim">Select a queue item to inspect it.</p>
      </aside>
    );
  }

  async function run(action: () => Promise<unknown>) {
    await action();
    await refreshJobs();
  }

  return (
    <aside className="w-[320px] shrink-0 border-l border-charcoal-700 flex flex-col">
      <div className="p-6 border-b border-charcoal-700">
        <button onClick={() => selectJob(null)} className="text-[11px] text-parchment-dim hover:text-parchment mb-3">
          ← Close
        </button>
        <h3 className="font-display font-semibold text-base leading-snug">{job.title ?? "Resolving…"}</h3>
        {job.artist && <p className="text-sm text-parchment-dim">{job.artist}</p>}
        <div className="mt-3">
          <JobStateBadge state={job.state} />
        </div>
      </div>

      <dl className="p-6 space-y-3 text-sm">
        <Row label="Provider" value={job.provider_id ?? "—"} />
        <Row label="Destination" value={job.destination ?? "—"} mono />
        <Row label="Progress" value={`${Math.round(job.progress * 100)}%`} />
        {job.error_class === "needs_review" ? (
          <Row label="Needs review" value={job.error_message ?? ""} />
        ) : job.error_class === "no_accurate_match" ? (
          <Row label="No accurate file found" value={job.error_message ?? ""} danger />
        ) : (
          job.error_class && <Row label="Error" value={`${job.error_class}: ${job.error_message ?? ""}`} danger />
        )}
        {job.state === "awaiting_confirmation" && job.suggested_match && (
          <SuggestedMatchCard match={job.suggested_match} />
        )}
        <Row label="Created" value={new Date(job.created_at).toLocaleString()} />
      </dl>

      <div className="mt-auto p-6 border-t border-charcoal-700 flex flex-wrap gap-2">
        {canPause(job.state) && (
          <ActionButton label="Pause" onClick={() => run(() => api.pauseJob(job.id))} />
        )}
        {job.state === "paused" && (
          <ActionButton label="Resume" onClick={() => run(() => api.resumeJob(job.id))} />
        )}
        {canCancel(job.state) && (
          <ActionButton label="Cancel" onClick={() => run(() => api.cancelJob(job.id))} />
        )}
        {job.state === "awaiting_confirmation" && job.suggested_match && (
          <>
            <ActionButton label="Approve & download" primary onClick={() => run(() => api.approveMatch(job.id))} />
            <ActionButton label="Search again" onClick={() => run(() => api.retryJob(job.id))} />
          </>
        )}
        {(job.state === "failed" || job.state === "cancelled") && (
          <ActionButton label="Retry" primary onClick={() => run(() => api.retryJob(job.id))} />
        )}
        <ActionButton
          label="Delete"
          onClick={() => {
            selectJob(null);
            void removeJobs([job.id]);
          }}
        />
      </div>
    </aside>
  );
}

/** The upload search wasn't sure about — enough to judge it at a glance,
 * plus a link to listen before approving. */
function SuggestedMatchCard({ match }: { match: SuggestedMatch }) {
  const platform = match.platform === "soundcloud" ? "SoundCloud" : "YouTube";
  return (
    <div className="rounded-lg border border-signal/40 p-3 space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-parchment-dim/70">
        Suggested match · {Math.round(match.score * 100)}%
      </div>
      <div className="text-sm break-words">{match.upload_title}</div>
      <div className="text-xs text-parchment-dim">
        {[match.uploader, platform, match.duration_ms != null ? formatTime(match.duration_ms / 1000) : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
      <button
        onClick={() => void openUrl(match.source_url)}
        className="text-xs text-teal hover:underline"
      >
        Open on {platform} ↗
      </button>
    </div>
  );
}

function canPause(state: string) {
  return ["waiting", "resolving", "downloading", "converting"].includes(state);
}
function canCancel(state: string) {
  return !["complete", "cancelled"].includes(state);
}

function Row({ label, value, mono, danger }: { label: string; value: string; mono?: boolean; danger?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-parchment-dim/70">{label}</dt>
      <dd className={["mt-0.5 break-words", mono ? "font-mono text-xs" : "", danger ? "text-danger" : ""].join(" ")}>
        {value}
      </dd>
    </div>
  );
}

function ActionButton({ label, onClick, primary }: { label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-full text-xs font-semibold transition-colors",
        primary ? "bg-signal text-charcoal-950 hover:bg-signal-dim" : "border border-charcoal-700 text-parchment-dim hover:text-parchment",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
