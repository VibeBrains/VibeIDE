<!--
  Bundled mirror for traceability and diffs. Canonical vendor tree (MIT) is linked from UPSTREAM.md at repo root.
-->
Synced from vendor **master** alignment (see `_upstream.version` in `package.json`).

## Layout (this folder)

- `themes/snapshot-color-theme.json` — full color theme JSON snapshot (regenerate from vendor pack when refreshing).
- `snapshot-vibe-neon.css` — glow + chrome stylesheet snapshot.
- `snapshot-vibe-neon-noglow.css` — chrome without editor token glow.
- `src/css/editor_chrome.css` — extra vendor chrome reference (not loaded directly by VibeIDE runtime).
- `LICENSE` — vendor license text.

## Runtime copies inside this extension

Merge snapshot JSON → `../../themes/vibe-neon.json`.  
Copy stylesheet snapshots → `../../media/vibe-neon.css` and `../../media/vibe-neon-noglow.css`.

When pulling a new vendor VSIX or repo checkout, **diff** those artifacts against the `snapshot-*` files here, then refresh the two runtime paths above.
