# Handoff: Duplicate Detection + Global Playback Transport

Two independent features requested by the user for the OpenDJ desktop app
(`apps/desktop`, Tauri + React/TS frontend, Rust backend in `apps/desktop/src-tauri`
+ `crates/*`). Written after live-testing the codebase at v0.3.13. Ship them as
two separate PRs/sessions — they don't depend on each other.

**Read this whole document before writing code.** It contains design decisions
made after reading the actual code (not guesses) — deviating from them without
re-reading the referenced files first will likely reintroduce bugs this doc
exists to avoid.

---

## 0. Ground truth already established — don't re-derive it

- The app has **three separate, throwaway `<audio>` elements**, one each in
  `LibraryWorkspace.tsx` (line ~63), `SortWorkspace.tsx` (line ~50), and
  nowhere else. Each is local `useState`/`useRef` scoped to that component —
  playback state (`selectedId`, `isPlaying`, position) is lost the instant the
  user switches workspace tabs, because `App.tsx` fully unmounts the previous
  workspace component (see `WORKSPACES[workspace]` in `App.tsx`).
- Checksum-based duplicate detection **already exists** on the backend:
  `crates/organization/src/lib.rs::find_duplicates()` groups `TrackFields` by
  `checksum` (exact match only, groups of size 1 dropped). It's pure/already
  unit-tested. The checksum itself comes from
  `crates/file-ops/src/lib.rs::checksum_file()` — **SHA-256 of the entire raw
  file, tags included**. This is exposed today only as a read-only list in
  `LibraryWorkspace.tsx` (`duplicates` state, populated by `scanFolder()`,
  rendered around line 270 as `{group.join("  ==  ")}` — no action, no
  cross-workspace reach).
- **Important consequence of "whole file including tags" hashing**: two files
  with the same audio but different ID3 tags will *not* currently match as
  duplicates. If two files are byte-identical (checksum matches), their tags
  are already byte-identical too — there is nothing to "merge." So today's
  checksum only ever finds *true* duplicate files (e.g. downloaded twice to
  different names), where the fix is just "delete the extra copy," not merge.
  See §1.0 for the design decision this implies.
- A safe, reversible replace-file mechanism already exists and should be
  reused, not reinvented: `commands.rs::preview_replacement` /
  `apply_replacement` / `restore_mutation`, backed by
  `opendj_file_ops::replace_atomic` (backs up the original to
  `state.backup_root` before replacing) and a `mutation_journal` SQLite table
  (`crates/core/src/db.rs` line ~66) that `restore_mutation` reads to undo.
  This is the "safely" in "remove redundant copies safely" — do not just
  `fs::remove_file` duplicates.
- Two SQLite tables key rows by raw file path and will go stale if a
  duplicate's path disappears without updating them:
  `cue_points(track_path, slot, ...)` and `crate_tracks(crate_id, track_path)`
  (`crates/core/src/db.rs` lines ~92 and ~111). Any dedup-removal flow **must**
  re-point these from a removed path to the surviving path, or silently drop
  a user's hot cues / crate membership.
- The screenshot that prompted this request showed **5 identical rows in
  Library's "Downloads" section** — that list is built from `jobs.filter(j =>
  j.state === "complete")` in `useAppStore`, not from a folder scan. Since the
  SoundCloud fetch path (`fetch_soundcloud` in
  `crates/providers/src/adapters/ytdlp.rs`) does an unconditional
  `tokio::fs::write(&dest_path, &bytes)` to a deterministic filename, 5
  repeated downloads of the same track overwrite the same file — so on disk
  there is only **one** file, but **five Job rows** in the queue DB pointing
  at it. A checksum file-scan will never catch this; it needs separate
  handling. See §1.5.

---

## 1. Feature A — Duplicate Detection

### 1.0 Design decision: two detection tiers (confirm or override before coding)

Recommendation, given §0's finding that whole-file checksum can't produce
mergeable tag differences:

- **Tier 1 — exact file duplicates** (existing `find_duplicates`, whole-file
  SHA-256): action is straight removal of extras, no merge needed since tags
  are already identical. Fast, no new backend work.
- **Tier 2 — same recording, different tags/container** (new): hash the
  *decoded audio samples* only (ignore container/tags), so a retagged copy,
  a copy with different bitrate-but-same-source, or a re-exported file with
  edited metadata still groups together. This is where "merge metadata"
  actually means something — union the tag fields across the group into
  whichever file becomes canonical.

If tier 2 feels like scope creep for a first pass, it's fine to ship tier 1
only (rename the feature internally to "duplicate files," not "duplicate
tracks") — but say so explicitly in the PR description, because the user's
phrasing ("merge metadata") implies they expect tier 2 behavior.

### 1.1 Backend changes

**New audio-content checksum** (tier 2 only, skip if doing tier 1 only):
- Add `checksum_audio_content(path: &Path) -> Result<String>` to
  `crates/metadata` (it already links `symphonia` for `opendj_metadata::probe`
  / `analyze_track` — reuse that decode path). Hash the decoded PCM sample
  stream (e.g. SHA-256 over `i16`/`f32` samples after resampling to a fixed
  rate, so different bitrates of the same source still match). This is
  materially slower than the file checksum (full decode vs. raw bytes), so:
  - Only run it as a **second pass** over tracks that *don't* already share a
    tier-1 checksum (no point re-decoding files already known identical).
  - Run behind `state.analysis_semaphore` (already exists, capped at half the
    machine's cores — see `state.rs`), not unthrottled, matching how
    `analyze_track` already behaves.

**New command** `find_duplicate_groups` (replaces/extends
`find_duplicate_tracks`) returning richer groups than `Vec<Vec<String>>`:
```rust
struct DuplicateGroup {
    tier: DuplicateTier, // "exact_file" | "same_audio"
    tracks: Vec<TrackFields>, // full metadata per member, not just paths
    suggested_canonical: String, // source_path — see canonical-picking rule below
}
```
**Canonical-picking rule** (tier 2 groups only — tier 1 members are identical
so any is fine): prefer, in order — (a) highest bitrate/sample rate from
`AudioProbe`, (b) most complete tag set (most non-null fields), (c) oldest
`file_records`/mtime as a final tiebreak. Implement as a pure function in
`crates/organization` so it's unit-testable without touching disk.

**New command** `merge_duplicate_group`:
```rust
async fn merge_duplicate_group(
    state: State<'_, AppState>,
    canonical_path: String,
    redundant_paths: Vec<String>,
) -> CmdResult<Vec<MutationRecord>>
```
Per redundant path, in order:
1. Union any tag fields present on the redundant file but missing on
   canonical into canonical (write via whatever `opendj_metadata` already
   uses to write tags — check `crates/metadata` for the writer used by
   `analyze_track`'s "write BPM/key back into tags" path, reuse it, don't add
   a second tag-writing code path).
2. Re-point `cue_points` and `crate_tracks` rows from `redundant_path` to
   `canonical_path` (new `Store` methods in `crates/core/src/store.rs`,
   mirroring the existing `UPDATE`-style methods there — **do not** just
   delete the redundant row's cues/crate memberships, that silently loses
   user data).
3. Move (not delete) the redundant file into `state.backup_root`, recording a
   `mutation_journal` row exactly like `apply_replacement` does, so
   `restore_mutation` (already exists, already wired to UI in Repair) can
   undo it later. **Reuse `opendj_file_ops::replace_atomic`'s backup step or
   factor a shared helper** — do not write a second ad hoc backup path.
4. Return the `MutationRecord`s so the frontend can show "N files backed up,
   undo from Repair's mutation journal if this was wrong."

### 1.2 Frontend changes

- Promote the read-only `duplicates` block in `LibraryWorkspace.tsx` (~line
  270) into an actionable panel: per group, show all members (title/artist,
  bitrate, tag completeness, file size), the suggested canonical
  pre-selected, a radio to override which one is canonical, and a "Merge &
  Remove N duplicates" button that calls `merge_duplicate_group` and then
  refreshes `tracks`/`duplicates`.
- **Crates**: `CratesWorkspace.tsx` renders tracks via `listCrateTracks` (an
  array of paths). After a merge, any crate referencing a redundant path
  needs its `crate_tracks` row already re-pointed server-side (§1.1 step 2)
  — the frontend just needs to re-fetch `listCrateTracks` after a merge
  completes if that crate is currently open. Add a duplicate-scan entry
  point in `CratesWorkspace.tsx` too (reuse the same panel component,
  scoped to that crate's track paths) rather than a separate UI.
- **Queue**: do NOT wire tier-1/tier-2 file-checksum dedup into
  `QueueWorkspace`/`QueueList.tsx` — the duplicates that show up there are
  the Job-record kind (§1.5), a different problem with a different fix.

### 1.3 Safety requirements (non-negotiable)

- Never delete a file outright. Every removal goes through the
  backup+journal path so it's undoable from the existing Repair mutation
  journal UI.
- Never silently drop `cue_points` or `crate_tracks` rows — re-point, don't
  delete, or the user loses hot cues/crate membership with no warning.
- The merge action must be idempotent-safe against a mid-operation crash:
  do the tag-write and DB re-point *before* moving the file to backup, so a
  crash between steps leaves the file in place (worst case: a stale journal
  row) rather than an orphaned crate/cue reference with no file.

### 1.4 Edge cases to explicitly test

- A duplicate group where the "canonical" pick has *fewer* tags than a
  redundant member (verify the union actually fills in canonical's gaps,
  not just keeps canonical's tags as-is).
- A redundant file that has cue points the canonical file doesn't — verify
  they survive the re-point (decide + document what happens if BOTH files
  have a cue in the same slot number: last-write-wins is fine, but say so).
- A redundant file that's a member of two different crates, canonical is a
  member of neither — verify both crate memberships transfer.
- Running the scan twice in a row after a merge — the merged-away paths must
  not reappear as a "duplicate" of the (now backed-up, moved) file.
- A duplicate group with 3+ members (not just pairs).

### 1.5 The Job-record duplicate problem (separate from file duplicates)

This is what the user's screenshot actually showed. Different root cause,
different fix, don't conflate with §1.1–1.4:

- Multiple `Job` rows in the queue DB can end up with the identical
  `destination` path (repeated paste of the same link, or — before the
  v0.3.13 fix — the `ingest()`/`patchJob` race). Recommend: when a job
  reaches `Complete`, check `list_jobs` for any other job already `Complete`
  with the same `destination`; if found, mark the new one's state such that
  it's visually collapsed/hidden in `QueueList.tsx` (e.g. a `duplicate_of:
  Option<Uuid>` field on `Job`, filtered out of the default queue view but
  visible under an "All" or a dedicated debug filter) rather than showing as
  a second independent row in Library's Downloads list.
- Simpler alternative if a `Job` schema change feels too invasive for this
  pass: in `LibraryWorkspace.tsx`'s `downloads` `useMemo` (line ~41), dedupe
  by `destination` before rendering (`Map` keyed by `job.destination`, keep
  the most recently updated). This fixes the *symptom* (repeated visual
  rows) without touching the DB, but leaves the redundant `Job` rows sitting
  in the Queue tab itself — check with the user whether that's acceptable or
  whether they want the Queue tab deduped too (same `Map`-by-destination
  approach would work in `QueueList.tsx`'s `jobs` derivation).

### 1.6 QA / acceptance criteria — do not skip this

The prior session in this repo shipped a "fix" for SoundCloud downloads that
turned out to be incomplete because it was never tested against a live
track that actually exercised the failure path — only caught on a follow-up
live-network test. Do not repeat that pattern here.

1. `cargo test -p opendj-organization -p opendj-core -p opendj-file-ops` —
   all existing + new unit tests green. Add unit tests for: the canonical-
   picking rule (pure function, easy to test with fixtures), the tag-union
   logic, and `find_duplicates` grouping for tier 2 if implemented.
2. `cargo check -p desktop` and `npx tsc --noEmit -p apps/desktop` clean.
3. **Manual, with real files** (this is the part that's easy to skip and
   shouldn't be): create 3+ real small MP3s on disk — at minimum one exact
   byte-copy pair (`cp a.mp3 b.mp3`) and, if doing tier 2, one pair that's
   the same audio re-tagged differently (e.g. via `ffmpeg -i a.mp3 -metadata
   title="Different" c.mp3` re-encode or a plain tag edit). Run a real scan
   in the running app (`cargo tauri dev` or the `run` skill), verify:
   - Both tiers actually detect the fixture pairs as duplicate groups (not
     just "code compiles" — confirm the panel renders them).
   - Merge actually leaves one playable file, tags on it include the union
     of both, and the redundant file is gone from its original location but
     present in the backup root.
   - A cue point set on the *redundant* file before merging is present on
     the canonical file after merging (this is the case most likely to be
     silently broken).
   - `restore_mutation` on the resulting journal entry actually restores the
     redundant file to its original path.
4. Report back with what was actually run (commands + output), not just "it
   should work."

---

## 2. Feature B — Global Playback Transport Bar

Requested UI: persistent play/pause, timeline scrubber, next/prev, placed in
the left nav column (`AppShell.tsx`), visible regardless of which workspace
tab is open — because right now playback state is destroyed on every tab
switch (see §0).

### 2.1 Store changes (`src/store/useAppStore.ts`)

Add a `player` slice:
```ts
interface PlayerTrack {
  jobId: string;
  title: string | null;
  artist: string | null;
  destination: string; // file path, fed through convertFileSrc()
  durationSec: number | null;
}
interface PlayerState {
  current: PlayerTrack | null;
  isPlaying: boolean;
  position: number;
  /** The ordered list `current` was launched from — e.g. Library's
   * Downloads order, or a crate's track order — captured at play time so
   * next/prev has a well-defined list to walk. Not necessarily "all
   * tracks everywhere." */
  contextQueue: PlayerTrack[];
}
```
Actions: `playTrack(track, contextQueue)`, `togglePlay()`, `seek(seconds)`,
`next()`, `prev()`. One real `<audio>` element, owned by a new
`GlobalAudioElement` component mounted once at the `App.tsx` root (sibling
of `AppShell`, not inside it, so it's never unmounted by workspace
switches) — mirrors the event-listener-mirrors-into-state pattern already
used in `LibraryWorkspace.tsx` lines 73–90 (`play`/`pause`/`ended` listeners
syncing `isPlaying`), just promoted to the store instead of local state.

`next()`/`prev()` semantics: find `current` in `contextQueue` by `jobId`,
step by one, wrap or stop at the ends (decide which — stopping at the end
matches how the existing per-row "Reveal in Finder" style tools already
behave i.e. no auto-loop; recommend stopping, not wrapping, unless the user
asks for repeat/loop later).

### 2.2 UI: transport bar component

New `src/components/PlayerBar.tsx`, rendered in `AppShell.tsx` — the user
pointed at the left nav column, between the workspace list (`<ul>` around
line 60) and the existing footer block (`UsernameWidget` / "Take the tour" /
version, lines ~90-103). Render nothing (`return null`) when `player.current`
is `null` (nothing has ever played) rather than an empty placeholder bar.
Contents, compact (this column is 220px wide — see `w-[220px]` on `<nav>`):
- Track title/artist, truncated.
- Prev / Play-Pause / Next row (new `PrevIcon`/`NextIcon` needed in
  `icons.tsx` — `PlayIcon`/`PauseIcon` already exist there and are already
  used exactly this way in `LibraryWorkspace.tsx`, reuse them).
- A thin scrubber (click-to-seek, same pattern as the waveform click-seek
  already implemented in `LibraryWorkspace.tsx`'s `DownloadRow`
  `fractionFromEvent`/`onClick` — reuse the fraction-from-click-position
  logic rather than re-deriving it) with elapsed/duration text
  (`formatTime`, already defined in `LibraryWorkspace.tsx` — consider
  promoting it to a shared `lib/format.ts` since both this and
  `LibraryWorkspace` will need it).

### 2.3 Migrate existing per-workspace players

- `LibraryWorkspace.tsx`: remove the local `audioRef`/`selectedId`/
  `isPlaying` state and the `<audio>` element (lines ~63–104, 228). Replace
  `togglePlay(job)` with `useAppStore(s => s.playTrack)` /
  `useAppStore(s => s.togglePlay)`, passing `downloads` (the existing
  `useMemo` at line 41) as `contextQueue` so next/prev walks the Downloads
  list. `jumpToCue`/`seekPreview` need to become store actions too
  (`seek(seconds)`), since they currently reach into the local `audioRef`
  directly.
- `SortWorkspace.tsx`: same treatment — remove its local `audioRef` (line
  ~50) and route through the store.
- Both workspaces' hot-cue UI (`cueBySlot`, jump-to-cue buttons) stays
  workspace-local (cues are legitimately per-track data fetched via
  `listCuePoints`) — only the *playback* moves to the shared store. Don't
  over-migrate; the cue-pad grid and waveform rendering are correctly
  workspace-scoped already.

### 2.4 Edge cases to test

- Start playback in Library, switch to Queue tab, switch back — audio must
  keep playing uninterrupted (this is the actual bug being fixed; verify it
  doesn't just "not crash" but that sound is audibly continuous and the bar
  shows the right position).
- Start playback in Library, switch to Sort tab, press play on a *different*
  track there — verify the Library row's UI updates to reflect it's no
  longer the selected/playing track (shared state, not two independent
  "isPlaying" flags going out of sync).
- Prev/Next at the start/end of `contextQueue` — verify the documented
  stop-at-ends behavior (buttons disable, don't throw/wrap unexpectedly).
- Closing/reopening the enlarged `TrackDetailModal` mid-playback — its own
  play/pause button (line ~782) currently calls the *local* `onTogglePlay`
  prop; after migration this must still correctly reflect/control the same
  global state, not a second disconnected toggle.

### 2.5 QA / acceptance criteria

1. `npx tsc --noEmit -p apps/desktop` and `npm run build` clean.
2. `cargo check -p desktop` clean (no backend changes expected for this
   feature, but confirm nothing broke).
3. **Manual, in the running app** — this feature is impossible to verify by
   type-checking alone, it's fundamentally a UX/runtime behavior claim:
   - Play a real downloaded track from Library, switch through every
     workspace tab (Queue, SoundCloud, Repair, Sort, Crates, Community,
     Automations, Settings) and back to Library — confirm audio never stops
     and the bar's scrubber position keeps advancing throughout.
   - Use the bar's own play/pause/prev/next from a non-Library tab (e.g.
     while sitting on Settings) — confirm it actually controls playback
     with no Library UI visible.
   - Screenshot or screen-record the bar in both a "nothing playing" state
     (confirm it doesn't show as an ugly empty box) and mid-playback.
4. Report back with what was actually clicked through, not just "should
   work."

---

## 3. Execution protocol for whoever implements this

- Ship Feature A and Feature B as separate commits/PRs — they touch
  different files almost entirely (only `LibraryWorkspace.tsx` overlaps),
  and reviewing them together makes it harder to verify either one
  properly.
- Before starting, re-read the exact current contents of every file named
  above with line numbers — this doc was accurate as of v0.3.13 but line
  numbers drift the moment anyone else touches these files.
- Follow the existing safety pattern for any destructive operation (backup
  + mutation journal) rather than introducing a second, parallel one — grep
  for how Repair already does it before writing new code.
- Do not claim a fix works without running it — type-checking and unit
  tests verify code correctness, not feature correctness. Both features
  here are fundamentally about runtime/UX behavior (does audio survive a
  tab switch? does a merge actually preserve a cue point?) that no
  type-checker can confirm. Use `cargo tauri dev` (or this repo's `run`
  skill if one is configured) and actually click through the scenarios in
  §1.4/§1.6/§2.4/§2.5 before reporting done.
- If a design decision in this doc (canonical-picking rule, stop-vs-wrap on
  next/prev, tier-1-only vs. tier-1+tier-2) turns out to be wrong once
  you're looking at real code/data, that's fine — override it, but say so
  explicitly in the handoff back to the user rather than silently doing
  something different from what was asked.
