import { useAppStore } from "../store/useAppStore";
import { seratoKeyColor, isHarmonicallyCompatible } from "../lib/keyColors";
import type { KeyColorMode } from "../types";

interface KeyBadgeProps {
  key_: string | null;
  masterKey?: string | null;
}

export function KeyBadge({ key_, masterKey }: KeyBadgeProps) {
  const settings = useAppStore((s) => s.settings);
  const keyColorMode: KeyColorMode = settings?.key_color_mode ?? "none";

  if (!key_) return null;

  let textColor = "rgba(56, 189, 248, 0.7)"; // sky-400/70 default

  if (keyColorMode === "serato") {
    textColor = seratoKeyColor(key_);
  } else if (keyColorMode === "rekordbox" && masterKey) {
    if (isHarmonicallyCompatible(masterKey, key_)) {
      textColor = "#2BEDB2";
    }
  }

  return (
    <span
      className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-charcoal-700/50"
      style={{ color: textColor }}
    >
      {key_}
    </span>
  );
}

export { seratoKeyColor, isHarmonicallyCompatible };
