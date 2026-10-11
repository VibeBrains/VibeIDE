#!/bin/bash
# Opens the winget-pkgs PR for a published release from macOS — the twin of scripts/winget-release.ps1,
# which needs wingetcreate and a GitHub token inside Windows.
#   scripts/win-vm/wingetPr.sh            render the manifests of the product.json version, open the PR
#   scripts/win-vm/wingetPr.sh --dry-run  render only, into $OUT_ROOT
# Manifests go through the GitHub API into the fork: winget-pkgs is too large to clone for three files.
# `winget validate` is not run here (winget does not start outside a Windows desktop session), so its box
# in the PR checklist stays unchecked; the winget-pkgs pipeline validates the PR itself
set -euo pipefail
cd "$(dirname "$0")/../.."
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
REPO="VibeBrains/VibeIDE"; UPSTREAM="microsoft/winget-pkgs"
FORK="${WINGET_FORK:-$(gh api user -q .login)/winget-pkgs}"
OUT_ROOT="${OUT_ROOT:-/Volumes/Storage/Caches/vibeide/winget}"

VER="$(node -p "require('./product.json').vibeVersion")"
EXE="$(node -p "require('./product.json').nameShort")Setup.exe"
URL="https://github.com/$REPO/releases/download/v$VER/$EXE"
# Inno's uninstall key is AppId + "_is1"; product.json escapes the leading brace as "{{"
PRODUCT_CODE="$(node -p "require('./product.json').win32x64AppId.replace(/^\{\{/, '{') + '_is1'")"
DIR="manifests/v/VibeBrains/VibeIDE/$VER"
OUT="$OUT_ROOT/$DIR"

gh release view "v$VER" -R "$REPO" --json assets -q '.assets[].name' | grep -qx "$EXE" \
	|| { echo "✗ $EXE is not on release v$VER — upload the Windows artifacts first"; exit 1; }
# The hash of the bytes people download, not of a local file
SHA="$(curl -fsSL "$URL" | shasum -a 256 | cut -d' ' -f1 | tr a-z A-Z)"
echo "▶ $EXE v$VER sha256 $SHA"

mkdir -p "$OUT"
FILES=(VibeBrains.VibeIDE.yaml VibeBrains.VibeIDE.installer.yaml VibeBrains.VibeIDE.locale.en-US.yaml)
for f in "${FILES[@]}"; do
	# The schema line stays, the template's own comments go: they describe the template, not the manifest
	{ grep '^# yaml-language-server' "build/winget/$f.template"; echo; grep -v '^#' "build/winget/$f.template"; } \
		| sed -e "s|__VERSION__|$VER|g" -e "s|__URL__|$URL|g" -e "s|__SHA256__|$SHA|g" -e "s|__PRODUCTCODE__|$PRODUCT_CODE|g" > "$OUT/$f"
done
echo "✓ manifests: $OUT"
[[ $DRY == 1 ]] && { echo "dry run — PR not opened"; exit 0; }

[[ -z "$(gh pr list -R "$UPSTREAM" --search "VibeBrains.VibeIDE in:title" --state open --json number -q '.[].number')" ]] \
	|| { echo "✗ an open VibeBrains.VibeIDE PR already exists in $UPSTREAM"; exit 1; }
gh repo sync "$FORK" -b master
BASE="$(gh api "repos/$FORK/git/ref/heads/master" -q .object.sha)"
BASE_TREE="$(gh api "repos/$FORK/git/commits/$BASE" -q .tree.sha)"
ENTRIES=""
for f in "${FILES[@]}"; do
	BLOB="$(gh api "repos/$FORK/git/blobs" -f encoding=base64 -f content="$(base64 -i "$OUT/$f")" -q .sha)"
	ENTRIES+="${ENTRIES:+,}{\"path\":\"$DIR/$f\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$BLOB\"}"
done
TREE="$(echo "{\"base_tree\":\"$BASE_TREE\",\"tree\":[$ENTRIES]}" | gh api "repos/$FORK/git/trees" --input - -q .sha)"
TITLE="VibeBrains.VibeIDE version $VER"
COMMIT="$(echo "{\"message\":\"$TITLE\",\"tree\":\"$TREE\",\"parents\":[\"$BASE\"]}" | gh api "repos/$FORK/git/commits" --input - -q .sha)"
BRANCH="VibeBrains.VibeIDE-$VER"
gh api "repos/$FORK/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$COMMIT" -q .ref

BODY="$(mktemp)"
cat > "$BODY" <<MD
## 📖 Description

New version: VibeBrains.VibeIDE $VER.

## ✅ Checklist

- [x] Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com)
- [ ] Linked to an issue (if applicable)

## 📦 Manifest Checklist

- [x] Checked that there aren't other open [pull requests](https://github.com/microsoft/winget-pkgs/pulls) for the same manifest update/change
- [x] This PR only modifies one (1) manifest
- [ ] Validated manifest locally with \`winget validate --manifest <path>\` ([validation guide](https://github.com/microsoft/winget-pkgs/blob/master/doc/ValidationFailureGuide.md))
- [ ] Tested manifest locally with \`winget install --manifest <path>\`
- [x] Manifest conforms to the [1.12 schema](https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema/1.12.0)

> **Note:** \`<path>\` is the directory containing the manifest you're submitting.
MD
gh pr create -R "$UPSTREAM" --head "${FORK%%/*}:$BRANCH" --base master --title "$TITLE" --body-file "$BODY"
rm -f "$BODY"
