# Documentation policy — `docs/` is the single center

> Status: normative.
> Audience: maintainers + AI assistants that read the repo.
> History: this supersedes the old "both `docs/` and `references/` are local-only"
> policy. Contracts were relocated into `docs/` and tracked on 2026-06-20
> (commit `23db622f`); the stale `references/v1/` mirror and the heavy
> `references/` design assets were retired on 2026-07-19.

## TL;DR

**All documentation lives under `docs/` and is tracked in git.** There is no
local-only doc tree anymore. Do not scatter docs elsewhere in the repo.

| Location | Purpose |
|---|---|
| `docs/` | Single center for all documentation — roadmap, vision, functional catalog. |
| `docs/references-v1/` | Normative contracts, runbooks, policies (this file lives here). |
| `docs/knowledge/` | Domain-split knowledge base (footguns, invariants, recipes) + index. |
| `docs/manuals/` | Step-by-step how-to guides. |
| `media/` | Tracked brand assets (logo, icons) used by README and branding scripts. |
| `VibeIDE-pre/` (sibling, **out of repo**) | Heavy design inspiration — drafts, PSDs, AI images. **Nothing in the repo references it.** |

## Rules

- **Add a new contract/runbook** → `docs/references-v1/*.md`. Confirm it describes
  an invariant code must satisfy and names files/functions/commit hashes.
- **Add knowledge** → `docs/knowledge/<domain>/` + a line in `docs/knowledge/README.md`
  (an entry without an index line does not exist — gated by `npm run docs-graph-check`).
- **Brand asset** → `media/`. If a build script or README needs it, it must be
  tracked (not gitignored).
- **Never commit** private credentials, internal team URLs, or secrets — the repo
  is public, so everything under `docs/` is public too.
- **Heavy binaries / inspiration** (image drafts, PSDs, one-off scripts) → archive
  to the sibling `VibeIDE-pre/`, never referenced from the repo.

## What is NOT tracked

Only local scratch: `docs/.obsidian/`, `docs/**/*.canvas`, `docs/**/*.base`
(see `.gitignore`). Everything else under `docs/` ships with the repo.
