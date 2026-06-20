# Audit 2026-05-07 — DoD / acceptance criteria

> Status: living document, updated as K and L items close.
> Sources: `docs/roadmap.md` § K.0–K.5, § L.0–L.9.

This document is the single acceptance index for the May 2026 audit (K- and L-sections of
the roadmap). Each row maps a roadmap acceptance bullet to a concrete artefact, test, or
PR-ready signal so the gate is unambiguous.

## K-section gates

### K.0 — Pseudo-readiness items (real implementations)

For each of the 13 items in K.0, the gate is one of:

- A linked PR / commit SHA where the real implementation lands (e.g. PKCE flow merged for
  `VibeMCPOAuthService`).
- An open GitHub issue referencing the roadmap line (no silent-skip).

Until both are visible, the K.0 row stays `[ ]` even if a partial commit lands. No
half-credit.

### K.2 — Security gaps

| Item                                              | Acceptance signal                                                  |
|---------------------------------------------------|--------------------------------------------------------------------|
| A2UI positive whitelist                           | `references/v1/a2ui-allowed-commands.md` exists and is in sync     |
|                                                   | with the live `VibeAgentRenderedUIService` table; CI label-checks  |
|                                                   | PRs touching either side.                                          |
| Provider proxy auth-headers redaction             | Unit test asserts `Authorization: Bearer …` does not appear in    |
|                                                   | the proxy log even when the body would have evaded secret-detect.  |
| MCP OAuth rotation reminder                       | `onMCPServerRemoved` hook present in `mcpChannel.ts`, deletes the  |
|                                                   | token from `IEncryptionService`. Test exercises both paths.        |
| Project Commands trust revoke                     | Command `vibeide.commands.revokeTrust` registered;                 |
|                                                   | trust file write is idempotent.                                    |

## L-section gates

### L.0 — Testing acceptance for security-critical services

Every service in this list has a `*.test.ts` co-located in
`src/vs/workbench/contrib/vibeide/test/common/`:

- `VibePromptGuardService` → `vibePromptGuardService.test.ts`
- `VibeConstraintsService` → `vibeConstraintsService.test.ts`
- `VibePerFilePermissionsService` → `vibePerFilePermissionsService.test.ts`
- `VibeSecretDetectionService` → `secretDetection.test.ts` (existing)
- `VibePrivacyStripperService` → `vibePrivacyStripperService.test.ts`
- `VibeAuditEncryptionService` → `vibeAuditEncryptionService.test.ts`

Each test covers at minimum:

- Happy-path allow / pass.
- One denial / redaction case per documented threat (zero-width chars, Bidi controls,
  injection patterns, secret leak, path traversal).
- One edge case the service explicitly handles (empty input, Unicode normalization,
  surrogate pairs).

### L.2 — `docs/v1/` ↔ `references/v1/` policy

Decision (current run): `docs/v1/` holds **public-facing** content (READMEs, contracts
that are part of the user-visible product), and `references/v1/` holds **internal**
artefacts (policy notes, threat models, design decisions for maintainers).

Both directories are gitignored today. The split is enforced by review:

- A file referenced from a tracked file in `extensions/` or `src/` should live in
  `references/v1/`.
- A file referenced from a tracked README or website page should live in `docs/v1/`.

Backlog: a `scripts/vibe-docs-dedup.js` finds files with the same basename in both trees
and warns. (Closed by Phase 3 of this run.)

### L.4 — Robustness scenarios

Multi-window scenario E2E and Extension Host crash recovery have **dedicated** smoke
tests (Playwright). Until those exist, this row stays `[ ]`.

## Phase gates

| Phase                          | Open until at least                                                |
|--------------------------------|--------------------------------------------------------------------|
| Phase 2 GA                     | All K.2 items closed; L.0 minimum tests present.                   |
| Phase 3a GA                    | L.4 robustness items closed; CI workflows in `ci-workflows-       |
|                                | inventory.md` are either ACTIVE or explicitly RETIRED.             |
| Distribution readiness         | Code signing + universal binary + ARM Linux + silent updater       |
|                                | helper — all four landed (treated as one acceptance, not four).    |

## Backlog (this document)

- Convert the per-row table entries into a yaml file that `vibe doctor --audit-2026-05-07`
  parses, so the gate becomes machine-checkable.
- Add this document to the README index when `docs/` is moved out of gitignore.
