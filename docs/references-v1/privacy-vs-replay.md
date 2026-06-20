# Privacy stripping vs reproducible sessions — modes

> Status: normative.
> Source roadmap entry: K.1 — «Privacy-стрипер vs Reproducible sessions».

## The conflict

Two services have opposite goals on the same data:

- `VibePrivacyStripperService` rewrites prompts/audit payloads to remove `username`, home
  directory, workspace path, machine name, etc., before sending or storing.
- `VibeReproducibleSessionService` records exact prompt + tool-call traces so a session can
  be replayed deterministically (compliance, bug repro, audit).

If the stripper rewrites `C:\Users\alice\repo\src\foo.ts` to `<HOME>\repo\src\foo.ts` and
the replay tries to read `<HOME>\repo\src\foo.ts` literally, the replay fails. If the
stripper does nothing, the audit log leaks personal paths.

## Decision

There are **two modes**, set per-session at start time and stored in the session header.
Modes are not silently switchable mid-session — switching forks a new session.

### `replay-friendly` (default for compliance / bug repro)

- Strip nothing from filesystem paths or hostnames at audit-write time.
- Strip secrets via `VibeSecretDetectionService` (always on, both modes).
- Hash personal identifiers (`USER`, email in git config) into stable per-session salts
  written to the session header so a replayer can substitute back if needed.
- Replay is deterministic: a session captured on machine A replays on machine B if the
  workspace tree is bit-identical and the model + seed match.
- Caveat: the resulting audit log contains paths and hostnames. It must not be shared
  outside the user's machine without an explicit redact pass.

### `privacy-strict` (default for telemetry / shareable export)

- Run full strip: paths → `<workspaceRoot>/relpath`, home → `<HOME>`, username → `<USER>`,
  hostnames → `<HOST>`, IPs → `<IP>`.
- Run secret detection.
- Replay is **not deterministic**: tool-calls that touched literal paths are replaced with
  best-effort glob lookups under the new workspace root. A `ReplayNotDeterministicError`
  is raised if a tool-call cannot be unambiguously remapped.

## How a user picks the mode

Mode lives in `vibeide.privacy.sessionMode` (`replay-friendly` | `privacy-strict`).
Default = `replay-friendly` for local development; `privacy-strict` is forced when:

- `vibeide.privacy.strict = true` (global override),
- the session is being exported via `vibe session-export --redact`,
- a Provider is in BYOK gateway mode that declares `dataResidency=eu` and the workspace is
  outside the EU.

## What goes in the session header

```yaml
sessionId: 7b3f...
mode: replay-friendly
strippedFields: []          # empty for replay-friendly
salts:
  user: hmac-sha256("alice", session-salt)
  host: hmac-sha256("alice-pc", session-salt)
```

For `privacy-strict`:

```yaml
sessionId: 7b3f...
mode: privacy-strict
strippedFields: [path, home, user, host, ip, secrets]
salts: {}
```

## Backlog

- Add a startup validator: when `vibeide.privacy.strict = true` and an existing session was
  recorded as `replay-friendly`, refuse to load it (forcing the user to export under
  privacy-strict first).
- Add CLI flag `vibe session-replay --require-mode replay-friendly` so a CI replay job
  fails fast on a stripped session.
- Document this in user-facing settings (`vibeide.privacy.sessionMode` description points
  here).
