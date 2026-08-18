import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import type { Settings, SystemToolsStatus } from "../types";

/** FR-060–FR-064: storage/quality/concurrency/privacy configuration, plus
 * system tools status (yt-dlp + ffmpeg). */
export function SettingsWorkspace() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const providers = useAppStore((s) => s.providers);
  const [tools, setTools] = useState<SystemToolsStatus | null>(null);
  const [toolsLoading, setToolsLoading] = useState(true);

  useEffect(() => {
    api
      .checkSystemTools()
      .then(setTools)
      .catch(() => setTools(null))
      .finally(() => setToolsLoading(false));
  }, []);

  if (!settings) return null;

  async function update(patch: Partial<Settings>) {
    await saveSettings({ ...settings!, ...patch });
  }

  async function chooseDownloadRoot() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") await update({ download_root: dir });
  }

  async function chooseCookiesFile() {
    const file = await open({
      multiple: false,
      filters: [{ name: "Cookies", extensions: ["txt"] }],
    });
    if (typeof file === "string") await update({ youtube_cookies_file: file });
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6 max-w-2xl">
      <h1 className="font-display font-semibold text-xl">Settings</h1>

      <Section title="Storage">
        <FieldRow label="Download folder">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-parchment-dim truncate max-w-xs">
              {settings.download_root || "Default (app data folder)"}
            </span>
            <button onClick={chooseDownloadRoot} className="text-xs text-signal hover:text-signal-dim">
              Change…
            </button>
          </div>
        </FieldRow>
        <FieldRow label="Folder template">
          <input
            value={settings.folder_template}
            onChange={(e) => update({ folder_template: e.target.value })}
            className="rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm font-mono w-56"
          />
        </FieldRow>
      </Section>

      <Section title="Concurrency">
        <FieldRow label="Simultaneous network jobs">
          <NumberInput
            value={settings.concurrency_network}
            onChange={(v) => update({ concurrency_network: v })}
          />
        </FieldRow>
        <FieldRow label="Simultaneous file mutations">
          <NumberInput
            value={settings.concurrency_file_mutation}
            onChange={(v) => update({ concurrency_file_mutation: v })}
          />
        </FieldRow>
      </Section>

      <Section title="System tools">
        {toolsLoading ? (
          <p className="text-xs text-parchment-dim">Checking tools…</p>
        ) : tools ? (
          <div className="space-y-2">
            <ToolRow
              name="yt-dlp"
              installed={!!tools.ytdlp_path}
              version={tools.ytdlp_version}
              path={tools.ytdlp_path}
            />
            <ToolRow
              name="ffmpeg"
              installed={!!tools.ffmpeg_path}
              version={tools.ffmpeg_version}
              path={tools.ffmpeg_path}
            />
            {!tools.ytdlp_path && (
              <p className="text-xs text-amber mt-2">
                yt-dlp is required for downloading. Install with:{" "}
                <span className="font-mono">brew install yt-dlp</span>
              </p>
            )}
            {!tools.ffmpeg_path && (
              <p className="text-xs text-amber mt-2">
                ffmpeg is required for audio conversion. Install with:{" "}
                <span className="font-mono">brew install ffmpeg</span>
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-parchment-dim">Unable to check tools.</p>
        )}
      </Section>

      <Section title="YouTube">
        <FieldRow label="Cookies file (recommended)">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-parchment-dim truncate max-w-[220px]">
              {settings.youtube_cookies_file || "None chosen"}
            </span>
            <button onClick={chooseCookiesFile} className="text-xs text-signal hover:text-signal-dim">
              Choose…
            </button>
            {settings.youtube_cookies_file && (
              <button
                onClick={() => update({ youtube_cookies_file: "" })}
                className="text-xs text-parchment-dim hover:text-parchment"
              >
                Clear
              </button>
            )}
          </div>
        </FieldRow>
        <p className="text-xs text-parchment-dim mt-1">
          Export a <span className="font-mono">cookies.txt</span> from a browser you're logged
          into YouTube with (the "Get cookies.txt LOCALLY" extension works for Chrome/Firefox),
          then select it here. This is the most reliable option — it's a fixed snapshot, so it
          can't be invalidated mid-request the way live browser-cookie extraction sometimes is.
          Re-export and re-select if downloads start failing again after a while (YouTube
          sessions expire).
        </p>

        <FieldRow label="Or: browser cookies (live)">
          <select
            value={settings.youtube_cookies_browser}
            onChange={(e) => update({ youtube_cookies_browser: e.target.value })}
            className="rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm font-mono"
          >
            <option value="">None</option>
            <option value="chrome">Chrome</option>
            <option value="firefox">Firefox</option>
            <option value="edge">Edge</option>
            <option value="brave">Brave</option>
            <option value="safari">Safari (needs Full Disk Access)</option>
          </select>
        </FieldRow>
        <p className="text-xs text-parchment-dim mt-1">
          Only used if no cookies file is set above. Reads cookies live from that browser's
          storage on every request — Chrome will prompt once for your Mac login password
          (Keychain), and Safari additionally requires granting OpenDJ Full Disk Access in
          System Settings → Privacy &amp; Security, since Safari sandboxes its cookie store from
          every other app.
        </p>
        <p className="text-xs text-amber/80 mt-2">
          Neither option is a guarantee — YouTube's bot-check runs server-side and can still
          trigger under heavy request volume even with valid cookies. If it keeps happening,
          slow down and space out requests rather than retrying immediately.
        </p>
      </Section>

      <Section title="Privacy">
        <FieldRow label="Anonymous usage analytics">
          <Toggle checked={settings.analytics_opt_in} onChange={(v) => update({ analytics_opt_in: v })} />
        </FieldRow>
        <p className="text-xs text-parchment-dim mt-1">
          Off by default (FR-061). OpenDJ never uploads audio files or file paths anywhere.
        </p>
      </Section>

      <Section title="Providers">
        <ul className="space-y-1.5">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center justify-between text-sm">
              <span>{p.display_name}</span>
              <span className="text-xs font-mono text-parchment-dim">
                {p.policy_status === "permitted"
                  ? "download permitted"
                  : p.policy_status === "not_configured"
                    ? "not available"
                    : "metadata only"}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-parchment-dim mt-3">
          Audio downloads use yt-dlp, which supports YouTube, Spotify, SoundCloud, Beatport, Apple
          Music, Deezer, and 1800+ other sites. No API keys required.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 pt-6 border-t border-charcoal-700 first:border-t-0 first:pt-0">
      <h2 className="font-display font-semibold text-sm text-teal uppercase tracking-wide">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

function ToolRow({
  name,
  installed,
  version,
  path,
}: {
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="flex items-center gap-2">
        <span className={["w-2 h-2 rounded-full", installed ? "bg-signal" : "bg-red-500"].join(" ")} />
        <span className="font-mono">{name}</span>
      </span>
      <span className="text-xs text-parchment-dim">
        {installed ? (
          <>
            {version || "installed"}
            {path && <span className="ml-2 opacity-50">{path}</span>}
          </>
        ) : (
          <span className="text-red-400">not found</span>
        )}
      </span>
    </div>
  );
}

function NumberInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={1}
      max={16}
      value={value}
      onChange={(e) => onChange(Number(e.target.value) || 1)}
      className="w-16 rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-2 py-1.5 text-sm font-mono"
    />
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        "w-10 h-[22px] rounded-full relative transition-colors",
        checked ? "bg-signal" : "bg-charcoal-700",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-0.5 w-[18px] h-[18px] rounded-full bg-charcoal-950 transition-transform",
          checked ? "translate-x-[19px]" : "translate-x-0.5",
        ].join(" ")}
      />
    </button>
  );
}
