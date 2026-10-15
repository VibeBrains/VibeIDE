# Project Commands — contract and design

> Status: design / contract document. The MVP implementation is skeleton-acceptable until
> the top-bar UI lands.
> Source roadmap entry: «Project Commands (быстрый бар проекта)».

Project Commands are workspace-first shell shortcuts surfaced in the IDE's top bar.
They are **distinct** from `.vscode/tasks.json` and from `VibeWorkflowService`. The
commands themselves are stored under `.vibe/commands.json` (workspace-first) plus an
optional set of global paths configured by the user.

## Why this exists separately from `.vscode/tasks.json`

- **Visibility.** Tasks live in the Run menu and command palette. Project Commands are
  pinned in the top title bar — one click away.
- **Per-project keybindings.** `.vibe/commands.json` registers each command in the
  command registry as `vibeide.commands.run.<id>` so VS Code keybindings target them.
- **Trust boundary.** Consent on first run is kept in the IDE profile storage, per project folder, outside the repository.
- **Multi-root.** Each workspace folder has its own command set; conflicts on `id` favor
  the workspace folder over global.

## Why this exists separately from `VibeWorkflowService`

Workflows are **LLM-driven** orchestration of multiple steps. Project Commands are
**user-driven** shell shortcuts — they do not call the model. A workflow may declare a
Project Command as one of its steps via `workflowId?` reference, but a Project Command
on its own never invokes the agent.

## Schema (excerpt)

The full schema mirrors `vibeide.skills.globalPaths` and lives at
`src/vs/workbench/contrib/vibeide/common/schemas/project-commands.schema.json` once
implementation lands. Excerpt:

```jsonc
{
  "$schema": "https://schemas.vibeide.io/project-commands/v1.json",
  "vibeVersion": "0.3.0",
  "commands": [
    {
      "id": "build",
      "name": "Сборка проекта",
      "description": "Полная компиляция TypeScript",
      "icon": "tools",
      "color": "terminal.ansiBlue",
      "command": "npm",
      "args": ["run", "compile-build"],
      "cwd": ".",
      "terminal": "integrated",
      "confirm": false,
      "singleton": true,
      "pinned": true,
      "order": 1
    }
  ]
}
```

## Migration from `.vscode/tasks.json`

Palette command `VibeIDE: Import project commands from tasks.json` reads
`.vscode/tasks.json` and produces a preview of the import. Mapping:

| `tasks[]` field        | `commands[]` field |
|------------------------|--------------------|
| `label`                | `name`             |
| `command`              | `command`          |
| `args`                 | `args`             |
| `options.cwd`          | `cwd`              |
| `presentation.reveal`  | `terminal`         |

Tasks with `type: "shell"` import as `terminal: "integrated"`. `type: "process"` imports
as `terminal: "background"`.

## Security policy

- **First-run confirm.** Any new command id triggers a consent dialog before execution.
  Consent persists in the IDE profile storage (SHA-256 fingerprint of the command). A legacy
  `.vibe/commands.trust.json` is not read. An untrusted workspace (Workspace Trust) is asked every time.
- **Sanitization on import.** Community packs go through
  `IVibePromptGuardService.sanitizeFileContent` before write — zero-width chars, Bidi
  controls, and known injection patterns are stripped.
- **`cwd` containment.** A `cwd` outside the workspace root (after realpath resolution)
  is rejected.
- **Shell metachars.** Without `shell: true`, args containing shell metacharacters are
  rejected at run time. With `shell: true`, the user is shown a stronger consent dialog.
- **Stealth / privacy.** `command` strings and `env` values are never sent to cloud
  indexers or logged into audit (the `command` id and exit code are; the rest is not).

## Audit (opt-in)

`vibeide.commands.audit = true` enables:

- One audit record per run with: `id`, `name`, exit code, duration ms, cwd (basename
  only), platform.
- `env` values are never recorded.
- `stdout` is recorded only when `vibeide.commands.auditStdout = true` (separate, default
  off).

## CLI

- `vibe commands list --json` — for CI and external scripts.
- `vibe commands run <id>` — runs the command, exit code propagates.
- `vibe doctor` validates schema, slugs, duplicate ids, missing `command`.
- `vibe doctor --repair` adds missing `vibeVersion`.

## Status of MVP

This document is the contract; the implementation lands incrementally:

- **Phase A (skeleton):** schema + `IVibeCustomCommandsService` interface + JSON Schema
  file. Throws `ProjectCommandNotImplementedError` from `run()` so UI can render the
  "needs work" badge.
- **Phase B:** palette commands (Run / Add / Edit / Delete / Open .vibe/commands.json).
- **Phase C:** top-bar contribution with pinned commands, default keybindings
  `Ctrl+Shift+Alt+1..9` for top 9.
- **Phase D:** `VibePromptGuardService` integration + community marketplace.
- **Phase E:** CLI subcommands, audit, onboarding hint.

Each phase opens its own roadmap line for tracking; this document evolves alongside.

## Backlog

- Wire the schema file once Phase A lands.
- Decide whether `singleton` is per-window or per-workspace; current design is per-window.
- Decide whether pinned commands sync via VSCodeSyncFiles (probably no — workspace-local).
