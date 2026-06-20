# A2UI allowed-commands allowlist

> Status: normative — security policy.
> Source roadmap entry: K.2 — «A2UI positive whitelist (Agent-rendered UI)».
> Change procedure: any addition / removal requires a PR with label `a2ui-allowlist-change`
> and a reviewer outside the original author.

## Why an allowlist, not a prefix filter

The current `VibeAgentRenderedUIService` filter accepts any command starting with
`vibeide.*`. That is a **negative** filter — it grows by accident. With Project Commands
shipping as a separate feature, the registered command id `vibeide.commands.run.<id>`
becomes a model-controllable shell-execution surface. A model that emits an
`action_buttons` block targeting `vibeide.commands.run.deploy-prod` would run shell code
without the consent dialog the rest of the agent path enforces.

A2UI must therefore use a **positive** allowlist. Any command not in the list is rejected
silently (logged at debug level, never bubbled to the model). Adding a command to this
list is an explicit security decision recorded in git history.

## Allowlist (initial)

| Command id                              | Why it is safe                                         |
|-----------------------------------------|--------------------------------------------------------|
| `vibeide.openSettings`                  | Read-only navigation, no side effects.                 |
| `vibeide.context.attachApiSpec`         | Adds context, gated by mention pipeline.               |
| `vibeide.skills.pickSession`            | Opens picker, user must explicitly select.             |
| `vibeide.skills.showFolder`             | Opens folder, no execution.                            |
| `vibeide.skills.newTemplate`            | Creates a stub file under `.vibe/skills/` only.        |
| `vibeide.plans.newInWorkspace`          | Creates `.vibe/plans/<id>.plan.md` only.               |
| `vibeide.plans.showPlansFolder`         | Navigation only.                                       |
| `vibeide.plans.bindingSnapshot`         | Read-only snapshot.                                    |
| `vibeide.plans.findSimilar`             | Local search, no execution.                            |
| `vibeide.plans.explainRisk`             | Read-only analysis.                                    |
| `vibeide.copyIssueReport`               | Clipboard write only.                                  |
| `vibeide.context.pickDiagram`           | Opens picker.                                          |
| `vibeide.context.previewDiagram`        | Read-only preview.                                     |
| `vibeide.chat.cycleMode`                | Local UI state only.                                   |

## Explicitly disallowed (examples — non-exhaustive)

- `vibeide.commands.run.<id>` — Project Commands shell execution. Must always go through
  the consent dialog, never via `action_buttons`.
- `vibeide.skills.importCommunityUrl` — fetches and writes content; consent must be
  user-driven.
- `vibeide.skills.saveAsFromChat` — writes new files under `.vibe/skills/`.
- `vibeide.emergencyStopAllAgents` — destructive (terminates running sessions).
- `workbench.action.*` — VS Code core commands; out of scope for A2UI.
- `vscode.*` — extension-host commands; not part of VibeIDE security perimeter.

## Implementation notes

- `VibeAgentRenderedUIService.isAllowedCommand(commandId: string): boolean` reads from
  this list at module load (the list is compiled into the bundle, not hot-reloaded — that
  prevents a malicious skill from rewriting it at runtime).
- The list is duplicated **nowhere**. Adding a command means editing this file and the
  service in the same PR.
- A unit test (`vibeAgentRenderedUIService.allowlist.test.ts`) iterates this table and
  asserts `isAllowedCommand(id) === true` for every row, plus a small set of negative
  cases.

## Backlog

- Wire the actual `VibeAgentRenderedUIService` against this list (currently the prefix
  filter still ships).
- Add CI check: PRs that touch the allowlist source must also touch this document, or CI
  fails with `a2ui-allowlist-change required`.
- Add a `vibe doctor` warning if the allowlist source diverges from the table here.
