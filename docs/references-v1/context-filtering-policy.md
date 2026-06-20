# VibeIDE — Dynamic Context Filtering Policy

**Version:** 1.0 (Phase MVP)  
**Status:** Service implemented; chatThreadService hook — Phase 3b

---

## Goal

Reduce context window bloat from intermediate tool results **without breaking the Transparency Suite**.

The tension: Claude Code / OpenCode compress tool-loop results aggressively (saves tokens, faster turns).  
VibeIDE's nарratif: "you see everything" — so we must not silently discard data the user expects to audit.

---

## Two Modes

### `raw` (default for standard tool results)

Every tool result is appended to the LLM context verbatim (up to the tool result size limit).  
**When:** tool returns ≤ 8 KB. User can replay full session via `vibe-session-replay.js`.

### `aggregate` (opt-in or automatic in `auto` mode)

Tool result is passed through `IVibeContextFilterService.compact()`:
- File reads > 8 KB → first N lines + `[... truncated at N lines, full file via read_file]`
- Search results > 20 hits → top 20 + count
- Terminal output > 4 KB → last 100 lines + head-10 lines + `[... truncated]`
- LLM-generated outputs → kept verbatim (never compressed by this layer)

**When:** context fill > 70% (`auto` mode) OR user explicitly set `aggregate`.

### `off`

No filtering — for debugging / compliance audit scenarios.

---

## Default: `auto`

```json
"vibeide.context.filterMode": "auto"  // auto | raw | aggregate | off
```

`auto` logic:
1. After each tool-call: check `IVibeContextGuardService.getStatus().percentUsed`
2. If ≥ 70%: switch this turn's tool results to `aggregate`
3. If < 70%: use `raw`
4. No state persisted between turns (evaluated per tool-call)

---

## Transparency guarantee

In `aggregate` mode:
- `VibeDebugPromptService.recordSnapshot()` receives **both** the full result AND the compact version
- The diff is visible in "Debug my prompt" panel
- User can switch to `raw` at any time without context reset
- No result is silently dropped — only truncated with an explicit `[... truncated]` marker

---

## Implementation surfaces

| Layer | Action |
|---|---|
| `IVibeContextFilterService` | `compact(toolName, result, mode, contextPct)` → filtered string |
| `chatThreadService._runToolCall` | After tool returns: `filterSvc.compact(...)` → append filtered to messages |
| `VibeDebugPromptService` | `recordSnapshot()` called with both full + compact in aggregate mode |
| `IVibeContextFilterService.getLastFilterStats()` | Exposed for status bar / transparency UI |

Phase 3b: wire hook into `chatThreadService._runToolCall`.

---

## What is NOT filtered

- System messages
- User messages
- Assistant reasoning / chain-of-thought
- Plan step outputs (always raw for auditability)
- Error messages from tools (always raw — needed for debugging)
