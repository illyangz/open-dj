import { useState } from "react";
import { useAppStore } from "../store/useAppStore";

/** The one place a username gets set or changed — used both as the
 * persistent bottom-left identity chip (`compact`) and as the blocking
 * gate at the top of the Community workspace (not `compact`) when no
 * username is set yet. Both read/write the same `settings.username`
 * through `useAppStore.setUsername`, which (unlike other preferences)
 * pushes to the community backend regardless of the Sync toggle. */
export function UsernameWidget({ compact = false }: { compact?: boolean }) {
  const settings = useAppStore((s) => s.settings);
  const setUsername = useAppStore((s) => s.setUsername);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const username = settings?.username || null;

  async function commit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await setUsername(trimmed);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const showForm = editing || (!compact && !username);

  if (!showForm && compact && !username) {
    return (
      <button
        onClick={() => {
          setValue("");
          setEditing(true);
        }}
        className="w-full rounded-md border border-charcoal-700 px-3 py-1.5 text-[12px] font-medium text-parchment-dim hover:text-signal hover:border-signal/50 transition-colors"
      >
        Set username
      </button>
    );
  }

  if (showForm) {
    return (
      <div className={compact ? "space-y-1.5" : "rounded-lg border border-charcoal-700 bg-charcoal-800/40 p-4 max-w-sm"}>
        {!compact && (
          <p className="text-sm font-medium mb-2">
            Set a username to join the community — share, upvote, and @mention others.
          </p>
        )}
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void commit()}
            placeholder={username ?? "yourname"}
            className="min-w-0 flex-1 rounded-md bg-charcoal-900 border border-charcoal-700 px-2 py-1 text-xs font-mono text-parchment placeholder:text-parchment-dim/60 focus:outline-none focus:border-teal/60"
          />
          <button
            onClick={() => void commit()}
            disabled={saving || !value.trim()}
            className="px-2.5 py-1 rounded-md text-xs font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim disabled:opacity-30 transition-colors"
          >
            {saving ? "…" : "Save"}
          </button>
          {compact && username && (
            <button
              onClick={() => setEditing(false)}
              className="px-1.5 py-1 rounded-md text-xs text-parchment-dim hover:text-parchment"
            >
              ×
            </button>
          )}
        </div>
        {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <button
      onClick={() => {
        setValue(username ?? "");
        setEditing(true);
      }}
      className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-charcoal-800 transition-colors"
      title="Change username"
    >
      <span className="w-6 h-6 rounded-full bg-signal/15 text-signal flex items-center justify-center text-[11px] font-semibold shrink-0">
        {username ? username[0]!.toUpperCase() : "?"}
      </span>
      <span className="min-w-0 text-[12px] font-mono text-parchment-dim truncate">
        @{username}
      </span>
    </button>
  );
}
