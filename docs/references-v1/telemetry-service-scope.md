# `telemetryService.ts` scope clarification

> Status: normative.
> Source: roadmap §993 (telemetry service orphan).
> Companion: `references/v1/telemetry-policy.md` (no-cloud-telemetry policy).

## Statement

`VibeideTelemetryService` is a **local audit channel for AI routing decisions** and
their outcomes. It does **not** transmit data anywhere. It exists to power the
"why did the agent route to model X" diagnostic UI and the "model performance
heatmap" view, both rendered locally.

## Concrete scope

| Records                                           | Storage                  | Outbound? |
|---------------------------------------------------|--------------------------|-----------|
| `RoutingDecisionEvent` — chosen model, reason.    | `TelemetryStorageService` (local). | No. |
| `ModelPerformanceEvent` — accept/reject, edit dist. | `TelemetryStorageService`. | No. |
| `OptimizationImpactEvent` — speed/cost deltas.    | `TelemetryStorageService`. | No. |
| Outcome updates (after-the-fact accept/modify).   | Pending-events map → flushed locally. | No. |

The flush timer (`flushInterval = 30_000`) is local-only — it batches writes to the
`TelemetryStorageService` IndexedDB-style sink, not to any network endpoint.

## What it is NOT

- **Not** Microsoft / Anthropic / OpenAI cloud telemetry. The codebase has zero
  network call sites for these events. The legacy `VSCode` telemetry-extractor
  workflow audits that this stays true.
- **Not** crash-report aggregation. Crash dumps live in `.build/crashes/` locally.
- **Not** usage analytics. The events are about model routing decisions, not
  feature-level user behaviour.

## Naming follow-up

Rename consideration (out of scope for this contract): `VibeideTelemetryService`
implies cloud telemetry semantics that don't apply. A future rename to
`VibeideRoutingAuditService` (or similar) would prevent confusion. Not done now
because the rename touches every consumer; tracked as backlog.

## Acceptance

Adopting this contract requires:
- File header in `telemetryService.ts` linking back to this document.
- `references/v1/telemetry-policy.md` cross-references this scope doc as the
  per-service detail.
- `scripts/vibe-services-inventory.js` no longer flags `telemetryService.ts` as
  orphan once the file header is updated.
