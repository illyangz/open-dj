#!/bin/bash
# OpenDJ installer for macOS.
#
# Downloads and installs OpenDJ.app directly via curl + hdiutil, entirely
# outside the browser download path that triggers macOS's quarantine flag
# on an unnotarized app (Gatekeeper then blocks it with "is damaged and
# can't be opened" — misleading, since nothing is actually corrupt, it's
# just not signed by a paid Apple Developer account).
#
# curl itself never applies com.apple.quarantine, but that alone isn't
# enough: on current macOS, Terminal-spawned processes that write new
# executable content (here, `cp -R`'ing the .app out of the mounted image)
# can still get it auto-applied to what they write, independent of how the
# source file arrived — confirmed empirically (2026-08-21): a real run of
# exactly this script's curl+hdiutil+cp sequence left
# /Applications/OpenDJ.app with a `com.apple.quarantine` xattr, which
# Gatekeeper then acted on (App Translocation kicked in, the "is damaged"
# prompt fired via CoreServicesUIAgent, and syspolicyd killed the running
# process once the prompt resolved) — i.e. the exact failure this script
# exists to route around. `xattr -cr` after the copy is the actual fix:
# it unconditionally strips quarantine from what was just installed,
# regardless of whether this particular macOS version/context decided to
# apply it. If you'd rather not pipe a script into bash, downloading the
# .dmg from the website and running that same `xattr -cr /Applications/OpenDJ.app`
# after dragging it into Applications achieves the same result, just as
# two manual steps instead of one command.
set -euo pipefail

DMG_URL="https://github.com/illyangz/open-dj/releases/latest/download/OpenDJ-macOS.dmg"
APP_NAME="OpenDJ.app"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is for macOS only. Grab the Windows/Linux build from https://illyangz.github.io/open-dj/#cta" >&2
  exit 1
fi

# Apple Silicon only — see release.yml for why (no x86_64-apple-darwin
# ONNX Runtime prebuilt for the stem-separation feature). Warn rather than
# let an Intel Mac silently fail on an arm64-only binary.
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Warning: OpenDJ currently ships Apple Silicon (arm64) builds only." >&2
  echo "This looks like an Intel Mac ($(uname -m)) — the app will not run here." >&2
fi

tmp_dmg="$(mktemp -t opendj).dmg"
# A unique mountpoint (rather than a fixed /Volumes/OpenDJ) avoids the
# " 1"/" 2" suffix hdiutil appends when a volume of that name is already
# attached (e.g. a leftover mount from a prior run, or the user already has
# the dmg open in Finder) — with a fixed name, that suffix would silently
# point cleanup's detach and the cp below at the wrong, possibly
# nonexistent, path.
mount_point="$(mktemp -d -t opendj-mount)"
cleanup() {
  hdiutil detach "$mount_point" -quiet -force >/dev/null 2>&1 || true
  rm -rf "$tmp_dmg" "$mount_point"
}
trap cleanup EXIT

echo "Downloading OpenDJ..."
curl -fsSL -o "$tmp_dmg" "$DMG_URL"

echo "Installing..."
hdiutil attach "$tmp_dmg" -nobrowse -quiet -mountpoint "$mount_point"
pkill -f "/Applications/${APP_NAME}/Contents/MacOS/desktop" >/dev/null 2>&1 || true
rm -rf "/Applications/${APP_NAME}"
cp -R "${mount_point}/${APP_NAME}" /Applications/
xattr -cr "/Applications/${APP_NAME}"

echo "Done — OpenDJ is in your Applications folder."
open "/Applications/${APP_NAME}"
