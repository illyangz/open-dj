import { useEffect, useState } from "react";
import { api } from "./api";
import type { BandWaveform, WaveformColorMode } from "../types";

export interface TrackWaveformState {
  bands: BandWaveform | null;
  mono: string | null;
}

const EMPTY: TrackWaveformState = { bands: null, mono: null };

// Dedupe concurrent fetches for the same (path, mode) pair — the row and
// the enlarged modal can both be mounted for the same track at once, and
// both want the same data.
const inFlight = new Map<string, Promise<TrackWaveformState>>();

function fetchWaveform(path: string, mode: WaveformColorMode): Promise<TrackWaveformState> {
  return mode === "classic-blue"
    ? api.generateWaveform(path).then((uri) => ({ bands: null, mono: uri }))
    : api.generateBandWaveform(path).then((bands) => ({ bands, mono: null }));
}

/** Fetches whichever waveform render the active color mode needs — the
 * band-split STFT data for `rgb`/`three-band` (rendered by `GradientWaveform`),
 * or the plain mono PNG for `classic-blue` (rendered by `ClassicWaveform`) —
 * so switching to Classic Blue never pays for the FFT, and RGB/3-Band never
 * pay for the plain render. Shared by the row waveform and the enlarged
 * track-detail view so both surfaces stay in sync with the same fetch logic. */
export function useTrackWaveform(
  path: string | null | undefined,
  mode: WaveformColorMode,
): TrackWaveformState {
  const [state, setState] = useState<TrackWaveformState>(EMPTY);

  useEffect(() => {
    if (!path) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    setState(EMPTY);

    const key = `${path}:${mode}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = fetchWaveform(path, mode);
      pending.finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }

    pending
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [path, mode]);

  return state;
}
