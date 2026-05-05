# Package — legacy identifier migration helpers

Maintenance scripts for **`src/vs/workbench/contrib/vibeide`**.

| Script | Purpose |
|--------|---------|
| [`patchLegacyLayerFragments.mjs`](patchLegacyLayerFragments.mjs) | Text replace for obsolete filename/string tokens (constants `FROM_LC` / `FROM_PC` inside the script) → `vibeide` / `Vibeide` |
| [`renameLegacyFilenamesInLayer.mjs`](renameLegacyFilenamesInLayer.mjs) | Renames matching basenames in that folder tree |

Typical invocation from repo root:

```bash
node scripts/migrations/patchLegacyLayerFragments.mjs
node scripts/migrations/renameLegacyFilenamesInLayer.mjs
```

Historical context lives in **`FORK_CHANGES.md`** and `.vibe/plans/`.
