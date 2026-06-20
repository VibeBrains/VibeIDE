# Single writer for machine-readable plan steps

**Context:** `.vibe/plans/*.plan.md` may gain a sidecar `.steps.json` or embed JSON. The IDE custom editor, CLI (`vibe run`), and agent runtime can all update step state.

**Rule:** At most one writer "owns" transitions for the canonical step list at a time.

1. **IDE / agent (preferred):** use `IFileService` temp + rename (same pattern as `writePlanMarkdown` retries in `vibePersistedPlanService`).
2. **CLI / scripts:** if a `.steps.json` exists, obtain an advisory lock file (e.g. `.vibe/plans/.locks/<planId>.steps.lock`) or refuse with a clear error when the IDE holds an execution lease (`.vibe/plans/.leases/`).
3. **Human merge:** never hand-merge two copies of machine JSON; pick one side, then rerun `vibe doctor` / plan dashboard reload.

**Rationale:** Avoids torn writes and "ghost" step states after crash mid-save.
