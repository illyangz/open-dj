import { useAppStore } from "../store/useAppStore";

/** FR-060: first-launch lawful-use notice, required before network
 * providers are used. Local-only workflows (local files, direct URLs you
 * already have rights to) still work underneath this, but the modal is
 * shown until acknowledged so it can't be missed. */
export function LawfulUseGate() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);

  if (!settings) return null;

  return (
    <div className="fixed inset-0 z-50 bg-charcoal-950/80 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="max-w-lg rounded-2xl border border-charcoal-700 bg-charcoal-900 p-7">
        <img src="/logo.svg" alt="" className="w-9 h-9 mb-3" />
        <h2 className="font-display font-semibold text-lg">Before you connect a provider</h2>
        <p className="mt-3 text-sm text-parchment-dim leading-relaxed">
          OpenDJ is local-first: your queue, settings, and file history work fully offline. When
          you enable a network provider, OpenDJ only retrieves audio where the source itself
          permits it — see <span className="font-mono text-parchment">PROVIDER_POLICY.md</span> for the
          exact rule per provider. Spotify and YouTube are metadata/link-import only; OpenDJ never
          circumvents DRM or a platform's access controls, regardless of format or bitrate
          requested.
        </p>
        <p className="mt-3 text-sm text-parchment-dim leading-relaxed">
          You're responsible for ensuring you have the right to download and use any media you
          request through a direct URL.
        </p>
        <button
          onClick={() => saveSettings({ ...settings, lawful_use_acknowledged: true })}
          className="mt-5 px-4 py-2 rounded-lg text-sm font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim transition-colors"
        >
          I understand and agree
        </button>
      </div>
    </div>
  );
}
