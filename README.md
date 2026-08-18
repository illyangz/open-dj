<div align="center">

# OpenDJ

**Drop a track. Keep control.**

A local-first desktop app for downloading, tagging, and organizing tracks for your DJ sets —
no cloud sync, no subscriptions, your library stays on your machine.

[Download](https://github.com/illyangz/open-dj/releases/latest) ·
[Website](https://illyangz.github.io/open-dj/) ·
[Docs](https://illyangz.github.io/open-dj/docs.html)

</div>

---

## What it does

- **Universal downloads** — paste a link from YouTube, SoundCloud, Beatport, Bandcamp, or
  1800+ other sites (via [yt-dlp](https://github.com/yt-dlp/yt-dlp)); SoundCloud likes and
  Spotify/Apple Music metadata are also supported.
- **Auto-organize** — template-based folder layout (`{artist}/{album}/{title}`), applied as
  every track lands.
- **Key & BPM analysis** — Camelot key detection (via [libkeyfinder](https://github.com/mixxxdj/libkeyfinder),
  the same engine Mixxx uses) with a pure-Rust fallback when it isn't installed, plus BPM
  analysis for harmonic mixing.
- **Sort view** — every track grouped by Camelot key and sorted by BPM, with one-click export
  to Rekordbox XML or CSV.
- **Library** — waveform previews, in-app playback, and search across your whole collection.
- **Backup & restore** — every file mutation is journaled; nothing is overwritten without a
  verified backup first.
- **Auto-update** — signed releases published to GitHub; the app checks and offers to
  update itself in place.

Cross-platform: macOS, Windows, and Linux, built from the same codebase.

## Install

Download the installer for your platform from the
[latest release](https://github.com/illyangz/open-dj/releases/latest):

| Platform | Format |
|---|---|
| macOS | `.dmg` (universal — Apple Silicon + Intel) |
| Windows | `.msi` or `.exe` (NSIS) |
| Linux | `.AppImage`, `.deb`, or `.rpm` |

> **Linux note:** in-app auto-update only works for the AppImage build — `.deb`/`.rpm`
> installs update through your system package manager instead.

## Building from source

Requires [Rust](https://rustup.rs/) (stable), [Node.js](https://nodejs.org/) 20+, and
[pnpm](https://pnpm.io/) 9+.

```bash
git clone https://github.com/illyangz/open-dj.git
cd open-dj/apps/desktop
pnpm install
pnpm tauri dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full project layout, test commands, and PR
expectations.

## Project layout

```text
open-dj/
├── apps/desktop/        # Tauri shell + React/TypeScript UI
├── crates/
│   ├── core/             # Domain model, job engine, SQLite persistence
│   ├── file-ops/         # Safe writes, backups, restore journal
│   ├── metadata/         # Audio tag/container inspection + BPM/key analysis
│   ├── providers/        # Adapter trait, registry, adapter implementations
│   ├── organization/     # Folder templates, dry-run planning, duplicates
│   └── keyfinder-bridge/  # Isolated libkeyfinder FFI, loaded at runtime — never a hard link
├── site/                 # Marketing site + docs (deployed via GitHub Pages)
├── fixtures/              # Synthetic audio + metadata used by tests
└── .github/workflows/     # CI and cross-platform release builds
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, test commands,
and how to add a provider adapter. Adding a new **download** source requires a
[`PROVIDER_POLICY.md`](PROVIDER_POLICY.md) review; metadata-only adapters don't.

Please report security vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[GPL-3.0-or-later](LICENSE). Third-party license notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
