# AI rules and Agent Skills — context parity (VibeIDE)

**Normative path:** this file lives under `references/v1/` because `docs/` is gitignored in the fork. Roadmap item H.0 references the equivalent logical doc path `docs/v1/`.

## Stack priority (highest wins first)

Product architecture (Фаза 0): **Enterprise locked → Global → Profile → Directory → Mode**. Project rules and skills **do not** override enterprise locks; they add *guidelines* inside the allowed envelope.

## Project rules / guidelines (chat system message)

**Source:** `convertToLLMMessageService._getCombinedAIInstructions()`.

| Source | Location | Merge order |
|--------|----------|-------------|
| Settings | `globalSettings.aiInstructions` | First block |
| Per-workspace-root files | `.voidrules`, `.vibe/rules.md`, root `AGENTS.md` | For each folder: read the three if an editor model exists; concatenate with blank lines in that order, then append the next folder’s bundle |
| Final shape | — | `globalAIInstructions` then `vibeRulesFileContent`, joined with `\n\n` |

**Injection label:** the system appendix uses the phrasing *GUIDELINES (from workspace .voidrules, .vibe/rules.md, and/or AGENTS.md)* when rules are present — individual files are not separately labelled in the string today.

**Chat modes (`normal` | `gather` | `plan` | `agent`):** guidelines are included for all modes that build the main chat system message; Plan mode also forces read-only tooling in prompts (`prompts.ts`). Gather is read-only for mutations; Agent enables write/MCP per constraints.

**Quick Edit / inline completions:** not identical to full chat system assembly; Quick Edit reads the first existing file among `.cursorrules` | `.voidrules` | `.rules` (legacy single-file discovery) — see Quick Edit contribution, not `_getCombinedAIInstructions`.

## Limits and truncation

- **Global settings:** governed by existing VibeIDE settings for AI instructions length where applicable.
- **Token pressure:** standard chat caching (`_systemMessageCache`) keys off workspace paths, opened editors, and active editor — large monorepos should rely on `.vibe/ignore` and tool-based reads.
- **Graceful degradation:** if a rules file is not opened in an editor model, `getModel()` may not see disk-only content until the file is touched in the workbench — backlog: explicit file service read for guidelines.

## Agent Skills (`.vibe/skills/`)

**Runtime:** `IVibeSkillsLibraryService` + slash **`/skill:<id>`** expansion in `vibeSlashCommandService`; discovery text in GUIDELINES via `getDiscoveryText(chatMode)`; optional session filter and global paths `vibeide.skills.globalPaths`.

**Contrast with prompts:** `.vibe/prompts/` are templates invoked as `/my:name`; skills are `SKILL.md` trees with frontmatter and optional packs — see `references/v1/agent/skills.md` (if present) and `skill-package.schema.json`.

## File name contract (import parity)

| Path (workspace root) | Chat GUIDELINES (`_getCombinedAIInstructions`) | Quick Edit chain (first match) |
|-----------------------|-----------------------------------------------|--------------------------------|
| `.voidrules` | Yes (when model loaded) | Yes |
| `.vibe/rules.md` | Yes | No |
| `AGENTS.md` | Yes | No |
| `.cursorrules` | No (backlog H.1) | Yes |
| `.rules` | No | Yes |
| `.cursor/rules/*.md`, `.mdc` | No (backlog H.1) | No |

Order within chat bundle: per folder, `.voidrules` then `.vibe/rules.md` then `AGENTS.md`; multiple roots append in folder order.

## Secret detection (policy)

Before expanding user‑defined rules/skills into the model context, content must pass the same sanitization layers as other user markdown (`IVibePromptGuardService` on slash expansions). **New work:** run `ISecretDetectionService` on guidelines files before inject — roadmap H.0/H.1.

## Future: `.cursor/rules` parity

**Not yet in `_getCombinedAIInstructions`:** recursive `.cursor/rules/*.md` and `.mdc`. H.1 tracks watch + merge order.
