#!/usr/bin/env bash
# release-linux.sh — Linux (x64 + arm64) build + GitHub Release. Bash twin of
# release-windows.ps1 / release-macos.sh, adapted to the Linux packaging toolchain.
#
# FORMATS: .deb (Debian/Ubuntu/Mint…), .rpm (Fedora/RHEL/openSUSE…),
#          .AppImage (portable, any distro), .tar.gz (portable archive).
# Four artefact types × {x64, arm64} cover essentially every distribution — you do
# NOT build one package per distro.
#
# WHERE THIS RUNS
#   The deb/rpm toolchain (dpkg-deb, rpmbuild, fakeroot) is Linux-only. Two paths:
#     • On Linux  → native build (primary path). No Docker.
#     • On macOS/Windows(Git-Bash) OR with --docker → the heavy build is delegated
#       into an Ubuntu container running this same script (VIBE_LINUX_IN_DOCKER=1).
#       This is how you build Linux artefacts from a Windows box or a beefier Mac
#       later; it needs Docker installed. On a low-RAM machine prefer a real Linux host.
#
# TWO-PHASE FLOW (default working mode — build & test first, publish the SAME build):
#   Phase 1 — bump + compile + package, NO publish (test the artefacts):
#     ./scripts/release-linux.sh -v vX.Y.Z --skip-publish
#   Phase 2 — publish the SAME tested artefacts WITHOUT recompiling:
#     ./scripts/release-linux.sh --skip-compile
#   The version stamp written into out-build during Phase 1 is verified in Phase 2,
#   so a prebuilt publish can only ship the exact version it was compiled at.
#
# Cross-platform release: when Windows/macOS already bumped+published this version,
# run WITHOUT -v — the script builds the CURRENT product.json version (no bump) and
# Phase 2 UPLOADS the Linux artefacts into the existing GitHub release for the tag.
#
# Other usage:
#   ./scripts/release-linux.sh                 # one-shot: auto-bump patch + compile + publish
#   ./scripts/release-linux.sh --draft         # create release as draft
#   ./scripts/release-linux.sh --arch x64      # limit to a single arch (default: x64,arm64)
#   ./scripts/release-linux.sh --docker        # force the Docker build path
#
# Signing: optional (mirror of VIBE_MAC_SIGNING_IDENTITY). When VIBE_GPG_KEY_ID is set,
# each artefact gets a detached ASCII signature (<file>.asc) via gpg; otherwise artefacts
# ship unsigned with a warning. Provision the maintainer key once (gpg --gen-key + upload
# the public half to keys.openpgp.org) to enable signed releases.
#
# Requires (Linux host): dpkg-deb, fakeroot, rpmbuild, appimagetool, tar, gh CLI, and a
#   cross toolchain (gcc-aarch64-linux-gnu) when building arm64 from an x64 host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

step() { printf '\033[33m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────
VERSION=''
SKIP_COMPILE=0
SKIP_PUBLISH=0
DRAFT=0
FORCE_DOCKER=0
ARCH_ARG=''
while [[ $# -gt 0 ]]; do
	case "$1" in
		-v | --version) VERSION="${2:-}"; shift 2 ;;
		--skip-compile) SKIP_COMPILE=1; shift ;;
		--skip-publish) SKIP_PUBLISH=1; shift ;;
		--draft) DRAFT=1; shift ;;
		--docker) FORCE_DOCKER=1; shift ;;
		--arch) ARCH_ARG="${2:-}"; shift 2 ;;
		*) die "unexpected arg: $1 (use: [-v vX.Y.Z] [--skip-compile] [--skip-publish] [--draft] [--docker] [--arch x64,arm64])" ;;
	esac
done

# Architectures to build (default: both). Comma-separated, validated below.
ARCHES=('x64' 'arm64')
if [[ -n "$ARCH_ARG" ]]; then
	IFS=',' read -r -a ARCHES <<< "$ARCH_ARG"
	for a in "${ARCHES[@]}"; do
		[[ "$a" == 'x64' || "$a" == 'arm64' ]] || die "unsupported --arch '$a' (allowed: x64, arm64)"
	done
fi

# ── Docker delegation (non-Linux hosts, or forced) ────────────────────────────
# deb/rpm packaging can't run natively off Linux. Re-run this exact script inside an
# Ubuntu container with the repo mounted. Host node_modules are the wrong platform, so
# the container does a fresh `npm ci` before building. VIBE_LINUX_IN_DOCKER guards against
# infinite recursion (the in-container run never re-delegates).
HOST_OS="$(uname -s)"
if [[ "${VIBE_LINUX_IN_DOCKER:-0}" != '1' ]] && { [[ "$HOST_OS" != 'Linux' ]] || [[ "$FORCE_DOCKER" == '1' ]]; }; then
	command -v docker > /dev/null 2>&1 || die "cross-building Linux from $HOST_OS needs Docker (not found). Install Docker Desktop, or run this script on a Linux host."
	docker info > /dev/null 2>&1 || die 'Docker is installed but not running — start it and retry.'
	[[ "$SKIP_PUBLISH" == '1' ]] || warn 'Publishing from inside Docker needs gh auth + a git identity in the container; --skip-publish (Phase 1) is the intended Docker mode. Continuing.'
	step "Delegating Linux build into Ubuntu container (host: $HOST_OS)..."
	# Forward publish-related env; mount the repo read-write at /work.
	docker run --rm -it \
		-v "$ROOT:/work" -w /work \
		-e VIBE_LINUX_IN_DOCKER=1 \
		-e VIBE_GPG_KEY_ID="${VIBE_GPG_KEY_ID:-}" \
		-e GH_TOKEN="${GH_TOKEN:-}" \
		ubuntu:22.04 bash -c '
			set -e
			export DEBIAN_FRONTEND=noninteractive
			apt-get update
			apt-get install -y curl git build-essential fakeroot rpm dpkg-dev \
				libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python3 \
				gcc-aarch64-linux-gnu g++-aarch64-linux-gnu file
			# appimagetool (FUSE-less extraction so it works in a container)
			curl -fsSL -o /usr/local/bin/appimagetool \
				https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
			chmod +x /usr/local/bin/appimagetool
			# Node via the repo .nvmrc
			curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
			export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
			nvm install "$(cat .nvmrc)"
			npm ci
			exec bash scripts/release-linux.sh '"$*"'
		' "$@"
	exit $?
fi

# ── From here on: we are on Linux (native or inside the container) ────────────
[[ "$(uname -s)" == 'Linux' ]] || die 'internal: reached native section off Linux'

# ── Pin the project's Node (.nvmrc) via fnm/nvm when available ─────────────────
NODE_VER="$(tr -d '[:space:]' < "$ROOT/.nvmrc" 2> /dev/null || echo 22.22.1)"
NODE_DIR=''
for fnm_root in "${FNM_DIR:-}" "${XDG_DATA_HOME:-$HOME/.local/share}/fnm" "$HOME/.fnm"; do
	[[ -n "$fnm_root" && -x "$fnm_root/node-versions/v$NODE_VER/installation/bin/npm" ]] || continue
	NODE_DIR="$fnm_root/node-versions/v$NODE_VER/installation/bin"
	break
done
if [[ -z "$NODE_DIR" ]] && command -v fnm > /dev/null 2>&1; then
	NODE_DIR="$(fnm exec --using "$NODE_VER" node -e "process.stdout.write(require('path').dirname(process.execPath))" 2> /dev/null || true)"
fi
if [[ -n "$NODE_DIR" ]]; then
	export PATH="$NODE_DIR:$PATH"
	ok "pinned Node $NODE_VER"
else
	command -v node > /dev/null 2>&1 || die "Node not found and fnm has no pinned $NODE_VER — install Node $NODE_VER"
	warn "fnm-pinned Node $NODE_VER not found — using system node $(node --version)"
fi

# ── Toolchain presence checks (fail fast with install hints) ──────────────────
require_tool() { command -v "$1" > /dev/null 2>&1 || die "required tool '$1' not found — $2"; }
require_tool dpkg-deb 'install: apt-get install dpkg-dev'
require_tool fakeroot 'install: apt-get install fakeroot'
require_tool rpmbuild 'install: apt-get install rpm (Debian/Ubuntu) or rpm-build (Fedora)'
require_tool appimagetool 'download from https://github.com/AppImage/AppImageKit/releases (continuous) and put on PATH'
require_tool tar 'install: apt-get install tar'
command -v gh > /dev/null 2>&1 || { [[ "$SKIP_PUBLISH" == '1' ]] || die 'gh CLI not found — required to publish (or use --skip-publish)'; }

# arm64 from an x64 host needs a cross toolchain; drop arm64 (with a loud warning) if absent.
HOST_ARCH="$(uname -m)"
FINAL_ARCHES=()
for a in "${ARCHES[@]}"; do
	if [[ "$a" == 'arm64' && "$HOST_ARCH" != 'aarch64' && "$HOST_ARCH" != 'arm64' ]]; then
		if ! command -v aarch64-linux-gnu-gcc > /dev/null 2>&1; then
			warn "SKIPPING arm64: cross toolchain missing (install: apt-get install gcc-aarch64-linux-gnu g++-aarch64-linux-gnu). arm64 artefacts will NOT be produced."
			continue
		fi
	fi
	FINAL_ARCHES+=("$a")
done
[[ ${#FINAL_ARCHES[@]} -gt 0 ]] || die 'no buildable architectures remain'
ok "Building architectures: ${FINAL_ARCHES[*]}"

BUILD_STARTED_AT="$(date +%s)"

# ── Version (mirror of release-windows.ps1 / release-macos.sh semantics) ──────
current_vibe() { node -p "require('$ROOT/product.json').vibeVersion"; }
write_vibe() {
	sed -E -i "s/\"vibeVersion\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"vibeVersion\": \"$1\"/" "$ROOT/product.json"
}

OLD_VIBE="$(current_vibe)"
if [[ -z "$VERSION" ]]; then
	if [[ "$SKIP_PUBLISH" == '1' || "$SKIP_COMPILE" == '1' ]]; then
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

# ── Release-readiness guard (same two silent-miss traps as Windows/macOS) ─────
grep -q "'$NEW_VIBE'[[:space:]]*:" "$ROOT/src/vs/workbench/contrib/vibeide/common/vibeWhatsNew.ts" \
	|| die "RELEASE STEP пропущен: нет записи «Что нового» для $NEW_VIBE в vibeWhatsNew.ts (WHATS_NEW_BY_VERSION['$NEW_VIBE'])."
grep -q "badge/версия-$NEW_VIBE-" "$ROOT/README.md" \
	|| die "RELEASE STEP пропущен: бейдж версии в README.md не равен $NEW_VIBE."
ok "Release-readiness guard passed (What's New + README-бейдж для $NEW_VIBE)"

printf '\n\033[36m🚀 Building VibeIDE %s for Linux [%s]\033[0m\n\n' "$VERSION" "${FINAL_ARCHES[*]}"

gulp_task() { node --max-old-space-size=8192 "$ROOT/node_modules/gulp/bin/gulp.js" "$1"; }

# ── product.json values needed for AppImage / naming ──────────────────────────
APP_NAME="$(node -p "require('$ROOT/product.json').applicationName")"   # vibeide
NAME_LONG="$(node -p "require('$ROOT/product.json').nameLong")"         # VibeIDE
ICON_NAME="$(node -p "require('$ROOT/product.json').linuxIconName")"    # vibeide
URL_PROTO="$(node -p "require('$ROOT/product.json').urlProtocol")"      # vibeide

BUILD_ROOT="$(dirname "$ROOT")"                 # gulp packages into ../VibeIDE-linux-<arch>
ARTIFACT_DIR="$ROOT/.build/linux"

deb_arch() { case "$1" in x64) echo amd64 ;; arm64) echo arm64 ;; esac; }
rpm_arch() { case "$1" in x64) echo x86_64 ;; arm64) echo aarch64 ;; esac; }
appimage_arch() { case "$1" in x64) echo x86_64 ;; arm64) echo aarch64 ;; esac; }

# ── 0. Pre-build steps (mirror of Windows/macOS) ──────────────────────────────
if [[ "$SKIP_COMPILE" != '1' ]]; then
	step 'Extracting VibeIDE NLS strings...'
	gulp_task extract-vibeide-locale-strings || echo '⚠ NLS extraction failed (non-fatal)'

	step 'Regenerating embedded artifacts (.vibe-defaults, specs help)...'
	npm run gen:all

	step 'Rebuilding React tree (scope-tailwind + tsup)...'
	npm run buildreact

	step 'Compiling TypeScript (npm run compile-build)...'
	npm run compile-build
	printf '%s' "$NEW_VIBE" > "$ROOT/out-build/.vibe-build-version"
	ok "Stamped out-build version: $NEW_VIBE"
else
	echo '⏭ Skipping compile (--skip-compile) — will verify out-build version stamp before publishing'
fi

# ── 1. Freshness / stamp guards (mirror of Windows/macOS) ─────────────────────
FRESHNESS_PROBE="$ROOT/out-build/vs/code/electron-main/main.js"
[[ -f "$FRESHNESS_PROBE" ]] || die "Freshness probe missing: $FRESHNESS_PROBE — out-build/ absent or incomplete. Run a full build (drop --skip-compile)."

if [[ "$SKIP_COMPILE" == '1' && "$SKIP_PUBLISH" != '1' ]]; then
	STAMP_PATH="$ROOT/out-build/.vibe-build-version"
	[[ -f "$STAMP_PATH" ]] || die "--skip-compile blocked: version stamp missing — run Phase 1 first: ./scripts/release-linux.sh -v $VERSION --skip-publish"
	STAMPED="$(cat "$STAMP_PATH")"
	[[ "$STAMPED" == "$NEW_VIBE" ]] || die "--skip-compile blocked: out-build compiled at $STAMPED, current version $NEW_VIBE. Redo Phase 1 at $NEW_VIBE."
	ok "Prebuilt out-build verified: stamp matches $NEW_VIBE"
fi

PROBE_MTIME="$(stat -c %Y "$FRESHNESS_PROBE")"
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

# ── 2. Package each architecture: app dir → deb/rpm/AppImage/tar.gz ───────────
# Build AppImage from the packaged tree. FUSE-less (appimagetool -n) so it runs in
# containers; the resulting AppImage still needs FUSE at the USER's runtime.
build_appimage() {
	local arch="$1" appdir="$2" out="$3"
	rm -rf "$appdir"
	mkdir -p "$appdir/usr/bin" "$appdir/usr/share/applications" "$appdir/usr/share/icons/hicolor/512x512/apps"
	cp -a "$BUILD_ROOT/VibeIDE-linux-$arch/." "$appdir/usr/bin/"
	cp "$ROOT/resources/linux/code.png" "$appdir/$ICON_NAME.png"
	cp "$ROOT/resources/linux/code.png" "$appdir/usr/share/icons/hicolor/512x512/apps/$ICON_NAME.png"
	# Minimal, self-contained desktop entry (product-branded via product.json values).
	cat > "$appdir/$APP_NAME.desktop" <<-DESKTOP
		[Desktop Entry]
		Name=$NAME_LONG
		Comment=$NAME_LONG
		GenericName=Text Editor
		Exec=$APP_NAME %F
		Icon=$ICON_NAME
		Type=Application
		StartupNotify=true
		StartupWMClass=$NAME_LONG
		Categories=TextEditor;Development;IDE;
		MimeType=x-scheme-handler/$URL_PROTO;
		Keywords=$APP_NAME;
	DESKTOP
	cp "$appdir/$APP_NAME.desktop" "$appdir/usr/share/applications/"
	cat > "$appdir/AppRun" <<-APPRUN
		#!/bin/bash
		HERE="\$(dirname "\$(readlink -f "\${0}")")"
		export PATH="\${HERE}/usr/bin:\${PATH}"
		exec "\${HERE}/usr/bin/$APP_NAME" --no-sandbox "\$@"
	APPRUN
	chmod +x "$appdir/AppRun"
	ARCH="$(appimage_arch "$arch")" appimagetool -n "$appdir" "$out"
	rm -rf "$appdir"
}

mkdir -p "$ARTIFACT_DIR"

if [[ "$SKIP_COMPILE" != '1' ]]; then
	# Clear stale artefacts for the versions we're about to (re)build.
	rm -f "$ARTIFACT_DIR"/VibeIDE-*-linux-*.deb "$ARTIFACT_DIR"/VibeIDE-*-linux-*.rpm \
		"$ARTIFACT_DIR"/VibeIDE-*-linux-*.AppImage "$ARTIFACT_DIR"/VibeIDE-*-linux-*.tar.gz \
		"$ARTIFACT_DIR"/VibeIDE-*-linux-*.asc

	for arch in "${FINAL_ARCHES[@]}"; do
		printf '\n\033[36m── arch: %s ──\033[0m\n' "$arch"
		APP_PKG_DIR="$BUILD_ROOT/VibeIDE-linux-$arch"

		step "[$arch] gulp vscode-linux-$arch-min (package app)..."
		gulp_task "vscode-linux-$arch-min"
		[[ -d "$APP_PKG_DIR" ]] || die "packaged app dir not found: $APP_PKG_DIR"

		step "[$arch] Building .deb (dpkg-deb)..."
		gulp_task "vscode-linux-$arch-prepare-deb"
		gulp_task "vscode-linux-$arch-build-deb"
		DEB_SRC="$(ls "$ROOT/.build/linux/deb/$(deb_arch "$arch")/deb/"*.deb 2> /dev/null | head -1)"
		[[ -n "$DEB_SRC" ]] || die "no .deb produced for $arch"
		cp "$DEB_SRC" "$ARTIFACT_DIR/VibeIDE-$NEW_VIBE-linux-$arch.deb"
		ok "[$arch] deb → VibeIDE-$NEW_VIBE-linux-$arch.deb"

		step "[$arch] Building .rpm (rpmbuild)..."
		gulp_task "vscode-linux-$arch-prepare-rpm"
		gulp_task "vscode-linux-$arch-build-rpm"
		RPM_SRC="$(ls "$ROOT/.build/linux/rpm/$(rpm_arch "$arch")/"*.rpm 2> /dev/null | head -1)"
		[[ -n "$RPM_SRC" ]] || die "no .rpm produced for $arch"
		cp "$RPM_SRC" "$ARTIFACT_DIR/VibeIDE-$NEW_VIBE-linux-$arch.rpm"
		ok "[$arch] rpm → VibeIDE-$NEW_VIBE-linux-$arch.rpm"

		step "[$arch] Building .AppImage (appimagetool)..."
		build_appimage "$arch" "$ARTIFACT_DIR/AppDir-$arch" "$ARTIFACT_DIR/VibeIDE-$NEW_VIBE-linux-$arch.AppImage"
		ok "[$arch] AppImage → VibeIDE-$NEW_VIBE-linux-$arch.AppImage"

		step "[$arch] Building portable .tar.gz..."
		tar -czf "$ARTIFACT_DIR/VibeIDE-$NEW_VIBE-linux-$arch.tar.gz" \
			-C "$BUILD_ROOT" "VibeIDE-linux-$arch"
		ok "[$arch] tar.gz → VibeIDE-$NEW_VIBE-linux-$arch.tar.gz"
	done
fi

# Collect the artefact set for the current version (guards Phase 2 / --skip-compile).
mapfile -t ARTIFACTS < <(ls "$ARTIFACT_DIR"/VibeIDE-"$NEW_VIBE"-linux-*.deb \
	"$ARTIFACT_DIR"/VibeIDE-"$NEW_VIBE"-linux-*.rpm \
	"$ARTIFACT_DIR"/VibeIDE-"$NEW_VIBE"-linux-*.AppImage \
	"$ARTIFACT_DIR"/VibeIDE-"$NEW_VIBE"-linux-*.tar.gz 2> /dev/null || true)
[[ ${#ARTIFACTS[@]} -gt 0 ]] || die "no artefacts for $NEW_VIBE in $ARTIFACT_DIR — run Phase 1 first"

# ── 2b. Optional GPG signing (mirror of VIBE_MAC_SIGNING_IDENTITY) ─────────────
if [[ -n "${VIBE_GPG_KEY_ID:-}" ]]; then
	require_tool gpg 'install: apt-get install gnupg'
	step "Signing artefacts with GPG key $VIBE_GPG_KEY_ID..."
	SIGNED=()
	for f in "${ARTIFACTS[@]}"; do
		gpg --batch --yes --local-user "$VIBE_GPG_KEY_ID" --detach-sign --armor "$f"
		SIGNED+=("$f.asc")
	done
	ARTIFACTS+=("${SIGNED[@]}")
	ok "Signed ${#SIGNED[@]} artefact(s) (.asc emitted)"
else
	warn 'VIBE_GPG_KEY_ID not set — artefacts are UNSIGNED. Set it to a maintainer key to publish signed releases.'
fi

# ── 2c. Smoke check — the built CLI must answer --version ──────────────────────
step 'Smoke-checking built application (bin/vibeide --version)...'
SMOKE_ARCH="${FINAL_ARCHES[0]}"
SMOKE_CLI="$BUILD_ROOT/VibeIDE-linux-$SMOKE_ARCH/bin/$APP_NAME"
if [[ "$SMOKE_ARCH" == 'x64' && "$HOST_ARCH" == 'x86_64' && -x "$SMOKE_CLI" ]]; then
	SMOKE_OUT="$("$SMOKE_CLI" --version 2> /dev/null || true)"
	[[ -n "$SMOKE_OUT" ]] && ok "Smoke check passed: $(echo "$SMOKE_OUT" | tr '\n' ' ')" \
		|| warn 'Smoke check produced no output (bin CLI) — verify manually before publishing.'
else
	echo "  (skipping runtime smoke: $SMOKE_ARCH binary not executable on $HOST_ARCH host)"
fi

# ── 2d. Release manifest + checksums (same helper as Windows/macOS) ───────────
step 'Generating release-manifest.json + checksums-sha256.txt...'
MANIFEST_STAGE="$ARTIFACT_DIR/manifest-stage"
rm -rf "$MANIFEST_STAGE"; mkdir -p "$MANIFEST_STAGE"
for f in "${ARTIFACTS[@]}"; do cp "$f" "$MANIFEST_STAGE/"; done
node "$ROOT/scripts/vibe-release-manifest.mjs" --root "$MANIFEST_STAGE" --tag "$VERSION"
[[ -f "$MANIFEST_STAGE/release-manifest.json" ]] && ARTIFACTS+=("$MANIFEST_STAGE/release-manifest.json")
[[ -f "$MANIFEST_STAGE/checksums-sha256.txt" ]] && ARTIFACTS+=("$MANIFEST_STAGE/checksums-sha256.txt")
ok 'Manifest + checksums ready'

if [[ "$SKIP_PUBLISH" == '1' ]]; then
	ok 'Test build complete (--skip-publish): tag + GitHub release SKIPPED.'
	printf '\n\033[36m📦 Artifacts ready for manual smoke-test:\033[0m\n'
	printf '   %s\n' "${ARTIFACTS[@]}"
	printf '\n   To publish the SAME build: ./scripts/release-linux.sh --skip-compile\n\n'
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

# ── 4. GitHub Release: create, or upload into the existing one (Win/Mac first) ─
if gh release view "$VERSION" > /dev/null 2>&1; then
	step "Release $VERSION exists — uploading Linux artefacts into it..."
	gh release upload "$VERSION" --clobber "${ARTIFACTS[@]}"
else
	step "Creating GitHub Release $VERSION..."
	DRAFT_ARGS=()
	if [[ "$DRAFT" == '1' ]]; then DRAFT_ARGS+=(--draft); fi
	gh release create "$VERSION" --title "VibeIDE $VERSION" --generate-notes ${DRAFT_ARGS[@]+"${DRAFT_ARGS[@]}"} "${ARTIFACTS[@]}"
fi

ok "Release $VERSION published!"
printf '\n\033[36m🎉 Done! https://github.com/VibeBrains/VibeIDE/releases/tag/%s\033[0m\n\n' "$VERSION"
