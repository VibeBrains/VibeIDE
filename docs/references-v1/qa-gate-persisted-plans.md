# QA Gate — Persisted Plans before GA

**Created:** 2026-05-04  
**Status:** ✅ CLEARED — all acceptance criteria met

## Gate Purpose

Before declaring Persisted Agent Plans (§ A) generally available, two visibility UX gaps from Phase 1 must be resolved. Without them, plan execution is opaque: users cannot see which model ran a step or when it ran.

## Acceptance Criteria

| Criterion | Roadmap ref | Status |
|---|---|---|
| **Full Training policy UI** — Model picker or status bar shows `trainingPolicy` from `models.json` registry; user can verify before sending data to a provider | Phase 1 → UX (line ~140) | ✅ `VibeModelsRegistryService.trainingPolicy` field + `VibeTrainingPolicyStatusBar` |
| **Timestamp prefix in agent logs** — Agent Activity output channel prefixes every Started / Finished / Error line with `[YYYY-MM-DD HH:MM:SS]` (nginx-style) | Phase 1 → UX (line ~150) | ✅ `vibeAgentActivityLogService.ts` — timestamp prefix on all lifecycle events |

## Verification

Both items were implemented and committed before this gate document. The gate is cleared automatically because:

1. `VibeTrainingPolicyStatusBar` shows `🎓 Training: ON/OFF` in the status bar for the active model.
2. `VibeAgentActivityLogService` prefixes every line written to the **VibeIDE Agent Activity** Output channel.

## Next Steps

With this gate cleared, the following Phase 3b items become unblocked:
- Subagent spawn UI (§ I.1)
- Background / unattended agent (§ J)

No further action needed for this gate.
