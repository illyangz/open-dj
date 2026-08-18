import { useEffect, useLayoutEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import type { WorkspaceId } from "../types";

interface TourStep {
  workspace: WorkspaceId;
  /** data-tour value to spotlight; omit for a centered intro/outro card. */
  tourId?: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    workspace: "queue",
    title: "Welcome to OpenDJ",
    body: "A quick tour of what you can do here. Skip anytime, and retake it later from this same button.",
  },
  {
    workspace: "queue",
    tourId: "ingest-dial",
    title: "Add a track",
    body: "Paste a link — YouTube, Spotify, or SoundCloud — here. OpenDJ downloads it, tags it, and files it into your library automatically.",
  },
  {
    workspace: "queue",
    tourId: "nav-queue",
    title: "Queue",
    body: "Every download lands here. Filter by status, see what's active, and retry or delete jobs that failed.",
  },
  {
    workspace: "soundcloud",
    tourId: "nav-soundcloud",
    title: "SoundCloud",
    body: "Paste any SoundCloud username to pull their entire Likes list into the queue in one go.",
  },
  {
    workspace: "repair",
    tourId: "nav-repair",
    title: "Repair",
    body: "Found a broken or low-quality file? Repair finds a better replacement and swaps it in without losing your tags.",
  },
  {
    workspace: "library",
    tourId: "nav-library",
    title: "Library",
    body: "Your full collection. Play tracks straight from here, see waveforms, and check BPM/key at a glance.",
  },
  {
    workspace: "sort",
    tourId: "nav-sort",
    title: "Sort",
    body: "Groups your whole library by Camelot key and BPM for harmonic mixing, with one-click export to Rekordbox.",
  },
  {
    workspace: "automations",
    tourId: "nav-automations",
    title: "Automations",
    body: "Shows which providers are live today. Scheduled, hands-off imports are on the roadmap.",
  },
  {
    workspace: "settings",
    tourId: "nav-settings",
    title: "Settings",
    body: "Set your download folder, hook up YouTube cookies for more reliable downloads, and tune other preferences.",
  },
  {
    workspace: "settings",
    title: "That's it",
    body: "You're set. Retake this tour anytime from the button at the bottom of the sidebar.",
  },
];

const CARD_WIDTH = 300;
const CARD_HEIGHT_ESTIMATE = 150;
const MARGIN = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function cardPosition(rect: DOMRect): { top: number; left: number } {
  const spaceRight = window.innerWidth - rect.right;
  if (spaceRight > CARD_WIDTH + MARGIN) {
    return {
      top: clamp(rect.top, MARGIN, window.innerHeight - CARD_HEIGHT_ESTIMATE - MARGIN),
      left: rect.right + MARGIN,
    };
  }
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow > CARD_HEIGHT_ESTIMATE + MARGIN) {
    return {
      top: rect.bottom + MARGIN,
      left: clamp(rect.left, MARGIN, window.innerWidth - CARD_WIDTH - MARGIN),
    };
  }
  return {
    top: Math.max(rect.top - CARD_HEIGHT_ESTIMATE - MARGIN, MARGIN),
    left: clamp(rect.left, MARGIN, window.innerWidth - CARD_WIDTH - MARGIN),
  };
}

/** Opt-in walkthrough, launched from the "Take the tour" button in the
 * sidebar — never triggers itself. Walks through each workspace (switching
 * live so the user sees the real screen, not a screenshot) with a spotlight
 * cut into a dimmed backdrop around whatever `data-tour` element the current
 * step names. */
export function Tour() {
  const open = useAppStore((s) => s.tourOpen);
  const setOpen = useAppStore((s) => s.setTourOpen);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);

  // Drive the real workspace so each step shows the actual screen it's
  // talking about, not a static mockup.
  useLayoutEffect(() => {
    if (open) setWorkspace(step.workspace);
  }, [open, step.workspace, setWorkspace]);

  useEffect(() => {
    if (!open || !step.tourId) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.tourId}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    // Two frames: one for the workspace switch above to commit, one for
    // the newly-mounted workspace to actually lay out before we measure.
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(measure);
    });
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf1);
      window.removeEventListener("resize", measure);
    };
  }, [open, stepIndex, step.tourId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowRight" || e.key === "Enter") {
        if (stepIndex === STEPS.length - 1) setOpen(false);
        else setStepIndex(stepIndex + 1);
      } else if (e.key === "ArrowLeft") {
        setStepIndex(Math.max(stepIndex - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, stepIndex]);

  if (!open) return null;

  const position = rect ? cardPosition(rect) : null;

  return (
    <div className="fixed inset-0 z-[9999]">
      {rect ? (
        <div
          className="fixed rounded-lg transition-all duration-200"
          style={{
            top: rect.top - 8,
            left: rect.left - 8,
            width: rect.width + 16,
            height: rect.height + 16,
            boxShadow: "0 0 0 9999px rgba(10, 10, 10, 0.78)",
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-charcoal-900/80" />
      )}

      <div
        className="fixed w-[300px] rounded-lg border border-charcoal-700 bg-charcoal-800 p-4 shadow-xl"
        style={
          position
            ? { top: position.top, left: position.left }
            : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
        }
      >
        <div className="text-[11px] font-mono text-parchment-dim/70">
          {stepIndex + 1} / {STEPS.length}
        </div>
        <h2 className="mt-1 font-display font-semibold text-base text-parchment">{step.title}</h2>
        <p className="mt-1.5 text-sm text-parchment-dim leading-snug">{step.body}</p>

        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={() => setOpen(false)}
            className="text-[12px] text-parchment-dim hover:text-parchment transition-colors duration-150"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                onClick={() => setStepIndex((i) => Math.max(i - 1, 0))}
                className="rounded-md border border-charcoal-700 px-3 py-1.5 text-[12px] font-medium text-parchment-dim hover:text-parchment transition-colors duration-150"
              >
                Back
              </button>
            )}
            <button
              onClick={() => (isLast ? setOpen(false) : setStepIndex((i) => i + 1))}
              className="rounded-md bg-signal px-3 py-1.5 text-[12px] font-semibold text-charcoal-900 hover:bg-signal/90 transition-colors duration-150"
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
