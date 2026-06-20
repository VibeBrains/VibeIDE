# Edit risk scoring vs diff confidence color — service boundary

> Status: normative.
> Source roadmap entry: roadmap §989 (`editRiskScoringService.ts` boundary with diff confidence).

## Why this document exists

Three components touch the same idea ("how dangerous is this edit?"):

1. **`IEditRiskScoringService`** (`common/editRiskScoringService.ts`) — full edit-context risk scoring.
2. **`editRiskConfidenceMap.ts`** (`common/editRiskConfidenceMap.ts`) — pure helper mapping `{riskScore, llmJudge?, heuristicFlags?}` → `green | yellow | red`.
3. **`VibeDiffPreviewService.calculateConfidence`** (`common/vibeDiffPreviewService.ts`) — UI consumer rendering the confidence color in diff preview.

Without an explicit boundary it is unclear whether `calculateConfidence` should re-implement risk logic or delegate, and whether the LLM-as-judge advisory can up-rank a red verdict.
This document fixes the contract: **complements, does not duplicate**.

## Three actors

| Component                             | Inputs                                                                                  | Output                              | Caller                                        |
|---------------------------------------|-----------------------------------------------------------------------------------------|-------------------------------------|-----------------------------------------------|
| `IEditRiskScoringService.scoreEdit`   | full `EditContext` (uri, original/new content, op type, model, fileWasRead, totalFiles) | numeric `EditRiskScore` + reasons   | agent gates (auto-block, DMS, audit)          |
| `editRiskConfidenceMap.deriveConfidenceColor` | `{riskScore, llmJudge?, heuristicFlags?}` (no I/O)                              | `'green' \| 'yellow' \| 'red'`      | both consumers below — single source of truth |
| `VibeDiffPreviewService.calculateConfidence` | single `DiffChunk` (filePath, original/new lines)                                | `DiffConfidence` (color via map)    | UI hover / diff preview rendering             |

## Decision policy (frozen in `editRiskConfidenceMap`)

Top-down, first-match-wins:

1. Any `heuristicFlags[]` non-empty → **red**.
2. `clamp(riskScore) > 0.8` → **red**.
3. `llmJudge === 'risky'` → **red**.
4. `clamp(riskScore) > 0.4` OR `llmJudge === 'unknown'` → **yellow**.
5. Otherwise → **green**.

Invariant (`auditPolicyConsistency`): if `flagged || riskScore > 0.8 || judge === 'risky'` then color **MUST** be red. Tests pin this.

## Complements, does not duplicate

- `editRiskScoringService` measures risk from full edit context. It runs **once per agent edit** and feeds gates that decide whether the edit even runs.
- `VibeDiffPreviewService.calculateConfidence` renders a per-chunk confidence color when the user hovers a diff. It runs **N times per preview** and only consumes the pre-computed map.
- Both call into the same `deriveConfidenceColor` so the **color shown in UI matches the gate verdict** — no drift.

## What the helper does NOT do

- It does **not** source risk signals — callers (scoring service / preview service) compute their own `riskScore` and `heuristicFlags`.
- It does **not** block operations directly — that is `isAutoBlockedByConfidence`'s job, called by gates.
- It does **not** see model / provider — `EditRiskScore` keeps that separation; provider-specific behaviour lives in `editRiskScoringService`.

## Why judge cannot upgrade to green

The LLM judge is advisory only. A risky-rated heuristic flag (e.g. `delete from table`, `rm -rf`) is a deterministic kill-switch. Allowing the judge to override would let model hallucinations downgrade clearly-dangerous edits to green. The asymmetry is intentional:

- judge **can** push to red (risky verdict) — defence in depth.
- judge **cannot** lift red or yellow to green — heuristics win.
