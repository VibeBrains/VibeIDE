# Advisory territorial locks — `.vibe/agent-locks.json`

**Phase 3b / roadmap § B.2.** Non-hard locks: coordination hint for mono-repo agents. **Does not replace** `.vibe/constraints.json`, `.vibe/permissions.json`, or MCP allowlists.

## Lock hierarchy (single UX for “why blocked”)

Order of enforcement (first match wins for **hard** denial):

1. **Hard deny** — `permissions.json` / `VibeConstraintsService` (deny_write, deny_read).
2. **Advisory territorial lock** — this file: optional block in supervised tool mode, or audit-only in auto edit mode.
3. **Soft warnings** — notifications, risk scores, diff confidence (separate subsystems).

When a write is blocked by (1), the message must cite constraints/permissions — not territorial locks. When blocked only by (2), the message cites `agent-locks.json` holders/patterns.

## File shape

Recommended wrapper (matches `vibe doctor` parsing):

```json
{
  "vibeVersion": "1",
  "locks": [
    {
      "holder": "session-or-user-id",
      "paths": ["src/vs/workbench/contrib/foo/**"],
      "until": "2026-12-31T23:59:59.000Z"
    }
  ]
}
```

Alternate: top-level JSON array of lock entries (same fields per element).

- **holder:** Free string (session id, user id, or label). Used in messages and audit.
- **paths:** Glob patterns, matched against paths **relative to the workspace folder** containing the file (posix `/` separators). Subset follows VS Code globs (`*`, `?`, `**`, `{}`).
- **until:** ISO8601. Expired entries are ignored at runtime and reported by `vibe doctor --full` (`agent-locks-stale`).

If **`until`** is omitted, the lock is treated as **indefinite** until removed manually (doctor does not flag expiry for that row).

## Runtime (VibeIDE)

- **Supervised edits** (`autoApprove.edits !== true` and `chatAgentAutopilot !== true`): a matching non-expired lock causes the edit/rewrite tool to **fail fast** before write, so the usual approval UX can surface.
- **Auto edits** (`autoApprove.edits` or autopilot): same match → **no block**; an **audit** event is appended (if audit enabled) and a **warning** is logged.

## TTL and session dispose

Removing a lock when a session ends is **not** automatic in the current MVP: clear or shorten `until` in the file, or delete the entry. Future: hook session dispose to drop rows keyed by `holder`.

## Related

- `scripts/vibe-doctor.js` — `agent-locks-stale` (full mode).
- `references/v1/persisted-plan-contract.md` — plan merge / conflict policy (orthogonal).
