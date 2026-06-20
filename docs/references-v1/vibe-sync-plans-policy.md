# VSCodeSyncFiles / cloud sync vs `.vibe/plans`

**Context:** Git merges two branches that both touched the same `*.plan.md` or `.steps.json`, or a cloud folder sync conflicts with local git.

**Policy (MVP):**

1. **Git is source of truth** for versioned plans. Resolve merge conflicts in the Markdown + embedded JSON block explicitly; do not leave conflict markers inside the fenced `json` machine block.
2. **Cloud sync (no git):** on conflict, default to **newest `mtime` wins** for the whole file; user should export a compliance copy before risky sync (`vibe-session-export --embed-plan-steps`).
3. **`.steps.json` sidecar (if introduced):** treat like `package-lock.json` — one side wins; no auto-merge of step state.

**UI backlog:** optional "Apply local" / "Apply remote" for plan artifacts when sync tool reports a conflict.
