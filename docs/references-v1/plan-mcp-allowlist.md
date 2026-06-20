# MCP allowlist on persisted plan steps

Normative add-on for **`references/v1/plan-steps.schema.json`** and embedded JSON inside **`.vibe/plans/*.plan.md`**.

## Fields (per step)

| Field | Type | Meaning |
|-------|------|---------|
| `mcpServersAllow` | `string[]` | When non-empty, only MCP tools whose **server id/name** (as registered in VibeIDE MCP client) matches one entry (case-insensitive, trimmed) may run during this step. |
| `mcpToolsAllow` | `string[]` | When non-empty, only MCP tools whose **registered tool name** exactly matches one entry (case-insensitive) may run during this step. |

If **both** arrays are absent or empty, no extra MCP restriction applies for this step (existing **`tools`** hints + **`VibeConstraintsService`** still apply).

## Precedence

1. **`permissions.json` / constraints** — hard deny always wins.
2. **Plan MCP allowlist** — evaluated only for calls identified as MCP (known server name).
3. **Persisted plan `tools` hints** — drift / pause semantics unchanged (`chatThreadService`).

## Runtime behaviour

On violation while the step is **`running`**, execution pauses with the same UX pattern as tool drift: step **`paused`**, notification, user edits plan or resumes after correcting embedded JSON.

## Editing

Authors MAY hand-edit arrays in the machine JSON block; **`vibe doctor`** validation hooks may be extended later.
