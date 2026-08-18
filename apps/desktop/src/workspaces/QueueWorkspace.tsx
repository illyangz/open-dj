import { IngestDial } from "../components/IngestDial";
import { QueueList } from "../components/QueueList";
import { Inspector } from "../components/Inspector";

export function QueueWorkspace() {
  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
        <div className="p-6 pb-2" data-tour="ingest-dial">
          <IngestDial />
        </div>
        <div className="pt-4">
          <QueueList />
        </div>
      </div>
      <Inspector />
    </div>
  );
}
