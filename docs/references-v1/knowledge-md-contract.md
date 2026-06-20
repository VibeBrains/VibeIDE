# knowledge.md Contract

`docs/knowledge.md` is the maintainer's durable log of non-obvious architectural findings.

## Purpose

Record footguns, race conditions, hidden service interactions, and invariants that would
surprise a reader who knows the codebase but hasn't hit this specific edge. Not a tutorial,
not a changelog — a warning system for the next person touching the area.

## Format

```markdown
## <Topic> (<date YYYY-MM-DD>)

<1–3 paragraphs. What happened, why it matters, what the invariant is.>

Refs: <commit hash or file:line>
```

One H2 section per finding. No H3 nesting. Ordered newest-first.

## Retention

- Sections are **permanent by default.** Knowledge does not expire by time alone.
- When the relevant code is rewritten: mark the section `(obsolete: <commit>)` and move it
  to the bottom of the file under `## Obsolete Findings`.
- Never delete — obsolete findings help understand git history.

## What belongs here

- Subtle invariant that broke something if violated (e.g. "disposal order matters here")
- Unexpected interaction between two services (e.g. "X and Y both write the same file — last-writer-wins race")
- Workaround for upstream VS Code behaviour that isn't obvious from the code
- A footgun discovered during roadmap-max or a debugging session

## What does NOT belong here

- Architecture overviews (use CLAUDE.md or .github/copilot-instructions.md)
- Changelog or task tracking (use roadmap.md or git log)
- Ephemeral debugging notes (use git stash or a local scratch file)
- Anything already in a code comment at the call site

## Location and git status

`docs/knowledge.md` is **local-only** — `docs/` is git-ignored. It lives in the working tree
and is never committed. Agents write to it after non-obvious discoveries; humans review and
prune after rewriting the relevant code.

## Staleness detection

`vibe doctor --knowledge` (via `scripts/lib/knowledge-md-staleness.cjs`) checks:

- If `docs/knowledge.md` is older than 30 days AND service files under
  `src/vs/workbench/contrib/vibeide/common/` have been edited since its mtime → warn.
- Otherwise → silent.

Run after major refactors to catch stale sections.
