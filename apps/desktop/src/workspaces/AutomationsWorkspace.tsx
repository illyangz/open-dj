import { useAppStore } from "../store/useAppStore";

const POLICY_LABEL: Record<string, string> = {
  permitted: "Permitted",
  metadata_only: "Metadata only",
  not_configured: "Not configured",
};

/** FR-006 workspace: "manage opt-in metadata imports and future
 * integrations." There are no scheduled automations yet — this page is
 * honest about that rather than presenting placeholder toggles as if they
 * did something. What it does show for real: live provider status, since
 * that's what an "automation" would run against. */
export function AutomationsWorkspace() {
  const providers = useAppStore((s) => s.providers);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6">
      <h1 className="font-display font-semibold text-xl">Automations</h1>
      <p className="text-sm text-parchment-dim mt-1 max-w-lg">
        Scheduled imports and community plugins are on the roadmap (see
        docs/planning/product-requirements.md §7 Phase 5) but not built yet. For now, this shows
        which providers are live and what they're permitted to do.
      </p>

      <ul className="mt-6 max-w-xl space-y-1.5">
        {providers.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-3">
            <span className="text-sm font-medium">{p.display_name}</span>
            <span className="text-xs font-mono text-parchment-dim">{POLICY_LABEL[p.policy_status] ?? p.policy_status}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8 max-w-xl rounded-lg border border-charcoal-700 bg-charcoal-800/30 p-4 text-sm text-parchment-dim">
        Want to build one? See <span className="font-mono text-parchment">CONTRIBUTING.md</span> — provider
        adapters are independently testable and don't require touching the queue or file-operations
        core.
      </div>
    </div>
  );
}
