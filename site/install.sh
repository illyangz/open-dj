#!/bin/bash
# OpenDJ installer for macOS.
#
# Downloads and installs OpenDJ.app directly via curl + hdiutil, entirely
# outside the browser download path that triggers macOS's quarantine flag
# on an unnotarized app (Gatekeeper then blocks it with "is damaged and
# can't be opened" — misleading, since nothing is actually corrupt, it's
# just not signed by a paid Apple Developer account). curl never applies
# that flag, and neither does a plain file copy from a mounted disk image,
# so an app installed this way opens with no dialog at all. If you'd rather
# not pipe a script into bash, downloading the .dmg from the website and
# running `xattr -cr /Applications/OpenDJ.app` after dragging it into
# Applications achieves the same result, just as two manual steps instead
# of one command.
set -euo pipefail

DMG_URL="https://github.com/illyangz/open-dj/releases/latest/download/OpenDJ-macOS.dmg"
APP_NAME="OpenDJ.app"
MOUNT_POINT="/Volumes/OpenDJ"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is for macOS only. Grab the Windows/Linux build from https://illyangz.github.io/open-dj/#cta" >&2
  exit 1
fi

tmp_dmg="$(mktemp -t opendj).dmg"
cleanup() {
  hdiutil detach "$MOUNT_POINT" -quiet -force >/dev/null 2>&1 || true
  rm -f "$tmp_dmg"
}
trap cleanup EXIT

echo "Downloading OpenDJ..."
curl -fsSL -o "$tmp_dmg" "$DMG_URL"

echo "Installing..."
hdiutil attach "$tmp_dmg" -nobrowse -quiet
pkill -f "/Applications/${APP_NAME}/Contents/MacOS/desktop" >/dev/null 2>&1 || true
rm -rf "/Applications/${APP_NAME}"
cp -R "${MOUNT_POINT}/${APP_NAME}" /Applications/

echo "Done — OpenDJ is in your Applications folder."
open "/Applications/${APP_NAME}"
