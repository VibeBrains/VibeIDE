# Vibe Neon — upstream provenance



**Vendor repository (MIT):** https://github.com/robb0wen/synthwave-vscode  



Frozen snapshot in this fork uses **neutral filenames** under `upstream/vendor-neon-theme/` — see mapping in `upstream/vendor-neon-theme/SOURCE.md`.  

Bundled runtime assets: **`themes/vibe-neon.json`**, **`media/vibe-neon.css`**, **`media/vibe-neon-noglow.css`**; theme settings ids **`vibe-neon`** / **`vibe-neon-noglow`**.



## Native chrome + glow (`media/*.css`)



The vendor pack originally patched workbench HTML (`neondreams.js`). VibeIDE injects CSS via `vibeNeonThemeContribution` — no corrupted-install warning.



## Marketplace coexistence



- Builtin extension id: **`vibeide.vibeide-neon`**.

- The **publisher’s** theme extension from Open VSX / Marketplace installs under **another** `extensionId`; choosing it swaps the whole theme/CSS chain normally.



## Sync workflow



`.github/workflows/sync-vibe-neon-upstream.yml` — on new tags from the vendor repo URL above, refresh `upstream/vendor-neon-theme/` (keep filename mapping table in `SOURCE.md`), then regenerate `themes/vibe-neon.json` and refresh both files in `media/`.

