#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
#
# Builds the VibeIDE installer image with a designed window: our background, the app on the left,
# /Applications on the right, and the first-run line for an unsigned build.
#
#   scripts/build-dmg-macos.sh <path/to/VibeIDE.app> <path/to/output.dmg>
#
# WHY a designed window at all: a bare image opens as a file list and never says that one item is
# meant to be dragged onto the other. The window IS the instruction — and for an unsigned build it is
# also the only place that tells people to open the app with a right click instead of deleting it.
#
# WHY this order (read-write image → layout → compress): icon positions and the background
# live in the volume's .DS_Store. Laid out on a read-only volume the layout is lost without an error,
# and the image opens as a list on the recipient's machine.
#
# Beyond the system (hdiutil, ditto, tiffutil, PlistBuddy) it needs two tools: rsvg-convert
# (brew install librsvg), which draws the background with the build's version, and a pinned Python
# venv with ds_store/mac_alias that writes the .DS_Store headlessly. The venv is bootstrapped
# automatically from scripts/dmg/requirements.txt; set VIBE_DMG_LAYOUT_VENV to use an existing venv.
# The upstream create-dmg.ts path needs Python ≥3.10 and a dmgbuild checkout; this script is what the
# macOS release actually runs.
#
# The shared mechanics come from the `dmg-installer` skill; the look is VibeIDE's own.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?usage: build-dmg-macos.sh <VibeIDE.app> <output.dmg>}"
DMG_PATH="${2:?usage: build-dmg-macos.sh <VibeIDE.app> <output.dmg>}"

VOLUME_NAME='VibeIDE'
APP_NAME="$(basename "$APP")"
BACKGROUND_SVG="$ROOT/build/darwin/dmg-background.svg"

# ── Window geometry ─────────────────────────────────────────────────────────────────────────────
# These numbers and build/darwin/dmg-background.svg are two halves of one layout: the background
# draws the pulse between the icons and a plaque under each label at exactly these points. Move one
# without the other and the arrow points at nothing.
WINDOW_WIDTH=480          # content width, = SVG width
WINDOW_HEIGHT=352         # content height, = SVG height
TITLE_BAR=28              # Finder bounds include the title bar; the visible content does not
ICON_SIZE=80
TEXT_SIZE=12
APP_X=120; APP_Y=160      # = the app's plaque and the pulse start in dmg-background.svg
APPS_X=360; APPS_Y=160    # = the Applications plaque and the arrow head in dmg-background.svg
# A Finder that shows hidden files shows .background too, and on its own it lands in the first free
# slot — over the wordmark. Below the canvas it costs such a viewer a scroll bar at the right edge,
# clear of the version and of the first-run line; a viewer with hidden files hidden sees neither.
BACKGROUND_FOLDER_Y=$((WINDOW_HEIGHT + 150))

[[ -d "$APP" ]] || { echo "build-dmg-macos: app not found: $APP" >&2; exit 1; }
[[ -f "$BACKGROUND_SVG" ]] || { echo "build-dmg-macos: background not found: $BACKGROUND_SVG" >&2; exit 1; }
command -v rsvg-convert > /dev/null 2>&1 || { echo "build-dmg-macos: rsvg-convert not found (brew install librsvg) — it draws the background" >&2; exit 1; }
command -v python3 > /dev/null 2>&1 || { echo "build-dmg-macos: python3 not found — required to bootstrap the layout venv" >&2; exit 1; }

VIBE_DMG_LAYOUT_VENV="${VIBE_DMG_LAYOUT_VENV:-$ROOT/.build/dmg-layout-venv}"
LAYOUT_PYTHON="$VIBE_DMG_LAYOUT_VENV/bin/python"

ensure_layout_venv() {
    [[ -x "$LAYOUT_PYTHON" ]] && return 0
    echo "build-dmg-macos: creating layout venv at $VIBE_DMG_LAYOUT_VENV..."
    python3 -m venv "$VIBE_DMG_LAYOUT_VENV"
    "$VIBE_DMG_LAYOUT_VENV/bin/pip" install --quiet -r "$ROOT/scripts/dmg/requirements.txt"
}

STAGE="$(mktemp -d)"
RENDER="$(mktemp -d)"
RW_DMG="$(mktemp -u).dmg"
MOUNT_POINT=''
cleanup() {
	if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
		hdiutil detach "$MOUNT_POINT" -force > /dev/null 2>&1 || true
	fi
	rm -rf "$STAGE" "$RENDER" "$RW_DMG"
}
trap cleanup EXIT

# ── 0. Draw the background with this build's version ────────────────────────────────────────────
# Several images of different builds lie side by side; which one is newer must show in the window
# itself. The number is the packed app's own version, so the window names the build inside the image
# by construction, and it is read here rather than passed in: an argument to remember on every release
# is one that gets forgotten. Drawn for every image — a committed picture keeps showing the version it
# was drawn for.
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2> /dev/null || true)"
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || { echo "build-dmg-macos: no usable CFBundleShortVersionString in $APP: '$VERSION'" >&2; exit 1; }
[[ "$(grep -c '__VERSION__' "$BACKGROUND_SVG")" == '1' ]] || { echo "build-dmg-macos: $BACKGROUND_SVG must carry the __VERSION__ placeholder exactly once" >&2; exit 1; }
sed "s/__VERSION__/$VERSION/" "$BACKGROUND_SVG" > "$RENDER/background.svg"
rsvg-convert -w "$WINDOW_WIDTH" -h "$WINDOW_HEIGHT" -o "$RENDER/background-1x.png" "$RENDER/background.svg"
rsvg-convert -w $((WINDOW_WIDTH * 2)) -h $((WINDOW_HEIGHT * 2)) -o "$RENDER/background-2x.png" "$RENDER/background.svg"
# One TIFF with both pages: Finder takes the 2x page on a Retina screen, and 1x alone is blurry there.
BACKGROUND="$RENDER/background.tiff"
# tiffutil reports success on stderr; its words are shown only when it fails.
TIFF_LOG="$(tiffutil -cathidpicheck "$RENDER/background-1x.png" "$RENDER/background-2x.png" -out "$BACKGROUND" 2>&1)" \
	|| { echo "build-dmg-macos: tiffutil failed: $TIFF_LOG" >&2; exit 1; }

# ── 1. Stage and create a read-write image ──────────────────────────────────────────────────────
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"
mkdir "$STAGE/.background"
cp "$BACKGROUND" "$STAGE/.background/background.tiff"

hdiutil create -volname "$VOLUME_NAME" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$RW_DMG" > /dev/null

# ── 2. Mount and write the layout headlessly ────────────────────────────────────────────────────
# Finder is not scripted: the .DS_Store is written by ds_store/mac_alias. Mount read-write and
# keep it off the desktop (-nobrowse) so Finder cannot overwrite the layout before compression.
MOUNT_POINT="$(hdiutil attach "$RW_DMG" -readwrite -nobrowse -noverify -noautoopen | awk -F'\t' '/\/Volumes\// { print $NF; exit }')"
[[ -d "$MOUNT_POINT" ]] || { echo "build-dmg-macos: could not mount the read-write image" >&2; exit 1; }

# Headless layout writer: ds_store + mac_alias write the same records Finder would, without
# scripting Finder. See scripts/dmg/layout.py and the dmg-installer skill.
ensure_layout_venv

"$LAYOUT_PYTHON" "$ROOT/scripts/dmg/layout.py" write "$MOUNT_POINT" \
	--app "$APP_NAME" \
	--window-width "$WINDOW_WIDTH" \
	--window-height "$WINDOW_HEIGHT" \
	--title-bar "$TITLE_BAR" \
	--icon-size "$ICON_SIZE" \
	--app-position "$APP_X,$APP_Y" \
	--applications-position "$APPS_X,$APPS_Y" \
	--background-folder-position "$APP_X,$BACKGROUND_FOLDER_Y"
echo "build-dmg-macos: layout written for $APP_NAME"

# The read-write mount made the system start an event log on the volume. It is not part of the product,
# and a viewer who shows hidden files would find it lying in the window.
rm -rf "$MOUNT_POINT/.fseventsd"
sync
hdiutil detach "$MOUNT_POINT" > /dev/null
MOUNT_POINT=''

# ── 3. Compress into the image we ship ──────────────────────────────────────────────────────────
rm -f "$DMG_PATH"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" > /dev/null

# ── 4. Gate: the shipped image carries the background drawn for it, and the app it names ─────────
# Unit tests and the branding gate never see a picture inside an image. A stock background went
# unnoticed exactly that way, so the compressed artifact is mounted and compared byte for byte, and the
# version of the app inside is checked against the number on the background.
MOUNT_POINT="$(hdiutil attach "$DMG_PATH" -readonly -nobrowse -noverify -noautoopen | awk -F'\t' '/\/Volumes\// { print $NF; exit }')"
[[ -d "$MOUNT_POINT" ]] || { echo "build-dmg-macos: could not mount the compressed image for verification" >&2; exit 1; }
SHIPPED="$MOUNT_POINT/.background/background.tiff"
if [[ ! -f "$SHIPPED" ]] || [[ "$(shasum -a 256 < "$SHIPPED")" != "$(shasum -a 256 < "$BACKGROUND")" ]]; then
	echo "build-dmg-macos: the image does not carry the background drawn for this build" >&2
	exit 1
fi
SHIPPED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$MOUNT_POINT/$APP_NAME/Contents/Info.plist" 2> /dev/null || true)"
if [[ "$SHIPPED_VERSION" != "$VERSION" ]]; then
	echo "build-dmg-macos: the background says $VERSION, the app inside the image is '$SHIPPED_VERSION'" >&2
	exit 1
fi
if [[ ! -f "$MOUNT_POINT/.DS_Store" ]]; then
	echo "build-dmg-macos: the image has no Finder layout (.DS_Store missing) — it would open as a file list" >&2
	exit 1
fi
"$LAYOUT_PYTHON" "$ROOT/scripts/dmg/layout.py" check "$MOUNT_POINT" \
	--app "$APP_NAME" \
	--window-width "$WINDOW_WIDTH" \
	--window-height "$WINDOW_HEIGHT" \
	--title-bar "$TITLE_BAR" \
	--icon-size "$ICON_SIZE" \
	--app-position "$APP_X,$APP_Y" \
	--applications-position "$APPS_X,$APPS_Y" \
	--background-folder-position "$APP_X,$BACKGROUND_FOLDER_Y"
hdiutil detach "$MOUNT_POINT" > /dev/null
MOUNT_POINT=''

echo "build-dmg-macos: $DMG_PATH"
