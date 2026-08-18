import { useEffect } from "react";
import { AppShell } from "./components/AppShell";
import { LawfulUseGate } from "./components/LawfulUseGate";
import { useAppStore } from "./store/useAppStore";
import { QueueWorkspace } from "./workspaces/QueueWorkspace";
import { SoundcloudWorkspace } from "./workspaces/SoundcloudWorkspace";
import { RepairWorkspace } from "./workspaces/RepairWorkspace";
import { LibraryWorkspace } from "./workspaces/LibraryWorkspace";
import { SortWorkspace } from "./workspaces/SortWorkspace";
import { AutomationsWorkspace } from "./workspaces/AutomationsWorkspace";
import { SettingsWorkspace } from "./workspaces/SettingsWorkspace";

const WORKSPACES = {
  queue: QueueWorkspace,
  soundcloud: SoundcloudWorkspace,
  repair: RepairWorkspace,
  library: LibraryWorkspace,
  sort: SortWorkspace,
  automations: AutomationsWorkspace,
  settings: SettingsWorkspace,
};

function App() {
  const init = useAppStore((s) => s.init);
  const workspace = useAppStore((s) => s.workspace);
  const settings = useAppStore((s) => s.settings);

  useEffect(() => {
    void init();
  }, [init]);

  const Workspace = WORKSPACES[workspace];

  return (
    <>
      <AppShell>
        <Workspace />
      </AppShell>
      {settings && !settings.lawful_use_acknowledged && <LawfulUseGate />}
    </>
  );
}

export default App;
