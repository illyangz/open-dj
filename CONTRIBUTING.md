# Contributing to OpenDJ

OpenDJ is a local-first DJ music preparation workspace. See `docs/planning/product-requirements.md`
for the full PRD and `docs/planning/design-direction.md` for the visual system ("Night Signal").

## Project layout

```text
total-dj/
├── apps/desktop/        # Tauri shell + React/TypeScript UI
├── crates/
│   ├── core/             # Domain model, job engine, SQLite persistence
│   ├── file-ops/         # Safe writes, backups, restore journal
│   ├── metadata/         # Audio tag/container inspection (lofty)
│   ├── providers/        # Adapter trait, registry, adapter implementations
│   └── organization/     # Folder templates, dry-run planning, duplicates
├── fixtures/             # Synthetic audio + metadata used by tests
├── docs/planning/        # Original product/design/audit documents
└── .github/workflows/    # CI and release builds
```

## Prerequisites

- Node.js 20+ and pnpm 9+
- Rust (stable) via `rustup`
- Platform build dependencies for Tauri 2 — see the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your OS.

## Getting started

```bash
cd apps/desktop
pnpm install
pnpm tauri dev
```

## Tests

```bash
# Rust: unit + integration tests for every crate
cargo test --workspace

# Frontend: component tests
cd apps/desktop && pnpm test

# End-to-end (Playwright), once the app builds
cd apps/desktop && pnpm test:e2e
```

## Adding a provider adapter

Every adapter implements the `ProviderAdapter` trait in `crates/providers`. Before opening a PR
that adds or changes a `download` capability, read `PROVIDER_POLICY.md` — it is enforced in review,
not just documentation. Metadata-only adapters (no download) are welcome without a policy change.

## Commit and PR expectations

- Keep PRs scoped to one crate or workspace where possible.
- Add or update a fixture-based test for any change to `file-ops`, `core` job-state transitions,
  or provider adapters.
- Run `cargo fmt`, `cargo clippy --workspace`, and `pnpm lint` before opening a PR.
- Describe user-visible behavior changes in the PR body; screenshots or a short clip are
  appreciated for UI changes.

## Code of Conduct

This project follows `CODE_OF_CONDUCT.md`.
