import { useAppStore } from "../store/useAppStore";

const STEP = 10;
const MIN = 70;
const MAX = 150;

/** Shared zoom stepper for the dense list workspaces (Library/Sort/Crates) —
 * backed by one store value so it holds steady across all three rather than
 * resetting per page. Applied by the caller via CSS `zoom`, not by this
 * component itself. */
export function ZoomControl() {
  const zoomPercent = useAppStore((s) => s.zoomPercent);
  const setZoom = useAppStore((s) => s.setZoom);

  return (
    <div className="flex items-center gap-0.5 shrink-0 rounded-full border border-charcoal-700 p-0.5">
      <button
        onClick={() => setZoom(zoomPercent - STEP)}
        disabled={zoomPercent <= MIN}
        className="w-6 h-6 rounded-full text-sm text-parchment-dim hover:text-parchment hover:bg-charcoal-800 disabled:opacity-30 transition-colors"
        title="Zoom out"
      >
        −
      </button>
      <button
        onClick={() => setZoom(100)}
        title="Reset zoom"
        className="px-2 text-[11px] font-mono text-parchment-dim hover:text-parchment tabular-nums"
      >
        {zoomPercent}%
      </button>
      <button
        onClick={() => setZoom(zoomPercent + STEP)}
        disabled={zoomPercent >= MAX}
        className="w-6 h-6 rounded-full text-sm text-parchment-dim hover:text-parchment hover:bg-charcoal-800 disabled:opacity-30 transition-colors"
        title="Zoom in"
      >
        +
      </button>
    </div>
  );
}
