#!/usr/bin/env bash
# Builds the isolated libkeyfinder bridge (crates/keyfinder-bridge) and
# copies it into the Tauri app's bundle resources. Run this whenever that
# crate's source changes — it is NOT part of the normal `tauri build`/
# `cargo build -p desktop` graph on purpose (see crates/keyfinder-bridge's
# lib.rs doc comment for why the main app must never link it directly).
#
# Requires libkeyfinder + pkgconf, e.g.:
#   brew install libkeyfinder pkgconf
set -euo pipefail
cd "$(dirname "$0")/.."

export PKG_CONFIG_PATH="/opt/homebrew/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

cargo build -p opendj-keyfinder-bridge --release

mkdir -p apps/desktop/src-tauri/resources
cp target/release/libopendj_keyfinder_bridge.dylib apps/desktop/src-tauri/resources/

# Also build the debug profile — its output lands directly in target/debug/
# alongside the debug `desktop` binary, so `tauri dev` finds it via the
# same current-exe-relative lookup the release build uses, with no copy
# step needed.
cargo build -p opendj-keyfinder-bridge

echo "Bridge built and copied into apps/desktop/src-tauri/resources/"
