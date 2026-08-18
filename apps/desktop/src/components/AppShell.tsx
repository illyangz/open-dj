import type { ReactNode } from "react";
import { useAppStore } from "../store/useAppStore";
import type { WorkspaceId } from "../types";
import { Tour } from "./Tour";
import { UpdateBanner } from "./UpdateBanner";
import {
  AutomationIcon,
  LibraryIcon,
  QueueIcon,
  RepairIcon,
  SettingsIcon,
  SortIcon,
  SoundcloudIcon,
} from "./icons";

const NAV: { id: WorkspaceId; label: string; icon: (p: { className?: string }) => ReactNode }[] = [
  { id: "queue", label: "Queue", icon: QueueIcon },
  { id: "soundcloud", label: "SoundCloud", icon: SoundcloudIcon },
  { id: "repair", label: "Repair", icon: RepairIcon },
  { id: "library", label: "Library", icon: LibraryIcon },
  { id: "sort", label: "Sort", icon: SortIcon },
  { id: "automations", label: "Automations", icon: AutomationIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export function AppShell({ children }: { children: ReactNode }) {
  const workspace = useAppStore((s) => s.workspace);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setTourOpen = useAppStore((s) => s.setTourOpen);
  const jobs = useAppStore((s) => s.jobs);
  const activeCount = jobs.filter((j) => ["waiting", "resolving", "downloading", "converting", "tagging", "organizing"].includes(j.state)).length;

  return (
    <div className="h-full flex bg-charcoal-900 text-parchment font-body">
      <nav className="w-[220px] shrink-0 border-r border-charcoal-700 flex flex-col">
        <div className="px-5 pt-6 pb-5">
          <div className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="" className="w-7 h-7" />
            <span className="font-display font-semibold text-lg tracking-tight">OpenDJ</span>
          </div>
          <p className="mt-1.5 text-[11px] text-parchment-dim leading-snug">
            Drop a track. Keep control.
          </p>
        </div>

        <ul className="flex-1 px-3 space-y-0.5">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = workspace === id;
            return (
              <li key={id}>
                <button
                  data-tour={`nav-${id}`}
                  onClick={() => setWorkspace(id)}
                  className={[
                    "w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                    active
                      ? "bg-charcoal-700 text-signal"
                      : "text-parchment-dim hover:text-parchment hover:bg-charcoal-800",
                  ].join(" ")}
                >
                  <Icon />
                  <span className="font-medium">{label}</span>
                  {id === "queue" && activeCount > 0 && (
                    <span className="ml-auto text-[11px] font-mono text-charcoal-900 bg-signal rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
                      {activeCount}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="px-5 py-4 space-y-2">
          <button
            onClick={() => setTourOpen(true)}
            className="w-full rounded-md border border-charcoal-700 px-3 py-1.5 text-[12px] font-medium text-parchment-dim hover:text-signal hover:border-signal/50 transition-colors duration-150"
          >
            Take the tour
          </button>
          <div className="text-[11px] text-parchment-dim/70 font-mono">local-first · v0.2.0</div>
        </div>
      </nav>

      <main className="flex-1 min-w-0 flex flex-col">
        <UpdateBanner />
        {children}
      </main>
      <Tour />
    </div>
  );
}
