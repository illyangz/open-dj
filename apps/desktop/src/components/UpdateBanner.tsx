import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

type Status = "available" | "downloading" | "installing" | "error";

/** Silently checks for a new release on mount (against the `latest.json`
 * manifest the release workflow publishes to GitHub Releases) and, if one
 * exists, shows a dismissible bar to download + install it in place —
 * no forced restarts, no blocking the app on a check that might be slow
 * or fail (e.g. offline). */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    check()
      .then((found) => {
        if (found) {
          setUpdate(found);
          setStatus("available");
        }
      })
      .catch(() => {});
  }, []);

  if (!update || !status || dismissed) return null;

  const install = async () => {
    setStatus("downloading");
    try {
      await update.downloadAndInstall();
      setStatus("installing");
      await relaunch();
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-charcoal-700 bg-signal/10 px-4 py-2 text-sm shrink-0">
      <span className="text-parchment-dim">
        {status === "error" ? (
          "Update failed to install."
        ) : (
          <>
            <span className="font-semibold text-signal">v{update.version}</span> is available
            {update.body ? ` — ${update.body}` : ""}
          </>
        )}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => setDismissed(true)}
          className="text-[12px] text-parchment-dim hover:text-parchment transition-colors duration-150"
        >
          Later
        </button>
        <button
          onClick={install}
          disabled={status === "downloading" || status === "installing"}
          className="rounded-md bg-signal px-3 py-1 text-[12px] font-semibold text-charcoal-900 hover:bg-signal/90 disabled:opacity-60 transition-colors duration-150"
        >
          {status === "downloading" ? "Downloading…" : status === "installing" ? "Restarting…" : "Update & restart"}
        </button>
      </div>
    </div>
  );
}
