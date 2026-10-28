#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
#
# Finishes the packed macOS app before it goes into a .dmg / .zip: product version in Info.plist,
# the microphone usage string, a fresh signature. One script for both paths that build the app —
# the local scripts/release-macos.sh and the CI job in .github/workflows/release.yml — so the two
# cannot drift apart.
#
#   scripts/finish-macos-app.sh <path/to/VibeIDE.app> <X.Y.Z>
#
# Signing: ad-hoc by default; Developer ID + hardened runtime when VIBE_MAC_SIGNING_IDENTITY is set.

set -euo pipefail

APP="${1:?usage: finish-macos-app.sh <VibeIDE.app> <X.Y.Z>}"
VERSION="${2:?usage: finish-macos-app.sh <VibeIDE.app> <X.Y.Z>}"

step() { printf '\033[33m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[[ -d "$APP" ]] || die "app not found: $APP"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z without a leading v: '$VERSION'"

# Finder/Get Info must show the VibeIDE product version, not the VS Code codebase
# version. gulp-electron force-overwrites its productVersion option from the app's
# package.json (1.118.x) and the option is deprecated, so patch the plist here —
# BEFORE codesign, otherwise the signature would be invalidated. The runtime version
# (package.json / vscode.version API) intentionally stays 1.118.x for extension compat.
step "Patching Info.plist versions to $VERSION..."
/usr/libexec/PlistBuddy \
	-c "Set :CFBundleShortVersionString $VERSION" \
	-c "Set :CFBundleVersion $VERSION" \
	"$APP/Contents/Info.plist"
ok "Info.plist: CFBundleShortVersionString/CFBundleVersion = $VERSION"

# Voice input (dictation) asks for the mic — replace Electron's generic English
# usage string with a product-specific Russian one (shown in the macOS TCC prompt).
# NOTE for future hardened-runtime/notarization: add the
# com.apple.security.device.audio-input entitlement alongside this.
step 'Patching NSMicrophoneUsageDescription...'
MIC_USAGE='Микрофон нужен для голосового ввода (диктовки). Распознавание речи выполняется локально, звук никуда не отправляется.'
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription $MIC_USAGE" "$APP/Contents/Info.plist" 2> /dev/null \
	|| /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string $MIC_USAGE" "$APP/Contents/Info.plist"
ok 'Info.plist: NSMicrophoneUsageDescription (ru)'

# Apple Silicon refuses to launch binaries with an invalid signature, and gulp's
# post-processing breaks Electron's original ad-hoc one — always re-sign.
if [[ -n "${VIBE_MAC_SIGNING_IDENTITY:-}" ]]; then
	step "Codesigning with Developer ID: $VIBE_MAC_SIGNING_IDENTITY"
	codesign --force --deep --options runtime --timestamp --sign "$VIBE_MAC_SIGNING_IDENTITY" "$APP"
	echo '  (notarization is a separate manual step: scripts/notarize-macos.sh)'
else
	step 'Codesigning ad-hoc (no VIBE_MAC_SIGNING_IDENTITY — Gatekeeper will require «Open Anyway»)...'
	codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep "$APP" || die 'codesign verification failed'
ok 'Signed'
