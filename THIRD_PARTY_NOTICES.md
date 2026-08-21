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
| [stem-splitter-core](https://github.com/gentij/stem-splitter-core) | MIT / Apache-2.0 | ONNX Runtime-based Demucs (htdemucs) inference for real stem separation |
| [FFmpeg](https://ffmpeg.org/) | GPL (build-dependent) | Bundled sidecar binary for audio conversion |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | Bundled sidecar binary for audio extraction/download |

## Stem separation model

Stem separation (`crates/stems`) does not bundle model weights in the app installer. The first
time a user runs it, `stem-splitter-core` downloads and SHA-256-verifies a ~200MB ONNX export of
the Hybrid Transformer Demucs (htdemucs) model directly from Hugging Face
(`gentij/htdemucs-ort`) — the same "external tool, fetched on demand rather than shipped" pattern
already used for yt-dlp/ffmpeg. That model repository does not carry an explicit license tag as
of this writing; the underlying Demucs research code and pretrained weights (Meta/FAIR) are
released under MIT. If that changes or is clarified, update this note accordingly.

## FFmpeg

OpenDJ bundles a static FFmpeg binary per platform (via Tauri's `externalBin` sidecar
mechanism — see `.github/workflows/release.yml`), fetched at release build time rather than
committed to the repo:

| Platform | Source | Build |
|---|---|---|
| macOS | [evermeet.cx](https://evermeet.cx/ffmpeg/) | Latest stable release build |
| Linux | [johnvansickle.com](https://johnvansickle.com/ffmpeg/) | Static amd64 build, GPL |
| Windows | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) | `essentials` build (includes libx264/libx265/libmp3lame) |

These are GPL-licensed builds (full codec set, including GPL-only codecs like libx264).
OpenDJ itself is licensed GPL-3.0-or-later, so this is license-compatible — no LGPL
restriction is needed. Full corresponding source for the exact FFmpeg version bundled in any
given release is available from the [FFmpeg project itself](https://github.com/FFmpeg/FFmpeg)
per GPL §6; OpenDJ does not modify FFmpeg's source.

## yt-dlp

OpenDJ bundles a standalone `yt-dlp` binary per platform (same `externalBin` mechanism as
FFmpeg above), fetched from [yt-dlp's own GitHub releases](https://github.com/yt-dlp/yt-dlp/releases)
at a pinned version (see `YTDLP_VERSION` in `.github/workflows/release.yml`). yt-dlp is
Unlicense (public domain) — no compliance requirements.

**Legal basis for bundling a download tool:** yt-dlp does not circumvent DRM or access
restrictions — it extracts publicly accessible audio/video streams that a site already serves
to any visitor. As with OpenDJ's Direct URL input, the user supplies a URL and is responsible
for having the right to download that content; OpenDJ does not host, index, or recommend
copyrighted material.

## Generating the full inventory locally

```bash
cargo install cargo-license
cargo license --workspace > docs/licenses-rust.txt

cd apps/desktop && pnpm dlx license-checker --production --json > ../../docs/licenses-js.json
```
