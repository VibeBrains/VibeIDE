# VibeIDE Subagents — Context Isolation Contract

**Version:** 1.0.0  
**Status:** MVP implemented; Phase 3b: real isolated runner

---

## Overview

Subagents are child agent sessions with **isolated context windows** and **separate token budgets**.  
The parent receives only a **compact, bounded result** (SubagentResult) — not the full tool-loop transcript.

This is distinct from multi-session (§ B): subagents have an explicit lifecycle managed by a single parent session.

---

## Principles (§ I.0)

### 1. Isolated transcript + budget

- Each subagent runs in its own context window; intermediate tool-calls do NOT merge into the parent context.
- The parent provides `SubagentHandoff.maxTokens` (hard ceiling on this subagent's token spend).
- Default: `min(20,000, parentRemainingBudget)`.
- The result returned to the parent is bounded by `MAX_RESULT_SUMMARY_CHARS = 500` chars per field.

### 2. Constraints + permissions inheritance — NEVER weakened

- The subagent uses the **same** `IVibeConstraintsService` instance as the parent.
- `deny_write` and `deny_read` rules from `.vibe/constraints.json` apply identically.
- `.vibe/permissions.json` per-file rules apply identically.
- Dead Man's Switch timer is inherited; the subagent cannot disable or reset it.
- The subagent **cannot** elevate its own permissions — it can only work within the parent's constraint envelope.

### 3. Lifecycle

```
spawn() → pending → running → completed / failed / skipped → dispose()
```

Parent calls `spawn(handoff)` → gets `subagentId` → calls `awaitResult(subagentId)` → receives `SubagentResult`.

Do NOT confuse with "second tab agent" (§ B multi-session): subagents are disposable, budget-bound, and managed by one parent session or plan queue.

---

## Tool Whitelists per Type

| Type | Allowed Tools |
|---|---|
| `explore` | read_file, list_dir, grep, glob, semantic_search |
| `implement-step` | read_file, write_file, edit_file, run_terminal_command, list_dir, grep |
| `recover-or-skip` | read_file, run_terminal_command, grep |

---

## Handoff JSON Schema

```json
{
  "parentThreadId": "thread-abc123",
  "type": "explore",
  "goal": "Find all API endpoints in src/vs/workbench/contrib/vibeide/",
  "acceptanceCriteria": "List of file paths + function names",
  "contextItems": ["src/vs/workbench/contrib/vibeide/"],
  "maxTokens": 5000,
  "maxSteps": 10
}
```

## Result JSON Schema

```json
{
  "subagentId": "subagent-explore-1234567890-abc1",
  "status": "success",
  "summary": "Found 12 API endpoint files. Key: toolsService.ts, chatThreadService.ts",
  "artifacts": ["src/vs/workbench/contrib/vibeide/browser/toolsService.ts"],
  "tokensUsed": 3200
}
```

---

## Comparison with OpenCode

VibeIDE subagents take inspiration from OpenCode's context isolation pattern:

| Aspect | OpenCode | VibeIDE |
|---|---|---|
| Context isolation | Yes (separate process) | Yes (separate context window; Phase 3b: separate process) |
| Constraints inheritance | N/A | Yes — always from parent, never weakened |
| Result size cap | Configurable | Hard 500-char cap per field (transparent to user) |
| Audit log | Optional | Always (subagent_spawned + subagent_completed) |
| Cloud requirement | No | No — local first |

---

## Audit Events

- `subagent_spawned`: `{ subagentId, type, parentThreadId }`
- `subagent_completed`: `{ subagentId, status, tokensUsed }`

No raw prompt content or file contents are included in audit meta.

---

## Phase 3b Roadmap

- Real isolated runner: spawn a sandboxed agent in a separate context window (same executor as chatThreadService, with context isolation flag)
- Worktree binding: `implement-step` subagent can run in a dedicated git worktree via `IVibeGitWorktreeService`
- UI: collapsible "Subagent …" card under parent turn with token count
- Compliance link: subagent_completed links to session export for full traceability
