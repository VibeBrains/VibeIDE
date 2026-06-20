# VibeIDE Background / Unattended Agent

**Version:** 1.0 (Phase J — MVP documentation)  
**Status:** Architecture + threat model defined; runner MVP — see `scripts/vibe-agent-run.js`

---

## § J.0 What this is NOT (to avoid duplication)

| Already exists | Where |
|---|---|
| Dynamic context filtering / sandbox aggregation (Claude Code pattern) | § F — "tool results compression" within one session |
| Task queue during live workbench | `VibeAgentTaskQueueService` + persisted plans (§ A) |
| Speculative exploration in worktrees | `VibeGitWorktreeService` + `VibeSpeculativeExplorationService` |
| Ambient agent (opt-in monitoring) | `VibeAmbientAgentService` — suggestions at end of session, not autonomous runs |

---

## § J.1 Competitor comparison

| Product | How their background agent works | What we copy | What we do NOT copy |
|---|---|---|---|
| **Cursor Background Agents** | Isolated VM (GitHub Codespace), bound to GitHub repo, async PR creation, pays from Cursor subscription | UX: "agent works while you sleep", PR-native finish | Cloud-only requirement, implicit GitHub access, Cursor subscription |
| **GitHub Copilot workspace** | Cloud GitHub Actions runner, triggered by issue, outputs PR | Long-running task model, morning digest concept | Mandatory GitHub cloud, no local option |
| **Devin-like agents** | Full autonomous cloud VM, credit-per-session billing | Context isolation (§ I already implements), structured handoff | Opaque cloud VM, implicit secrets access, per-action billing without user ceiling |
| **Local CLI agents (Aider headless)** | `aider --yes` in cron/shell script | Headless, local-first, no cloud dependency | No audit trail, no DMS, no budget enforcement |

### What VibeIDE takes from each

- **Isolation**: context isolation via subagents (§ I); worktree isolation for file writes (§ B.3)
- **Local-first**: runner is a CLI process on the user's machine — no mandatory cloud
- **Morning digest**: `.vibe/jobs/<id>.json` + `docs/vibe-morning-digest.md` artifact
- **PR-native**: optional branch + draft PR via SCM after success

### What we deliberately do NOT copy

- No mandatory cloud connection
- No implicit repo access (secrets never in job file in git)
- No "always-on" ambient compute without explicit user trigger

---

## § J.1 Minimal unattended threat model

### Who can trigger unattended execution?

| Trigger | Risk | Mitigation |
|---|---|---|
| User runs `vibe agent run <job>` explicitly | Low — user intent | Require job file in `.vibe/jobs/` |
| OS cron / systemd triggers `vibe agent run` | Medium — runs while asleep | `"safeWindow"` field in job: only run in time range |
| IDE "Start Background Agent" button | Low — user intent | Confirmation dialog if high-risk tools in allowlist |

### What is "night safe" by default?

| Action | Night-safe default | Override |
|---|---|---|
| `read_file`, `grep`, `list_dir` | ✅ Always allowed | — |
| `write_file`, `edit_file` | ✅ Allowed if within job scope | `allowedPaths` in job descriptor |
| `run_terminal_command` | ⚠ Allowed only in `implement-step` allowlist | `allowedCommands` in job descriptor |
| `git push`, external MCP calls | ❌ Blocked by default in unattended | Set `allowGitPush: true` in job |
| High-risk tools (browser, arbitrary exec) | ❌ Blocked by default | Explicit opt-in per tool |

### DMS for unattended

Dead Man's Switch runs differently in unattended mode:
- No UI interaction expected → DMS timeout does NOT pause the job for UI confirmation
- Instead: timeout → graceful stop + write `status: paused_dms` to job file + optional desktop notification

### Budget enforcement

- `vibeide.safety.tokenBudget` global limit always applies
- Job descriptor can set `maxTokens` (hard ceiling per job run)
- When ceiling hit: `status: budget_exhausted` in job file; no silent over-spend

---

## § J.2 Architecture sketch

```
vibe agent run <job-id>
  └─ reads .vibe/jobs/<job-id>.json
      ├─ validates: constraints, safeWindow, budget ceiling
      ├─ creates checkpoint (§ B.1 mutex)
      ├─ builds task queue from planId or inline steps
      ├─ runs tool-loop (same executor as chatThreadService, headless)
      │   └─ delegates heavy steps to subagents (§ I)
      └─ writes morning digest to .vibe/ + emits job_completed audit event
```

Full implementation: Phase J.2 — `scripts/vibe-agent-run.js` (MVP stub)

---

## Related services

- `IVibeSubagentService` (§ I) — context isolation per step
- `IVibeCheckpointCoordinator` (§ B.1) — snapshot mutex
- `IVibeTokenBudgetService` — hard budget ceiling
- `IVibeConstraintsService` — deny_write/deny_read always inherited
- `IVibeAgentTaskQueueService` — step queue management
- `IVibeDesktopNotificationService` — morning digest notification
