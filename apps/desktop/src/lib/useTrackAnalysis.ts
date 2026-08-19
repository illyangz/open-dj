import { useEffect, useState } from "react";
import { api } from "./api";
import { useAppStore } from "../store/useAppStore";

export interface TrackAnalysisState {
  bpm: number | null;
  key: string | null;
  /** 0-1, only meaningful when `bpm` is set from a fresh analysis (not a
   * pre-existing tag, which has no confidence score). Below ~0.2 treat the
   * badge as a rough guess, not a fact. */
  bpmConfidence: number | null;
  keyConfidence: number | null;
  durationSec: number;
  analyzing: boolean;
}

// Key confidence is only meaningful for stratum-dsp's own guess — when
// libkeyfinder (Mixxx's key-detection engine) is available, the backend
// pins key_confidence to 1.0 for its result, which always clears this bar.
// This only actually filters the stratum-dsp fallback path, used when
// libkeyfinder/its bridge library isn't present on the machine.
const KEY_CONFIDENCE_THRESHOLD = 0.03;
// BPM has no libkeyfinder-equivalent second opinion — it's always
// stratum-dsp. Deliberately NOT gated on confidence for display: measured
// directly against real tracks, its BPM *values* are accurate even when
// its own confidence score is low (a track with a known real tempo of
// ~113 BPM was detected at 113.8 while stratum-dsp itself only reported
// 7% confidence) — the confidence score is just conservative, the number
// is usually still right. Hiding it lost more (a correct value the user
// never saw) than showing an occasional bad one costs.

// Module-level (not per-component) so Library and Sort — which mount their
// own independent hook instances and are never mounted at the same time,
// but get switched between while analysis for on-screen tracks is still
// in flight — share results instead of redoing work. `resolved` remembers
// the outcome for the rest of the session so switching back to a workspace
// doesn't even redo the tag-read; `inFlight` dedupes concurrent requests
// for the same path so a workspace switch mid-analysis can't kick off a
// second, fully redundant `analyze_track` call for a file the other
// workspace is already analyzing.
const resolved = new Map<string, TrackAnalysisState>();
const inFlight = new Map<string, Promise<TrackAnalysisState>>();

async function resolveTrack(path: string): Promise<TrackAnalysisState> {
  const scan = await api.scanFile(path);
  const durationSec = scan.probe.duration_ms / 1000;
  const tagBpm = scan.probe.tags.bpm;
  const tagKey = scan.probe.tags.key;

  // Both already known — instant fast path, no analysis needed.
  if (tagBpm && tagKey) {
    return {
      bpm: tagBpm,
      key: tagKey,
      bpmConfidence: null,
      keyConfidence: null,
      durationSec,
      analyzing: false,
    };
  }

  // At least one is missing — analyze to fill the gap(s). This was the
  // actual bug behind "getting key but no bpm": an old check here was
  // `bpm || key`, so as soon as *either* field got tagged (key, via
  // libkeyfinder) it took the fast path and used the still-null bpm from
  // tags forever, never re-analyzing to fill it in. The backend's
  // analyze_track always persists both fields going forward, so this only
  // has to happen once per file.
  const result = await api.analyzeTrack(path);
  if (useAppStore.getState().settings?.sync_enabled) {
    void api.pushTrackSync(path).catch(() => {});
  }
  return {
    bpm: tagBpm ?? result.bpm,
    key: tagKey ?? (result.key_confidence > KEY_CONFIDENCE_THRESHOLD ? result.key : null),
    bpmConfidence: result.bpm_confidence,
    keyConfidence: result.key_confidence,
    durationSec,
    analyzing: false,
  };
}

/** Resolve BPM/key/duration for a local file: read tags first (instant —
 * covers anything already analyzed or that shipped with a BPM/key tag),
 * and only fall back to actually decoding + analyzing the audio when
 * neither tag is present. A confident result gets written back into the
 * file's own tags by the backend, so this only pays the analysis cost once
 * per file — every other view (Library, Sort, …) that asks for the same
 * path afterward gets the tag-read fast path, and within a session even
 * the tag-read is skipped via the module-level cache above. */
export function useTrackAnalysis(path: string | null | undefined): TrackAnalysisState {
  const [state, setState] = useState<TrackAnalysisState>(() =>
    (path && resolved.get(path)) || {
      bpm: null,
      key: null,
      bpmConfidence: null,
      keyConfidence: null,
      durationSec: 0,
      analyzing: false,
    },
  );

  useEffect(() => {
    if (!path) return;
    let cancelled = false;

    const cached = resolved.get(path);
    if (cached) {
      setState(cached);
      return;
    }

    setState((s) => ({ ...s, analyzing: true }));

    let pending = inFlight.get(path);
    if (!pending) {
      pending = resolveTrack(path).finally(() => inFlight.delete(path));
      inFlight.set(path, pending);
    }

    pending
      .then((result) => {
        resolved.set(path, result);
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, analyzing: false }));
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  return state;
}
