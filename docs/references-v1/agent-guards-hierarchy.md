# Agent guards hierarchy

> Status: normative.
> Source roadmap entry: K.1 — «Иерархия guard'ов (TrustScore / DMS / LoopDetector)».

## Why this document exists

Three independent runtime guards can fire on the same agent action:

1. **TrustScore** (`VibeTrustScoreStatusBarContribution` + budget warnings) — gates whether
   the action runs at all (Manual / Supervised / Auto modes).
2. **Dead man's switch** (`VibeDeadMansSwitchService`) — interrupts a running session that
   has not been explicitly approved by the user within the configured window.
3. **Loop detector** (`VibeLoopDetectorService`) — pauses sessions that repeat the same
   `(toolType, target)` triple or `A → B → A` cycles.

Without an explicit ordering, three different dialogs could appear at once for the same
underlying decision point, with three different audit records. This document fixes the
order, single-writer for audit, and one-dialog UX rule.

## Order of evaluation (one writer per phase)

Every tool-call goes through the following phases. The **first** phase that blocks aborts
the call; later phases are not evaluated for that call, and only the blocking phase writes
to audit log.

| Phase | Subsystem                | Blocks?            | Audit event              |
|-------|--------------------------|--------------------|--------------------------|
| 1     | `permissions.json`       | hard deny          | `permission_denied`      |
| 2     | `constraints.json`       | hard deny          | `constraint_denied`      |
| 3     | TrustScore mode          | mode-dependent     | `trust_score_blocked`    |
| 4     | Token budget             | hard deny          | `budget_exceeded`        |
| 5     | Loop detector            | pause (advisory)   | `loop_detected`          |
| 6     | Dead man's switch        | pause              | `dms_timeout`            |
| 7     | Territorial advisory lock| pause / warn       | `advisory_lock_violation`|

Notes:

- Phases 1–4 are **deterministic deny**. They never produce a “maybe” dialog; they show a
  single localized message and write a single audit record.
- Phases 5–7 are **pause-not-deny**: the tool-call is held until the user approves
  resumption. Only one of them can be active at a time per session — if multiple would fire,
  the lower-numbered phase wins and the others are recorded only as `meta` on the same audit
  record (key `secondaryGuards: ["loop", "dms"]`).
- Auto-repair loop (`VibeAutoRepairLoopService`) is **excluded** from phase 5: a
  `run-tests → fix → run-tests` triple is legitimate.
- Pre-flight plan approval is **excluded** from phase 6: waiting on user is not a DMS event.

## Single audit record per blocked call

The agent runtime emits **exactly one** audit record per blocked tool-call, keyed by the
phase that blocked it. Subsystems further down the chain do not add their own records for
the same call; they may add `meta.secondaryGuards` to the primary record.

## Single UI dialog per blocked call

Likewise, the UI shows one notification with one `Resume` / `Cancel` action set. The
notification body lists the active guard, then in `### Дополнительные предупреждения`
section names the secondary guards from `meta.secondaryGuards`. There is no separate
`INotificationService.notify(...)` from each subsystem — they call into a shared
`VibeAgentBlockNotifier` (TODO: implementation backlog) that deduplicates.

## Why the order is what it is

- `permissions.json` is the user's explicit allow/deny list and must win — no other check
  can override it.
- `constraints.json` is the workspace-level policy (Enterprise → Global → Profile →
  Directory → Mode hierarchy already documented separately) and binds Mode-level guards.
- TrustScore is **mode**-level (the user's current Manual / Supervised / Auto choice) and
  cannot soften constraints; it can only further restrict.
- Token budget is a hard cap that should fire before runtime guards because it is cheaper
  to detect (synchronous read of cost forecast).
- Loop detector and DMS are runtime advisories: they fire after the call has been validated
  by phases 1–4 and signal that the **session** is in a bad state, not that the call itself
  is denied.

## Backlog

- Implement `VibeAgentBlockNotifier` so that subsystems use it instead of calling
  `INotificationService` directly. Until then, two notifications can race for the same
  call.
- Add an `agent-guards.audit-trail.test.ts` integration test that exercises a
  permission-denied call and asserts only one audit record.
- Cross-reference this document from `vibeTrustScoreStatusBarContribution.ts`,
  `vibeDeadMansSwitchService.ts`, and `vibeLoopDetectorService.ts` so future readers find
  the policy.
