#!/usr/bin/env bash
# release-macos.sh — Local macOS (arm64) build + GitHub Release. Bash twin of release-windows.ps1.
#
# TWO-PHASE FLOW (default working mode — build & test first, publish the SAME build after):
#   Phase 1 — bump + compile + package, NO publish (test the .app / dmg locally):
#     ./scripts/release-macos.sh -v vX.Y.Z --skip-publish
#   Phase 2 — publish the SAME tested artifacts WITHOUT recompiling:
#     ./scripts/release-macos.sh --skip-compile
#   The version stamp written into out-build during Phase 1 is verified in Phase 2, so a
#   prebuilt publish can only ship the exact version it was compiled at (no stale code).
#
# Cross-platform release: when Windows already bumped+published this version, run WITHOUT -v —
# the script builds the CURRENT product.json version (no bump) and Phase 2 UPLOADS the mac
# artifacts into the existing GitHub release for the tag instead of creating a new one.
#
# Other usage:
#   ./scripts/release-macos.sh                 # one-shot: auto-bump patch + compile + publish
#   ./scripts/release-macos.sh --draft         # create release as draft
#   ./scripts/release-macos.sh --skip-publish  # build + package artifacts only (no tag/publish)
#   ./scripts/release-macos.sh --package-only --skip-publish
#                                              # resume Phase 1 after a packaging failure: reuse the
#                                              # stamped out-build (stamp must match product.json),
#                                              # redo ONLY gulp package + sign + DMG/ZIP + smoke
#
# Artifacts: .build/darwin-arm64/VibeIDE-<ver>-darwin-arm64.dmg + .zip (DMG via hdiutil —
# build/darwin/create-dmg.ts needs Python ≥3.10 which this machine lacks; hdiutil is zero-dep).
# Signing: ad-hoc by default (Gatekeeper will require «Open Anyway» on first launch). When
# VIBE_MAC_SIGNING_IDENTITY is set, signs Developer ID + hardened runtime instead; notarization
# stays manual via scripts/notarize-macos.sh until Apple Developer credentials exist.
# Requires: fnm (Node 22.22.1 via .nvmrc), gh CLI (brew install gh), Xcode CLT.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

step() { printf '\033[33m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────
VERSION=''
SKIP_COMPILE=0
SKIP_PUBLISH=0
PACKAGE_ONLY=0
DRAFT=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		-v | --version) VERSION="${2:-}"; shift 2 ;;
		--skip-compile) SKIP_COMPILE=1; shift ;;
		--skip-publish) SKIP_PUBLISH=1; shift ;;
		--package-only) PACKAGE_ONLY=1; shift ;;
		--draft) DRAFT=1; shift ;;
		*) die "unexpected arg: $1 (use: [-v vX.Y.Z] [--skip-compile] [--skip-publish] [--package-only] [--draft])" ;;
	esac
done
# --package-only = --skip-compile for version/bump/stamp semantics, but packaging DOES run.
if [[ "$PACKAGE_ONLY" == '1' ]]; then SKIP_COMPILE=1; fi

[[ "$(uname -s)" == 'Darwin' ]] || die 'must run on macOS'
[[ "$(uname -m)" == 'arm64' ]] || die 'arm64-only pipeline for now (Universal Binary deferred — see build-macos-universal.sh)'

# ── Pin the project's Node (.nvmrc) via fnm — same rationale as run-dev.sh ────
NODE_VER="$(tr -d '[:space:]' < "$ROOT/.nvmrc" 2> /dev/null || echo 22.22.1)"
NODE_DIR=''
for fnm_root in "${FNM_DIR:-}" "$HOME/Library/Application Support/fnm" "$HOME/.fnm" "${XDG_DATA_HOME:-$HOME/.local/share}/fnm"; do
	[[ -n "$fnm_root" && -x "$fnm_root/node-versions/v$NODE_VER/installation/bin/npm" ]] || continue
	NODE_DIR="$fnm_root/node-versions/v$NODE_VER/installation/bin"
	break
done
if [[ -z "$NODE_DIR" ]] && command -v fnm > /dev/null 2>&1; then
	NODE_DIR="$(fnm exec --using "$NODE_VER" node -e "process.stdout.write(require('path').dirname(process.execPath))" 2> /dev/null || true)"
fi
[[ -n "$NODE_DIR" ]] || die "pinned Node $NODE_VER not found via fnm — run: brew install fnm && fnm install $NODE_VER"
export PATH="$NODE_DIR:$PATH"
ok "pinned Node $NODE_VER"

command -v gh > /dev/null 2>&1 || { [[ "$SKIP_PUBLISH" == '1' ]] || die 'gh CLI not found (brew install gh) — required to publish'; }

BUILD_STARTED_AT="$(date +%s)"

# ── Version (mirror of release-windows.ps1 semantics) ─────────────────────────
current_vibe() { node -p "require('$ROOT/product.json').vibeVersion"; }
write_vibe() {
	# sed -E in-place keeps the rest of product.json byte-identical (same as the ps1 regex).
	sed -E -i '' "s/\"vibeVersion\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"vibeVersion\": \"$1\"/" "$ROOT/product.json"
}

OLD_VIBE="$(current_vibe)"
if [[ -z "$VERSION" ]]; then
	if [[ "$SKIP_PUBLISH" == '1' || "$SKIP_COMPILE" == '1' ]]; then
		# Build/publish at the CURRENT product.json version — no auto-bump (repeatable test
		# builds; two-phase publish reuses the Phase-1 version so the stamp check holds).
		NEW_VIBE="$OLD_VIBE"
		VERSION="v$NEW_VIBE"
		ok "Using current vibeVersion: $NEW_VIBE (no auto-bump)"
	else
		NEW_VIBE="$(node -p "const p='$OLD_VIBE'.split('.'); p[2]=String(Number(p[2])+1); p.join('.')")"
		VERSION="v$NEW_VIBE"
		write_vibe "$NEW_VIBE"
		ok "Bumped vibeVersion: $OLD_VIBE → $NEW_VIBE (product.json updated)"
		git add "$ROOT/product.json"
		git commit -m "chore: bump version to $NEW_VIBE"
		git push
	fi
else
	[[ "$VERSION" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || die "Version must be vX.Y.Z (got: $VERSION)"
	NEW_VIBE="${BASH_REMATCH[1]}"
	if [[ "$OLD_VIBE" != "$NEW_VIBE" ]]; then
		write_vibe "$NEW_VIBE"
		ok "Set vibeVersion: $OLD_VIBE → $NEW_VIBE (product.json updated)"
		git add "$ROOT/product.json"
		git commit -m "chore: bump version to $NEW_VIBE"
		git push
	fi
fi

# ── Release-readiness guard (same two silent-miss traps as Windows) ───────────
grep -q "'$NEW_VIBE'[[:space:]]*:" "$ROOT/src/vs/workbench/contrib/vibeide/common/vibeWhatsNew.ts" \
	|| die "RELEASE STEP пропущен: нет записи «Что нового» для $NEW_VIBE в vibeWhatsNew.ts (WHATS_NEW_BY_VERSION['$NEW_VIBE'])."
grep -q "badge/версия-$NEW_VIBE-" "$ROOT/README.md" \
	|| die "RELEASE STEP пропущен: бейдж версии в README.md не равен $NEW_VIBE."
ok "Release-readiness guard passed (What's New + README-бейдж для $NEW_VIBE)"

printf '\n\033[36m🚀 Building VibeIDE %s for macOS arm64\033[0m\n\n' "$VERSION"

gulp_task() { node --max-old-space-size=8192 "$ROOT/node_modules/gulp/bin/gulp.js" "$1"; }

# ── 0. Pre-build steps (mirror of the Windows script) ─────────────────────────
if [[ "$SKIP_COMPILE" != '1' ]]; then
	step 'Extracting VibeIDE NLS strings...'
	gulp_task extract-vibeide-locale-strings || echo '⚠ NLS extraction failed (non-fatal)'

	step 'Regenerating embedded artifacts (.vibe-defaults, specs help)...'
	npm run gen:all

	step 'Rebuilding React tree (scope-tailwind + tsup)...'
	npm run buildreact

	step 'Compiling TypeScript (npm run compile-build)...'
	npm run compile-build
	# Stamp out-build with the version it was compiled at — Phase 2 verifies this.
	printf '%s' "$NEW_VIBE" > "$ROOT/out-build/.vibe-build-version"
	ok "Stamped out-build version: $NEW_VIBE"
else
	echo '⏭ Skipping compile (--skip-compile) — will verify out-build version stamp before publishing'
fi

# ── 1. Freshness / stamp guards (mirror of the Windows script) ────────────────
FRESHNESS_PROBE="$ROOT/out-build/vs/code/electron-main/main.js"
[[ -f "$FRESHNESS_PROBE" ]] || die "Freshness probe missing: $FRESHNESS_PROBE — out-build/ absent or incomplete. Run a full build (drop --skip-compile)."

if [[ "$SKIP_COMPILE" == '1' && ( "$SKIP_PUBLISH" != '1' || "$PACKAGE_ONLY" == '1' ) ]]; then
	STAMP_PATH="$ROOT/out-build/.vibe-build-version"
	[[ -f "$STAMP_PATH" ]] || die "--skip-compile/--package-only blocked: version stamp missing — run Phase 1 first: ./scripts/release-macos.sh -v $VERSION --skip-publish"
	STAMPED="$(cat "$STAMP_PATH")"
	[[ "$STAMPED" == "$NEW_VIBE" ]] || die "--skip-compile/--package-only blocked: out-build compiled at $STAMPED, current version $NEW_VIBE. Redo Phase 1 at $NEW_VIBE."
	ok "Prebuilt out-build verified: stamp matches $NEW_VIBE"
fi

PROBE_MTIME="$(stat -f %m "$FRESHNESS_PROBE")"
if (( PROBE_MTIME < BUILD_STARTED_AT )); then
	if [[ "$SKIP_PUBLISH" == '1' ]]; then
		echo "⚠ out-build probe older than this run — allowed for --skip-publish test build (package may contain stale code)"
	elif [[ "$SKIP_COMPILE" == '1' ]]; then
		echo '  (out-build from a prior Phase-1 build; version stamp verified above)'
	else
		die 'out-build was NOT recompiled this run — refusing to package/publish stale code.'
	fi
else
	ok 'Freshness verified: out-build recompiled this run'
fi

# ── 2. Package macOS arm64 app + artifacts ────────────────────────────────────
APP_DIR="$(dirname "$ROOT")/VibeIDE-darwin-arm64"
APP="$APP_DIR/VibeIDE.app"
ARTIFACT_DIR="$ROOT/.build/darwin-arm64"
DMG_PATH="$ARTIFACT_DIR/VibeIDE-$NEW_VIBE-darwin-arm64.dmg"
ZIP_PATH="$ARTIFACT_DIR/VibeIDE-$NEW_VIBE-darwin-arm64.zip"

if [[ "$SKIP_COMPILE" != '1' || "$PACKAGE_ONLY" == '1' ]]; then
	step 'Building macOS arm64 app (gulp vscode-darwin-arm64)...'
	gulp_task vscode-darwin-arm64
	[[ -d "$APP" ]] || die "app bundle not found after gulp: $APP"
	ok "App built: $APP"

	# Finder/Get Info must show the VibeIDE product version, not the VS Code codebase
	# version. gulp-electron force-overwrites its productVersion option from the app's
	# package.json (1.118.x) and the option is deprecated, so patch the plist here —
	# BEFORE codesign, otherwise the signature would be invalidated. The runtime version
	# (package.json / vscode.version API) intentionally stays 1.118.x for extension compat.
	step "Patching Info.plist versions to $NEW_VIBE..."
	/usr/libexec/PlistBuddy \
		-c "Set :CFBundleShortVersionString $NEW_VIBE" \
		-c "Set :CFBundleVersion $NEW_VIBE" \
		"$APP/Contents/Info.plist"
	ok "Info.plist: CFBundleShortVersionString/CFBundleVersion = $NEW_VIBE"

	# Voice input (dictation) asks for the mic — replace Electron's generic English
	# usage string with a product-specific Russian one (shown in the macOS TCC prompt).
	# NOTE for future hardened-runtime/notarization: add the
	# com.apple.security.device.audio-input entitlement alongside this.
	step 'Patching NSMicrophoneUsageDescription...'
	MIC_USAGE='Микрофон нужен для голосового ввода (диктовки). Распознавание речи выполняется локально, звук никуда не отправляется.'
	/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription $MIC_USAGE" "$APP/Contents/Info.plist" 2>/dev/null \
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

	mkdir -p "$ARTIFACT_DIR"
	rm -f "$ARTIFACT_DIR"/VibeIDE-*-darwin-arm64.dmg "$ARTIFACT_DIR"/VibeIDE-*-darwin-arm64.zip

	step 'Building DMG (hdiutil)...'
	DMG_STAGE="$(mktemp -d)"
	trap 'rm -rf "$DMG_STAGE"' EXIT
	ditto "$APP" "$DMG_STAGE/VibeIDE.app"
	ln -s /Applications "$DMG_STAGE/Applications"
	hdiutil create -volname 'VibeIDE' -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH" > /dev/null
	ok "DMG built: $DMG_PATH"

	step 'Building portable ZIP (ditto, preserves signatures/xattrs)...'
	ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP_PATH"
	ok "ZIP built: $ZIP_PATH"
fi

[[ -f "$DMG_PATH" && -f "$ZIP_PATH" ]] || die "artifacts for $NEW_VIBE not found in $ARTIFACT_DIR — run Phase 1 first"

# ── 2b. Smoke check — the built app must answer --version ─────────────────────
step 'Smoke-checking built application...'
SMOKE_OUT="$("$APP/Contents/Resources/app/bin/vibeide" --version 2> /dev/null || "$APP/Contents/Resources/app/bin/code" --version 2> /dev/null || true)"
if [[ -n "$SMOKE_OUT" ]]; then
	ok "Smoke check passed: $(echo "$SMOKE_OUT" | tr '\n' ' ')"
else
	die 'Smoke check FAILED: app CLI produced no output (bin/vibeide and bin/code both failed)'
fi

if [[ "$SKIP_PUBLISH" == '1' ]]; then
	ok 'Test build complete (--skip-publish): tag + GitHub release SKIPPED.'
	printf '\n\033[36m📦 Artifacts ready for manual smoke-test:\033[0m\n   %s\n   %s\n' "$DMG_PATH" "$ZIP_PATH"
	printf '\n   To publish the SAME build: ./scripts/release-macos.sh --skip-compile\n\n'
	exit 0
fi

# ── 3. Git tag ────────────────────────────────────────────────────────────────
step "Creating git tag $VERSION..."
if [[ -n "$(git tag -l "$VERSION")" ]]; then
	echo "  Tag $VERSION already exists, skipping"
else
	git tag "$VERSION"
	git push origin "$VERSION"
	ok "Tag $VERSION pushed"
fi

# ── 4. GitHub Release: create, or upload into the existing one (Windows first) ─
if gh release view "$VERSION" > /dev/null 2>&1; then
	step "Release $VERSION exists — uploading mac artifacts into it..."
	gh release upload "$VERSION" "$DMG_PATH" "$ZIP_PATH"
else
	step "Creating GitHub Release $VERSION..."
	DRAFT_ARGS=()
	if [[ "$DRAFT" == '1' ]]; then DRAFT_ARGS+=(--draft); fi
	# ${arr[@]+...} guard: empty-array expansion under `set -u` errors on macOS bash 3.2
	gh release create "$VERSION" --title "VibeIDE $VERSION" --generate-notes ${DRAFT_ARGS[@]+"${DRAFT_ARGS[@]}"} "$DMG_PATH" "$ZIP_PATH"
fi

ok "Release $VERSION published!"
printf '\n\033[36m🎉 Done! https://github.com/VibeBrains/VibeIDE/releases/tag/%s\033[0m\n\n' "$VERSION"
