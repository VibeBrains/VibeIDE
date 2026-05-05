# Project Manager — Upstream Sync

**Upstream:** https://github.com/alefragnani/vscode-project-manager  
**License:** GPL-3.0 (bundled as pre-installed .vsix — VibeIDE stays MIT)  
**Upstream version:** 13.1.0 (pinned)  
**Synced at:** 2026-05-02  

## Architecture

The `.vsix` file is bundled as-is from Open VSX.  
All VibeIDE-specific integration code lives in `vibeide-integration/projectManagerBridge.ts`  
using only public VS Code Extension API. Source code is NOT modified.

## Bundling

```
extensions/project-manager/
  package.json              ← mirrors upstream (for version tracking)
  project-manager-13.1.0.vsix  ← official Open VSX release (NOT repackaged)
  UPSTREAM.md               ← this file
  vibeide-integration/
    projectManagerBridge.ts ← VibeIDE-specific glue code
```

## VibeIDE Integrations

| Integration | Status |
|-------------|--------|
| `vibe init` registers project in PM | Phase 1 |
| `projectsLocation` → VSCodeSyncFiles folder | Phase 1 |
| `.vibe/profiles/` ↔ PM projects sync | Phase 2 |
| `vibe-ready` tag for `.vibe/` projects | Phase 2 |
| Agent context: PM project name in audit-log | Phase 2 |

## SBOM Entry

```
bundled-extension: project-manager
license: GPL-3.0-only
bundling-method: pre-installed-vsix (independent license)
```

## Sync workflow

`sync-project-manager.yml` — weekly check of new releases on Open VSX.
Opens PR with changelog when new version available.
