# Checkpoint coordinator (`IVibeCheckpointCoordinator`)

Single **promise chain** mutex per workbench window for workspace-critical snapshot operations.

## Current integrations

| Operation | Op label | Notes |
|-----------|---------|--------|
| Rollback snapshot create | `rollback:createSnapshot` | `RollbackSnapshotService` |
| Rollback snapshot restore | `rollback:restoreSnapshot` | same |
| Rollback snapshot discard | `rollback:discardSnapshot` | same |
| Git worktree merge hook | `worktree:merge` | `VibeGitWorktreeService` |
| Multi-agent checkpoint stub | `multiagent:createCheckpoint` | `VibeMultiAgentService` |

## Backlog

- **Chat `CheckpointEntry`** (`chatThreadService` void snapshots) — still synchronous and not routed through this coordinator; parallel UI + agent mutation risk remains until refactored (`docs/roadmap.md` § B.1).
- **Explicit waiter queue / timeout / cancellation** — extend coordinator API when multi-session contention appears in telemetry.
