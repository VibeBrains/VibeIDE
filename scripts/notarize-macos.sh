#!/usr/bin/env bash
# notarize-macos.sh — Apple notarization wrapper for VibeIDE.app / .dmg.
#
# Roadmap §888 (Distribution readiness gate / macOS notarization).
# Pure policy helper: src/vs/workbench/contrib/vibeide/common/distributionSigningPolicy.ts
# Runbook: references/v1/distribution-signing-runbook.md
#
# Required env:
#   APPLE_ID            Apple Developer account email
#   APPLE_TEAM_ID       Team ID (10-char alphanumeric)
#   APPLE_APP_PASSWORD  App-specific password from appleid.apple.com
#   VIBE_MAC_NOTARIZE=1 Gate flag (refuse to run without it)
#
# Usage:
#   ./scripts/notarize-macos.sh path/to/VibeIDE.app
#   ./scripts/notarize-macos.sh --dry-run path/to/VibeIDE.dmg
#
# Requires Xcode 13+ for `xcrun notarytool`. Apple Developer account ~$99/y.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: notarize-macos.sh [--dry-run] [--allow-unsigned] <path>

Submits the given .app or .dmg to Apple notarization, polls for completion,
and staples the resulting ticket on success.

Required env vars: APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD, VIBE_MAC_NOTARIZE=1
Optional env vars: VIBE_NOTARIZE_TIMEOUT_SECS (default 1800)

Flags:
  --dry-run         Print the notarytool invocation without running it.
  --allow-unsigned  Skip notarization with a clear warning (dev/nightly).
EOF
}

DRY_RUN=0
ALLOW_UNSIGNED=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --allow-unsigned) ALLOW_UNSIGNED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [[ -z "$TARGET" ]]; then TARGET="$1"; else echo "[notarize-macos] unexpected arg: $1" >&2; exit 1; fi
      shift ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  usage
  exit 1
fi
if [[ ! -e "$TARGET" ]]; then
  echo "[notarize-macos] target not found: $TARGET" >&2
  exit 1
fi

GATE="${VIBE_MAC_NOTARIZE:-0}"
APPLE_ID="${APPLE_ID:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
APPLE_APP_PASSWORD="${APPLE_APP_PASSWORD:-}"

if [[ "$GATE" != "1" || -z "$APPLE_ID" || -z "$APPLE_TEAM_ID" || -z "$APPLE_APP_PASSWORD" ]]; then
  if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
    echo "[notarize-macos] WARNING: VIBE_MAC_NOTARIZE != 1 or credentials missing — leaving '$TARGET' un-notarized."
    echo "[notarize-macos] WARNING: macOS Gatekeeper will block first launch on user machines."
    exit 0
  fi
  cat <<'EOF' >&2
[notarize-macos] Notarization not configured. Set:
  export VIBE_MAC_NOTARIZE=1
  export APPLE_ID='dev@example.com'
  export APPLE_TEAM_ID='ABC1234567'
  export APPLE_APP_PASSWORD='abcd-efgh-ijkl-mnop'  # app-specific, not iCloud password

For dev/nightly builds, pass --allow-unsigned. For release, acquire an Apple
Developer account (~$99/y) and follow references/v1/distribution-signing-runbook.md.
EOF
  exit 2
fi

if ! command -v xcrun >/dev/null; then
  echo "[notarize-macos] xcrun not found — install Xcode Command Line Tools." >&2
  exit 3
fi

TIMEOUT="${VIBE_NOTARIZE_TIMEOUT_SECS:-1800}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[notarize-macos] DRY RUN — would invoke:"
  echo "  xcrun notarytool submit '$TARGET' \\"
  echo "    --apple-id '\$APPLE_ID' --team-id '\$APPLE_TEAM_ID' \\"
  echo "    --password '<redacted>' --wait --timeout ${TIMEOUT}s"
  echo "  xcrun stapler staple '$TARGET'"
  exit 0
fi

echo "[notarize-macos] submitting $TARGET …"
xcrun notarytool submit "$TARGET" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait --timeout "${TIMEOUT}s"

echo "[notarize-macos] stapling …"
xcrun stapler staple "$TARGET"

echo "[notarize-macos] verifying …"
xcrun stapler validate "$TARGET"

echo "[notarize-macos] OK — $TARGET is notarized and stapled."
