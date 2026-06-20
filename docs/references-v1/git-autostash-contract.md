# Git auto-stash policy — service boundary

> Status: normative.
> Source roadmap entry: roadmap §988 (`gitAutoStashService.ts` interaction with `VibePartialRollbackService` and checkpoint).

## Why this document exists

Three rollback / restore mechanisms can fire on the same agent edit:

1. **`IGitAutoStashService`** (`common/gitAutoStashService.ts`) — git-level stash before the agent writes.
2. **`IVibePartialRollbackService`** — file-level rollback after a failed apply.
3. **`IVibeCheckpointCoordinator`** — exclusive lock around any stash / rollback / snapshot phase.

Without an explicit ordering, three concurrent restore attempts can compete for the same working tree, producing partial states that the user cannot reproduce. This document fixes the contract.

## Decision policy (`autoStashPolicy.decideAutoStash`)

Pure helper. Evaluation order, first-match-wins:

1. Any `editTargets` member is `'agent-protected'` per `IVibePerFilePermissionsService` → **stash** (reason: `protected-target`). Wins **even when** setting is `'never'`.
2. `setting === 'always'` → **stash** (reason: `always`).
3. `setting === 'never'` → **skip** (reason: `never`).
4. `setting === 'dirty-only'` AND any edit target is dirty → **stash** (reason: `dirty-files`).
5. `dirty-only` with clean targets → **skip** (reason: `no-dirty-no-protected`).

## Settings

| Key                                | Type    | Default      | Scope     |
|-----------------------------------|---------|--------------|-----------|
| `vibeide.safety.autostash.enable` | boolean | `true`       | resource  |
| `vibeide.safety.autostash.mode`   | enum    | `dirty-only` | resource  |

Both registered in `gitAutoStashService.ts` registerConfiguration block (commit landed in this session). Service-level `isEnabled()` is `enable === true && mode !== 'never'`; per-call `decideAutoStash` always evaluates the protected-target override first regardless of `isEnabled()`.

## Interaction with `VibePartialRollbackService`

- **autostash runs BEFORE the agent writes** (preventive). On apply success, stash is dropped.
- **partial rollback runs AFTER an apply fails** (corrective). It restores file content from per-file snapshots taken at apply-time, NOT from the autostash.
- The autostash is a **fallback** when partial rollback also fails — user can manually `git stash pop` the autostash entry.

## Interaction with `IVibeCheckpointCoordinator`

All three phases (`stash:create`, `rollback:restore`, `snapshot:create`) MUST run inside `coordinator.runExclusive({op})` to serialise working-tree mutation. Concurrent agent edits go through the same coordinator queue.

## What auto-stash does NOT do

- It does **not** cover untracked files outside the workspace root (use `git stash --include-untracked` semantics — covered by `git.stashIncludeUntracked` invocation).
- It does **not** restore on EH crash automatically — the stash entry remains until user manually pops it (or runs `vibe agent reset-leases` which surfaces orphan stash refs).
- It does **not** try to merge conflicting hunks if `git.stashPopLatest` reports conflicts — falls back to `git.stashApplyLatest` so the conflicts surface to the user explicitly.

## Notification contract

- Stash created: `Severity.Info`, non-sticky, message includes stash ref.
- Stash popped on success: silent (default behaviour).
- Stash apply on conflict: `Severity.Info` notification informing user to inspect Git: Stashes view.

Audit log entries: `git:stash`, `git:stash:restore` — both with `meta.stashRef` and `meta.operationId`.
