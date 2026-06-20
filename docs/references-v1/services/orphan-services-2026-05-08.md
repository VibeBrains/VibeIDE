# Orphan services — 2026-05-08 inventory snapshot

> Source: `node scripts/vibe-services-inventory.js --orphans` run 2026-05-08.
> Purpose: every service file that exists under `src/vs/workbench/contrib/vibeide/**` but
> is not mentioned by name in `docs/roadmap.md`. Each row below either documents what the
> service does so a future reviewer can decide what to do with it, or links to the
> roadmap entry that should mention it.

L.1 acceptance: every service has a row here, and the row links to one of:
1. an existing roadmap entry that we just need to update with the service name,
2. a new `[ ]` roadmap row to add,
3. a removal proposal because the service duplicates another or is dead code.

## browser

### `vibeProjectsService.ts`

Workspace bookmark catalog. Stores a list of `IVibeProjectsEntry` (path + display name +
last-opened time) under `<profile>/globalStorage/vibeide/workspace-bookmarks/catalog.json`.
Powers a "Recent VibeIDE projects" picker that is independent of the upstream `recentlyOpened`
list (so that uninstalling/reinstalling does not break the picker).

**Action:** add to roadmap UX section as `[x] Recent projects picker — vibeProjectsService.ts`.
No further work needed.

### `vibeWorkspaceFormsService.ts`

Form-driven editor for `.vibe/*.json` files (mirrors the design called out for the Unified
`.vibe/` Config Panel in the K-section). Currently provides the form runtime; the panel UI
that consumes it is partially built.

**Action:** roadmap row: `[~] Unified .vibe Config Panel — form runtime in
vibeWorkspaceFormsService.ts; panel UI tied to that runtime is the missing piece.`

### `vibeideCommandBarService.ts`

Top-of-window command bar (separate from Project Commands `[ ]` MVP). Implements the
existing «toolbar» shown next to Command Center. Tightly coupled to upstream
title-bar contributions.

**Action:** add an explicit `[x]` roadmap row in UX section pointing here so future readers
do not confuse this with Project Commands top-bar (they are different surfaces).

### `vibeideOnboardingService.ts`

Drives the first-run wizard's runtime (separate from `vibeFirstRunWizard.ts` UI). Holds
step state, tracks which providers were configured, decides whether onboarding is "done".

**Action:** add to UX «Onboarding» row in roadmap. No code change needed; the service is
coherent and tested via wizard usage.

### `vibeideSCMService.ts`

Bridges VibeIDE's Co-authored-by trailer policy with the upstream SCM input box. When the
user commits, the service injects the agent identity if the diff contains AI-touched
ranges (read from `VibeGutterIndicatorService`).

**Action:** roadmap row: `[x] Agent git identity — vibeideSCMService.ts injects Co-authored-by
trailer based on VibeGutterIndicatorService ranges.`

## common

### `vibePromptLibraryService.ts`

Workspace `.vibe/prompts/*.md` library: parse, list, expand `$VARIABLE` placeholders. Used
by `/my:<name>` slash command.

**Action:** roadmap row exists for `.vibe/prompts/`; just append the service name to the
existing `[x]` line so the inventory script picks it up.

### `vibeStructuredOutputService.ts`

Provider-side wrapper for tool-call structured outputs (JSON Schema enforcement). Used by
`vibeide.agent.preferJsonToolArguments` setting. Active in Agent mode.

**Action:** roadmap row exists in the K.3 «Structured outputs» line as `[x]`; append
service name.

### `vibeideModelService.ts`

In-process model selection cache: maps `(providerId, modelId)` to a small object with
context window, pricing per-token, and capability flags (vision / structured outputs /
streaming). Replaces ad-hoc lookups in 5+ call sites.

**Action:** roadmap row: `[x] Model capability cache — vibeideModelService.ts (Phase 1)`.

### `vibeideSettingsService.ts`

Top-level VibeIDE settings store (per-provider settings, model overrides, autodetected
models, MCP states, global feature flags). The settings React panel reads/writes through
this service.

**Action:** trivially central; ensure the K-section roadmap line on the Unified Config Panel
references it explicitly.

### `vibeideUpdateService.ts`

Renderer-side counterpart to `vibeideUpdateMainService.ts`. Bridges download progress and
SHA256 verification IPC into React state for the «Update available» toast.

**Action:** roadmap row exists in Phase 1 «Автообновление»; append service name.

## electron-main

### `vibeideSCMMainService.ts`

Main-process SCM bridge. Handles operations that need filesystem access (write a commit
message into `.git/COMMIT_EDITMSG`, query rebase state) outside the renderer sandbox.

**Action:** roadmap row exists in `vibe commit` / Agent git identity sections; append the
main-process service name there too.

## Summary

| Service                          | Action     |
|----------------------------------|------------|
| vibeProjectsService              | doc-only   |
| vibeWorkspaceFormsService        | mark `[~]` |
| vibeideCommandBarService         | doc-only   |
| vibeideOnboardingService         | doc-only   |
| vibeideSCMService                | doc-only   |
| vibePromptLibraryService         | doc-only   |
| vibeStructuredOutputService      | doc-only   |
| vibeideModelService              | new `[x]`  |
| vibeideSettingsService           | doc-only   |
| vibeideUpdateService             | doc-only   |
| vibeideSCMMainService            | doc-only   |

«doc-only» = no roadmap behaviour change, just a paragraph above the relevant `[x]`
row referencing the service file. Done in this run for the inventory.

`[~]` recommendations: the only true partial is `vibeWorkspaceFormsService` (form runtime
exists, consumer UI doesn't yet). Everything else either is in production or explicitly
matches an `[x]` row already.
