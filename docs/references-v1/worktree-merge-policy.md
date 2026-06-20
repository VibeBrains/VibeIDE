# Git worktree merge policy (agent isolation)

## Who merges into the main branch

- **Default:** only the **human operator** merges an agent worktree into the primary working tree (`mergeWorktree` after explicit approve in UX). Agent sessions suggest but do not silently merge without user approval.
- **Lead session:** if several agent threads exist, designate one **lead** workspace session (manual choice or future UX). Only the operator or that lead invokes merge for a given `worktreeId`; other sessions must not duplicate merge calls into the same main tree.

## Conflicts

- On merge, **existing** **`VibeMergeConflictService`** (and standard Git conflict UI in the worktree) handles conflicts: user resolves in the IDE, then resumes merge/applies.
- This document does **not** replace checkpoint mutex semantics — merges still serialize through **`IVibeCheckpointCoordinator`**.

## Telemetry / audit

- Worktree lifecycle events (`onWorktreeCreated` / merge) remain the extension points for future audit annotations.
