# VibeIDE Extension API — stability policy

> Status: normative.
> Source roadmap entries: «Разработать VibeIDE Extension API», «API stability policy».

VibeIDE exposes two API surfaces to extensions:

1. The **upstream VS Code API** (`vscode.d.ts`) — unchanged from the merged upstream
   version. Stability follows VS Code's own policy.
2. The **VibeIDE-specific API** (`vscode.proposed.vibeide.d.ts`) — exposes agent, plans,
   skills, constraints, and other VibeIDE primitives.

This document defines the lifecycle and stability guarantees of the VibeIDE-specific API.

## Stability tiers

### `proposed`

- Lives in `vscode.proposed.vibeide-<feature>.d.ts`.
- Available only to extensions that explicitly opt in via `enabledApiProposals` in their
  manifest (matches the upstream `proposed` API gate).
- Can break in any minor `vibeVersion` bump. Breaking changes are flagged in release
  notes under `## ♻️ Внутреннее` with a `proposed-api` tag.
- Default home for everything new. Promotion to `stable` happens only when a feature has
  been in `proposed` across at least one minor cycle and no breaking change is anticipated.

### `stable`

- Lives in `vscode.vibeide.d.ts` (no `proposed-` prefix).
- Public API. Breaking changes require a major `vibeVersion` bump (semver).
- Deprecation: a `@deprecated` JSDoc tag is added at least one **minor** version before
  removal. Removal happens only at the next major.
- Migration: every removal documents a replacement API or a workaround in the
  `docs/v1/extension-development.md` migration section.

### `legacy` (terminal)

- Once an API is deprecated, it can be marked `legacy` in the same release. Extensions
  that depend on a `legacy` API still compile but get a console warning at activation
  time.
- A `legacy` API is removed in the **next major** version after it became `legacy`.

## What goes in `proposed` vs `stable` (rule of thumb)

- Anything that touches agent runtime, plan persistence, or `.vibe/` semantics → starts in
  `proposed`. These services are still being shaped.
- Read-only accessors (e.g. `vibeide.skills.list`) can go to `stable` faster, because
  read-only contracts are easier to keep stable.
- Anything that modifies `permissions.json` or `constraints.json` programmatically stays
  `proposed` indefinitely until we have a reviewed security model for extension-driven
  policy changes. Default answer: do not let extensions write policy files.

## Versioning

The header comment of every `*.d.ts` file declares:

```ts
// VibeIDE Extension API — proposed
// Available since: vibeVersion 0.3.0
// Stability: proposed (subject to breaking changes)
// See: references/v1/extension-api-stability.md
```

Both `proposed` and `stable` files emit the `vibeVersion` they were introduced in. We do
**not** version individual API symbols — file-level "since" is enough granularity for now.

## Deprecation example

```ts
/**
 * @deprecated since vibeVersion 1.2.0. Use {@link runWithBudget} instead.
 * Removed in vibeVersion 2.0.0.
 */
export function runUntilDone(...): Promise<void>;
```

In the same release we add to `extensions/vibeide-sample/migration.md` a one-paragraph
migration note. Release notes have a `## ♻️ Внутреннее` entry: `Deprecated runUntilDone;
use runWithBudget`.

## Backlog

- Author the first cut of `vscode.proposed.vibeide.d.ts` with read-only accessors:
  `vibeide.agent.status`, `vibeide.skills.list`, `vibeide.plans.subscribeToEvents`,
  `vibeide.constraints.queryAllowed`.
- `extensions/vibeide-sample/` — scaffold extension that uses one of each surface as
  acceptance proof.
- A CI check that fails when a `*.d.ts` lacks the standard header.
