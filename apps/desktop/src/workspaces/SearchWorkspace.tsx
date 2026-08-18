import { useState } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import type { TrackCandidate } from "../types";

const SEARCHABLE_PROVIDERS = [
  { id: "", label: "All searchable providers" },
  { id: "spotify", label: "Spotify" },
  { id: "soundcloud", label: "SoundCloud" },
];

/** FR-050–FR-053: query enabled providers, compare results, and add a
 * multi-select batch to the queue in one action. */
export function SearchWorkspace() {
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState("");
  const [results, setResults] = useState<TrackCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const ingest = useAppStore((s) => s.ingest);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const r = await api.searchProviders(query.trim(), providerId || undefined);
      setResults(r);
      setSelected(new Set());
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelected() {
    const urls = results.filter((r) => selected.has(r.id)).map((r) => r.source_url).filter(Boolean);
    if (urls.length === 0) return;
    await ingest(urls.join("\n"));
    setSelected(new Set());
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6">
      <h1 className="font-display font-semibold text-xl">Search</h1>
      <p className="text-sm text-parchment-dim mt-1 max-w-lg">
        Query providers that expose real search — currently Spotify and SoundCloud metadata.
        Results marked "metadata only" resolve title/artist/link but cannot be downloaded here
        (see the Provider Policy in Settings).
      </p>

      <form onSubmit={runSearch} className="mt-5 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Artist, title, or remix text…"
          className="flex-1 max-w-md rounded-lg bg-charcoal-800/60 border border-charcoal-700 focus:border-signal/70 focus:outline-none px-3 py-2 text-sm"
        />
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          className="rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-2 text-sm"
        >
          {SEARCHABLE_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!query.trim() || loading}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-signal text-charcoal-950 disabled:opacity-30 hover:bg-signal-dim transition-colors"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {selected.size > 0 && (
        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs text-parchment-dim">{selected.size} selected</span>
          <button
            onClick={addSelected}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim transition-colors"
          >
            Add to queue
          </button>
        </div>
      )}

      <ul className="mt-5 space-y-1.5 max-w-2xl">
        {results.map((r) => (
          <li key={`${r.provider}-${r.id}`}>
            <label className="flex items-center gap-3 rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-3 cursor-pointer hover:border-teal/40 transition-colors">
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="accent-signal" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {r.title}
                  {r.artist && <span className="text-parchment-dim font-normal"> — {r.artist}</span>}
                </p>
                <p className="text-[11px] font-mono text-parchment-dim mt-0.5">{r.provider}</p>
              </div>
              <span
                className={[
                  "text-[11px] font-mono uppercase px-2 py-0.5 rounded-full border",
                  r.downloadable ? "text-signal border-signal/40" : "text-teal border-teal/40",
                ].join(" ")}
              >
                {r.downloadable ? "downloadable" : "metadata only"}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {searched && results.length === 0 && !loading && (
        <p className="mt-6 text-sm text-parchment-dim">No results — try a different provider or check its credentials in Settings.</p>
      )}
    </div>
  );
}
