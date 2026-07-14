# Idle Watchdog — commands and settings reference (W.40)

← [Knowledge Index](../README.md)

Complete reference for all `vibeide.diagnostics.idleWatchdog.*` settings and Command Palette entries shipped by the watchdog stack (W.0–W.50).

---

## Command Palette

| Command id | Title | Roadmap | Purpose |
|---|---|---|---|
| `vibeide.watchdog.bundleCrashReport` | VibeIDE: Собрать crash report (Idle Watchdog) | W.11 | Pack last 3 days `.jsonl` + heap snapshots + 5 session log folders + `system-info.json` into a ZIP for sharing. |
| `vibeide.watchdog.showTimeline` | VibeIDE: Показать Idle Watchdog Timeline | W.7 / W.28 | Open a markdown editor with live snapshot table + RSS sparkline per process + recent events. |
| `vibeide.watchdog.aiDiagnose` | VibeIDE: Диагностика памяти через AI | W.36 | Generate a pre-formatted prompt + watchdog data, ready to paste into VibeIDE chat for LLM-driven analysis. |

## Settings (`vibeide.diagnostics.idleWatchdog.*`)

| Key | Type | Default | Range | Roadmap | Purpose |
|---|---|---|---|---|---|
| `enabled` | boolean | `true` | – | W.0 | Master toggle. Hot-reload via `fs.watch` (W.8). |
| `intervalMinutes` | number | `5` | 1–60 | W.0 | Sample tick interval (main + renderer). Hot-reload. |
| `retentionDays` | number | `3` | 1–90 | W.0 | Days to keep `.jsonl` (cleanup on start + UTC midnight). |
| `includeProcessReport` | boolean | `false` | – | W.13 | Every 10th tick dumps a compact `process.report.getReport()` subset. |
| `heapSnapshotOnHighRss` | boolean | `false` | – | W.4 | Auto heap snapshot when main RSS exceeds threshold. |
| `heapSnapshotThresholdMB` | number | `2000` | 100–16000 | W.4 | Threshold for auto snapshot (MB). |
| `snapshotCooldownMinutes` | number | `30` | 5–1440 | W.4 | Min interval between same-process snapshots. |
| `growthAlertMBPerMin` | number | `5` | 1–200 | W.5 | Slope threshold for «memory growing» notification. |
| `maxSnapshotsRetained` | number | `3` | 1–20 | W.22 | Cap on retained heap-snapshot files. |
| `includeChildProcessTypes` | array | `['Utility','GPU']` | enum | W.22 | Which Electron child types to sample via `app.getAppMetrics()`. |
| `maxLogsTotalMB` | number | `500` | 50–10000 | W.26 | Total disk budget for `logs/vibe-idle-watchdog/`. |
| `preOomHeapRatio` | number | `0.85` | 0.5–0.99 | W.42 | `heapUsed/heapLimit` ratio that triggers pre-OOM alert. |
| `autoRestartOnPreOom` | boolean | `false` | – | W.46 | Opt-in: auto-restart 5 min after pre-OOM alert if not addressed. |
| `compressOldJsonl` | boolean | `true` | – | W.30 | Gzip yesterday's and older `.jsonl` files at startup. |
| `adaptiveSampling` | boolean | `false` | – | W.50 | Stretch interval 6× when idle > 1h, restore on first activity. |
| `statisticalOutlier` | boolean | `false` | – | W.33 | Use 3-sigma detection instead of fixed `growthAlertMBPerMin`. |
| `showStatusBar` | boolean | `false` | – | W.6 / W.29 | Show right-aligned `🧠 main/render/ext` status bar widget. |
| `autoOpenDevToolsOnPreOom` | boolean | `false` | – | W.17 | Open Chromium DevTools automatically on pre-OOM alert. |

## On-disk artefacts

```
${userDataPath}/logs/vibe-idle-watchdog/
├── 2026-05-22.jsonl.gz          # gzip-compressed (W.30) historical day
├── 2026-05-23.jsonl             # today's file (always uncompressed)
├── state.json                   # persisted cross-session state (W.45)
└── snapshots/
    ├── 20260523T134500-main-12345.heapsnapshot
    └── ...                       # rotated at maxSnapshotsRetained
```

## `.jsonl` line schema (v=1)

```jsonc
// sample (per process, per tick):
{
  "v": 1, "type": "sample", "ts": "2026-05-23T13:45:00.000Z",
  "proc": "main"|"renderer"|"exthost"|"gpu"|"utility",
  "pid": 12345, "uptimeSec": 3600,
  "rss": 230000000,
  "heapUsed": 85000000, "heapTotal": 130000000, "heapLimit": 4290000000,
  "external": 5000000, "arrayBuffers": 0,
  "handles": 11, "activeRequests": 0,
  "windowId": 87654321,           // renderer only
  "workspaceHash": "1a2b3c4d",    // renderer only
  "idleSec": 1800,                // renderer only (when focused)
  "gcCount": 4, "gcMajorCount": 0, "gcTotalMs": 12.3,
  "note": "first-tick",
  "report": { ... }               // optional subset (W.13)
}

// crash/exit correlation entry:
{
  "v": 1, "type": "crash"|"exit", "ts": "...",
  "proc": "renderer", "pid": 6789, "windowId": 87654321,
  "reason": "oom", "exitCode": -536870904,
  "lastTickRef": "2026-05-23T13:40:00.000Z"
}

// heap-snapshot entry:
{
  "v": 1, "type": "snapshot", "ts": "...",
  "proc": "main", "pid": 12345,
  "path": ".../snapshots/...",
  "sizeBytes": 52428800,
  "trigger": "threshold"|"slope"|"manual"|"signal"
}
```

Backward-compat: lines without `v` and `proc` (pre-W.0) are treated as `v:1, proc:'main'`.

## See also

- `docs/knowledge/runtimeQuirks/idleMemory.md` — incident retrospectives + tool intro.
- `docs/roadmap.md` section W — full evolution plan (W.0–W.50).
