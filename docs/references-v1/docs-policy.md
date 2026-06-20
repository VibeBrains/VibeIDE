# `docs/` vs `references/` — local-only documentation policy

> Status: normative.
> Source: roadmap §1000 (фиксация политики).
> Audience: maintainers + AI assistants that read the repo.

## TL;DR

Both `docs/` and `references/v1/` are **local-only**. Neither is committed.
The `.gitignore` enforces this:

```
docs/
references/*
!references/logo-final.png
```

Anything that needs to ship to a public website (`vibeide.io` style)
lives in a **separate repository**, not here.

## Why two folders

| Folder            | Audience                                    | Examples                                      |
|-------------------|---------------------------------------------|-----------------------------------------------|
| `docs/`           | Future public-site copy. Roadmap. Vision.   | `roadmap.md`, `monetization.md`, `vision/`.   |
| `references/v1/`  | Maintainer + AI internal contracts.         | `agent-locks-contract.md`, `*-policy.md`.     |

Cross-pollination rule: if a `references/v1/*.md` becomes user-facing (e.g.
"how to add a locale"), copy the relevant content into the public-site repo.
Do not commit `docs/` or `references/v1/` here.

## Why local-only

- The repository is a VS Code fork; upstream merges churn `docs/` for
  unrelated reasons. Keeping our docs out of git history simplifies merges.
- Some `references/v1/` docs contain partial threat models, allowlists, and
  internal coordination notes that should not be public until reviewed.
- AI agents (Copilot/Claude/Cursor) reading the repo find the
  internal-contracts in `references/v1/` *only when running locally* — they
  cannot leak via shared remotes.

## Not committed (and why) checklist

Before adding a new `references/v1/*.md`, confirm:
- [ ] Content describes a **contract** (an invariant code must satisfy).
- [ ] Content names files / functions / commit hashes — not user instructions.
- [ ] Public-facing parts (e.g. installation guide) go to the public-site repo.

Before adding a new `docs/*.md`, confirm:
- [ ] Content describes future public-site material — vision, roadmap, FAQ.
- [ ] No private credentials, internal team URLs, or unreleased-product names.

## Migration: parenthetical workarounds → this doc

Earlier roadmap text said things like "docs/ в gitignore — артефакт в
references/v1/`. Those parentheticals are now redundant: this document
is the single source. New roadmap entries should reference
`references/v1/docs-policy.md` instead of restating the rule inline.
