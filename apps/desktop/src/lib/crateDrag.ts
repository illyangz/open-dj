import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { api } from "./api";

/** Resolved once — `startDrag` needs a real image path on disk for the
 * drag preview, and it never changes for the life of the process. */
let iconPromise: Promise<string> | null = null;
function dragIcon(): Promise<string> {
  if (!iconPromise) iconPromise = api.dragPreviewIcon();
  return iconPromise;
}

/** Crate track paths that are actual files on disk — a crate can also
 * hold entries for tracks that haven't downloaded yet (their path is a
 * URL or placeholder), and those can't be dragged into another app. */
function audioFiles(paths: string[]): string[] {
  return paths.filter((p) => p.startsWith("/"));
}

/** Start a native OS file-drag of a crate's audio files. Dropping the
 * result onto Serato's crate panel (or Rekordbox, or Finder) adds the
 * tracks the same way dragging them from Finder would — no `.crate`
 * sidecar, no `_Serato_/Subcrates` dance. Call from an `onDragStart`
 * handler after `preventDefault()` so the webview's own drag ghost
 * doesn't fight it. */
export async function dragCrateFiles(trackPaths: string[]): Promise<void> {
  const files = audioFiles(trackPaths);
  if (files.length === 0) return;
  await startDrag({ item: files, icon: await dragIcon() });
}

/** Same, for a crate we don't already have the track list of (a row in
 * the sidebar that isn't the selected crate). */
export async function dragCrateById(crateId: string): Promise<void> {
  await dragCrateFiles(await api.listCrateTracks(crateId));
}
