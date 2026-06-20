# Plan steps — `worktreeBranch` and `explorationId`

Optional fields on persisted / in-memory **`PlanStep`** (embedded JSON in `*.plan.md`).

| Field | Meaning |
|-------|--------|
| **`worktreeBranch`** | Human/agent hint: execute this step against an isolated git worktree using this branch slug (must match `IVibeGitWorktreeService` conventions when runtime is wired). |
| **`explorationId`** | Link to a **`IVibeSpeculativeExplorationService`** session when the step is part of a speculative multi-branch flow. |

**Status:** schema + persistence + types are in-repo; **executor** routing (switch cwd / worktree before tool calls) remains backlog — do not assume the agent auto-switches worktrees yet.

See also: `references/v1/plan-steps.schema.json`, roadmap **§ C**.
