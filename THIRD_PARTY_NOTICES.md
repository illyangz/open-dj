# Third-Party Notices

OpenDJ is built on the following major open-source components. This file is a human-readable
summary; the authoritative, machine-generated license inventory is produced by
`cargo license` (Rust dependencies) and `pnpm licenses list` (JavaScript dependencies) as part of
CI, and published alongside each release.

| Component | License | Role |
|---|---|---|
| [Tauri](https://tauri.app/) | MIT / Apache-2.0 | Desktop application shell and native bridge |
| [React](https://react.dev/) | MIT | UI rendering |
| [Vite](https://vitejs.dev/) | MIT | Frontend build tooling |
| [Tailwind CSS](https://tailwindcss.com/) | MIT | Styling |
| [lofty-rs](https://github.com/Serial-ATA/lofty-rs) | MIT / Apache-2.0 | Audio tag/container reading and writing |
| [rusqlite](https://github.com/rusqlite/rusqlite) | MIT | SQLite bindings for queue and journal persistence |
| [Tokio](https://tokio.rs/) | MIT | Async runtime for the job engine |
| [reqwest](https://github.com/seanmonstar/reqwest) | MIT / Apache-2.0 | HTTP client for provider adapters |
| [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) | OFL-1.1 | Display typeface |
| [IBM Plex Sans / Mono](https://github.com/IBM/plex) | OFL-1.1 | Body and monospace typefaces |

## FFmpeg

If a bundled FFmpeg sidecar is added for audio conversion, its exact build and licensing
configuration (LGPL vs GPL components enabled) will be documented here before it ships in a
release, per `docs/planning/recreation-plan.md` §5 and §13.

## yt-dlp or similar tooling

OpenDJ does not bundle `yt-dlp` or any stream-extraction tool. See `PROVIDER_POLICY.md` for why.

## Generating the full inventory locally

```bash
cargo install cargo-license
cargo license --workspace > docs/licenses-rust.txt

cd apps/desktop && pnpm dlx license-checker --production --json > ../../docs/licenses-js.json
```
