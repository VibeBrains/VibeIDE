# Windows Controlled Folder Access — VibeIDE / VS Code / Electron

Runbook for roadmap § E → «Антивирус / Windows Controlled Folder Access».

## Symptoms

- Builds fail (`npm install`, native addon rebuild) with **access denied** under `node_modules` or the repo.
- Writing **`.vibe/`**, `.vibeide/audit.jsonl`, checkpoints, or SQLite indexes fails silently or with EPERM.
- DevTools console shows file watcher errors on workspace folders.

## Cause

**Windows Security → Virus & threat protection → Ransomware protection → Controlled folder access** blocks unknown apps from writing to **Desktop**, **Documents**, **Pictures**, and other protected locations unless the app is **allowed**.

## Mitigations (pick one)

1. **Move the repo** to a path outside protected user folders (e.g. `D:\Projects\...` instead of `Documents\...`).
2. **Allow an app** through Controlled folder access:
   - Settings → Privacy & security → Windows Security → Virus & threat protection → Manage ransomware protection → Allow an app through Controlled folder access.
   - Add the **Electron/VibeIDE executable** you actually launch (dev: `Code - OSS.exe` / product exe from `product.json`; retail: shipped `VibeIDE.exe`).
3. **Disable Controlled folder access** (least preferred on hardened machines).

## Verification

- Retry the failing command (`npm run transpile-client`, first launch after `.vibe/` init).
- If blocking persists, check **Protection history** for blocked events naming your IDE path.

## Product note

This is an **OS policy**, not an IDE bug. VibeIDE cannot safely override CFA from inside the app; document the path choice and allowed-app workflow for contributors.
