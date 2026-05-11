#!/usr/bin/env bash
# build-macos-universal.sh — combine darwin-x64 + darwin-arm64 .app bundles into
# a single Universal Binary, then re-sign + (optionally) re-notarize.
#
# Roadmap §888 (Distribution readiness gate / macOS Universal Binary).
# Pure policy helper: src/vs/workbench/contrib/vibeide/common/distributionSigningPolicy.ts
# Runbook:           references/v1/distribution-signing-runbook.md
# Sibling scripts:   scripts/notarize-macos.sh, scripts/release-macos.sh
#
# What this does (when credentials are present):
#   1. Validate both .app inputs exist and have matching CFBundleIdentifier.
#   2. Mirror the directory tree of the x64 .app into the output Universal .app.
#   3. For every Mach-O file inside, run `lipo -create x64 arm64 -output universal`;
#      for non-Mach-O files copy through unchanged.
#   4. Re-sign with hardened runtime via `codesign --force --deep --options runtime
#      --timestamp --sign "$VIBE_MAC_SIGNING_IDENTITY"` (Developer ID Application).
#   5. Verify with `codesign --verify --strict --deep --verbose=2` and
#      `spctl --assess --type execute`.
#   6. Optionally call scripts/notarize-macos.sh on the resulting bundle when
#      `--notarize` is passed (or `VIBE_MAC_NOTARIZE=1`).
#
# When credentials are absent: fail-loud with a clear remediation message that
# points at the runbook. Dev / nightly builds can pass --allow-unsigned to skip
# the codesign step entirely (the resulting bundle will be Gatekeeper-blocked
# on first launch — that is by design for non-release builds).
#
# Required env (release mode):
#   VIBE_MAC_SIGNING_IDENTITY   "Developer ID Application: <Team Name> (<TEAMID>)"
#                                As reported by `security find-identity -p codesigning -v`.
#
# Optional env:
#   VIBE_MAC_ENTITLEMENTS       Path to entitlements.plist (default: build/darwin/entitlements.plist).
#   VIBE_MAC_NOTARIZE           When `1`, automatically invoke notarize-macos.sh after signing.
#   APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD   Required by notarize-macos.sh when notarizing.
#
# Usage:
#   ./scripts/build-macos-universal.sh \
#       --x64 path/to/VibeIDE-darwin-x64/VibeIDE.app \
#       --arm64 path/to/VibeIDE-darwin-arm64/VibeIDE.app \
#       --out path/to/VibeIDE-darwin-universal/VibeIDE.app
#
#   ./scripts/build-macos-universal.sh --x64 X --arm64 A --out U --dry-run
#   ./scripts/build-macos-universal.sh --x64 X --arm64 A --out U --allow-unsigned
#   ./scripts/build-macos-universal.sh --x64 X --arm64 A --out U --notarize
#
# Tested on: skeleton — needs an actual macOS host with Xcode CLT to exercise.
# `lipo` is part of Xcode Command Line Tools.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-macos-universal.sh --x64 <app> --arm64 <app> --out <app> [flags]

Flags:
  --x64 <path>         Input darwin-x64 VibeIDE.app bundle (required).
  --arm64 <path>       Input darwin-arm64 VibeIDE.app bundle (required).
  --out <path>         Output darwin-universal VibeIDE.app bundle (required).
  --dry-run            Print the actions without touching the filesystem.
  --allow-unsigned     Skip codesign + spctl verify (dev/nightly builds only).
  --notarize           After signing, call scripts/notarize-macos.sh on --out.
  -h, --help           Show this help.

Required env (release mode): VIBE_MAC_SIGNING_IDENTITY
Optional env: VIBE_MAC_ENTITLEMENTS, VIBE_MAC_NOTARIZE, APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD

See references/v1/distribution-signing-runbook.md for the credential setup runbook.
EOF
}

DRY_RUN=0
ALLOW_UNSIGNED=0
DO_NOTARIZE=0
X64_APP=""
ARM64_APP=""
OUT_APP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --x64) X64_APP="${2:-}"; shift 2 ;;
    --arm64) ARM64_APP="${2:-}"; shift 2 ;;
    --out) OUT_APP="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-unsigned) ALLOW_UNSIGNED=1; shift ;;
    --notarize) DO_NOTARIZE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[build-macos-universal] unexpected arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$X64_APP" || -z "$ARM64_APP" || -z "$OUT_APP" ]]; then
  echo "[build-macos-universal] --x64, --arm64, --out are all required." >&2
  usage >&2
  exit 1
fi

for p in "$X64_APP" "$ARM64_APP"; do
  if [[ ! -d "$p" ]]; then
    echo "[build-macos-universal] input bundle missing or not a directory: $p" >&2
    exit 1
  fi
done

if [[ "${VIBE_MAC_NOTARIZE:-0}" == "1" ]]; then
  DO_NOTARIZE=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]] && [[ "$DRY_RUN" != "1" ]]; then
  echo "[build-macos-universal] must run on macOS (host = $(uname -s)). Use --dry-run elsewhere." >&2
  exit 2
fi

if [[ "$DRY_RUN" != "1" ]]; then
  if ! command -v lipo >/dev/null; then
    echo "[build-macos-universal] lipo not found — install Xcode Command Line Tools (xcode-select --install)." >&2
    exit 3
  fi
  if ! command -v codesign >/dev/null && [[ "$ALLOW_UNSIGNED" != "1" ]]; then
    echo "[build-macos-universal] codesign not found — install Xcode Command Line Tools." >&2
    exit 3
  fi
fi

# ── Signing identity gate ────────────────────────────────────────────────────
SIGN_IDENTITY="${VIBE_MAC_SIGNING_IDENTITY:-}"
if [[ -z "$SIGN_IDENTITY" && "$ALLOW_UNSIGNED" != "1" ]]; then
  cat <<'EOF' >&2
[build-macos-universal] Signing identity not configured. Set:
  export VIBE_MAC_SIGNING_IDENTITY='Developer ID Application: <Team Name> (<TEAMID>)'

The identity must be present in the keychain — confirm with:
  security find-identity -p codesigning -v

For dev/nightly builds pass --allow-unsigned. For release, acquire an Apple
Developer account (~$99/y) and follow references/v1/distribution-signing-runbook.md.
EOF
  exit 2
fi

ENTITLEMENTS="${VIBE_MAC_ENTITLEMENTS:-$REPO_ROOT/build/darwin/entitlements.plist}"

# ── Identity check: matching CFBundleIdentifier ──────────────────────────────
plist_id() {
  /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || echo ""
}
if [[ "$DRY_RUN" != "1" ]]; then
  X64_ID=$(plist_id "$X64_APP")
  ARM_ID=$(plist_id "$ARM64_APP")
  if [[ -z "$X64_ID" || -z "$ARM_ID" || "$X64_ID" != "$ARM_ID" ]]; then
    echo "[build-macos-universal] CFBundleIdentifier mismatch or missing: x64='$X64_ID' arm64='$ARM_ID'" >&2
    exit 4
  fi
  echo "[build-macos-universal] bundle id: $X64_ID"
fi

# ── Plan output layout ───────────────────────────────────────────────────────
echo "[build-macos-universal] inputs:"
echo "    x64   : $X64_APP"
echo "    arm64 : $ARM64_APP"
echo "    out   : $OUT_APP"
echo "    sign  : ${SIGN_IDENTITY:-<skipped: --allow-unsigned>}"
echo "    notarize : $([[ $DO_NOTARIZE == 1 ]] && echo yes || echo no)"
echo "    entitlements: $ENTITLEMENTS"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[build-macos-universal] DRY RUN — would:"
  echo "  1. rsync -a --delete '$X64_APP/' '$OUT_APP/'"
  echo "  2. for each Mach-O in '$OUT_APP', replace with lipo -create x64-counterpart arm64-counterpart -output …"
  echo "  3. codesign --force --deep --options runtime --timestamp --sign '<identity>' \\"
  echo "       --entitlements '$ENTITLEMENTS' '$OUT_APP'"
  echo "  4. codesign --verify --strict --deep --verbose=2 '$OUT_APP'"
  echo "  5. spctl --assess --type execute --verbose '$OUT_APP'"
  if [[ $DO_NOTARIZE == 1 ]]; then
    echo "  6. '$SCRIPT_DIR/notarize-macos.sh' '$OUT_APP'"
  fi
  exit 0
fi

# ── Step 1: mirror x64 → out ─────────────────────────────────────────────────
echo "[build-macos-universal] mirroring x64 bundle → out …"
rm -rf "$OUT_APP"
mkdir -p "$(dirname "$OUT_APP")"
# Use ditto on macOS — preserves resource forks, extended attrs, symlinks better than rsync.
ditto "$X64_APP" "$OUT_APP"

# ── Step 2: lipo-merge every Mach-O ──────────────────────────────────────────
echo "[build-macos-universal] lipo-merging Mach-O binaries …"
merge_count=0
copy_count=0

# Find Mach-O files inside the out bundle (executables + dylibs + frameworks).
# `file` prints lines like "…: Mach-O 64-bit executable x86_64" — match those.
while IFS= read -r out_file; do
  rel="${out_file#$OUT_APP/}"
  arm_file="$ARM64_APP/$rel"

  if [[ ! -e "$arm_file" ]]; then
    # File only exists in x64 bundle — leave the x64 copy. Common for arch-specific
    # binaries that just happen to be missing in the arm64 build (rare; warn).
    echo "[build-macos-universal] WARNING: '$rel' missing in arm64 bundle — leaving x64-only."
    continue
  fi

  out_kind=$(file -b "$out_file" 2>/dev/null || echo "")
  arm_kind=$(file -b "$arm_file" 2>/dev/null || echo "")
  if [[ "$out_kind" != *"Mach-O"* || "$arm_kind" != *"Mach-O"* ]]; then
    continue
  fi

  # Already universal? (Both arches inside one binary.) Skip — lipo would fail.
  if [[ "$out_kind" == *"Mach-O universal"* ]]; then
    continue
  fi

  lipo -create "$out_file" "$arm_file" -output "$out_file.universal"
  mv "$out_file.universal" "$out_file"
  merge_count=$((merge_count + 1))
done < <(find "$OUT_APP" -type f ! -name "*.nib" ! -name "*.plist")

echo "[build-macos-universal] merged $merge_count Mach-O files (copies left intact: $copy_count)."

# ── Step 3: re-sign ──────────────────────────────────────────────────────────
if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
  echo "[build-macos-universal] WARNING: --allow-unsigned — skipping codesign."
  echo "[build-macos-universal] WARNING: bundle will be Gatekeeper-blocked on first launch."
else
  echo "[build-macos-universal] codesigning with: $SIGN_IDENTITY"
  if [[ -f "$ENTITLEMENTS" ]]; then
    codesign --force --deep --options runtime --timestamp \
      --entitlements "$ENTITLEMENTS" \
      --sign "$SIGN_IDENTITY" \
      "$OUT_APP"
  else
    echo "[build-macos-universal] WARNING: entitlements file '$ENTITLEMENTS' not found — signing without entitlements."
    codesign --force --deep --options runtime --timestamp \
      --sign "$SIGN_IDENTITY" \
      "$OUT_APP"
  fi

  echo "[build-macos-universal] verifying signature …"
  codesign --verify --strict --deep --verbose=2 "$OUT_APP"

  # spctl assess — Gatekeeper-style first-launch check. Warn-only because it
  # requires a notarized bundle to actually pass; running it pre-notarize is
  # diagnostic.
  if spctl --assess --type execute --verbose "$OUT_APP" 2>&1; then
    echo "[build-macos-universal] spctl: accepted."
  else
    echo "[build-macos-universal] spctl: rejected — expected until notarization is done."
  fi
fi

# ── Step 4: optional notarize ────────────────────────────────────────────────
if [[ $DO_NOTARIZE == 1 ]]; then
  if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
    echo "[build-macos-universal] cannot notarize unsigned bundle — aborting." >&2
    exit 5
  fi
  echo "[build-macos-universal] handing off to notarize-macos.sh …"
  VIBE_MAC_NOTARIZE=1 "$SCRIPT_DIR/notarize-macos.sh" "$OUT_APP"
fi

echo "[build-macos-universal] OK — $OUT_APP"
