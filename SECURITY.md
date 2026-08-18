# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's "Report a vulnerability" flow
(Security tab → Advisories) on this repository rather than opening a public issue. If that is not
available, open a minimal public issue asking a maintainer to open a private channel — do not
include exploit details in it.

Include: affected version/commit, platform (macOS/Windows/Linux), reproduction steps, and impact
assessment. We aim to acknowledge reports within 5 business days.

## Scope

In scope: the Tauri shell, the Rust core (`crates/*`), provider adapters, the file-replacement
and backup/restore path, and the release/build pipeline.

Particularly high-value reports: anything that could cause data loss during file replacement
(FR-034–FR-038), credential handling for provider adapters (should live in OS secure storage, not
plaintext config or logs), or a provider adapter that bypasses `PROVIDER_POLICY.md`.

## Supported versions

Only the latest tagged release and the `main` branch receive security fixes during pre-1.0
development.
