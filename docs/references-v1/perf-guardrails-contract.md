# Performance Guardrails Contract

**Scope:** `performanceGuardrailsService.ts` + `common/perfGuardrailsAggregator.ts`

## Purpose

The Performance Guardrails service monitors runtime performance thresholds and records
trips to `.vibe/perf-guardrails-events.jsonl` when thresholds are exceeded.

This is **distinct** from the Performance SLA document (`references/v1/tab-completion-sla.md`):

| | Performance SLA | Performance Guardrails |
|---|---|---|
| Scope | Tab completion specifically | All IDE operations |
| How measured | p95/p99 latency statistics | Threshold trip events |
| Enforcement | CI gate on SLA violation | Dashboard + `vibe doctor --perf` |
| Storage | Aggregated telemetry | JSONL event log per session |

## Thresholds

| Rule | Threshold | Severity |
|---|---|---|
| `startup-time` | > 5000ms | warning |
| `main-thread-block` | > 500ms | error |
| `chunk-gap` | > 1000ms between stream chunks | warning |
| `memory-delta` | > 200MB heap growth per session | warning |
| `fps-drop` | < 30 FPS in editor canvas | warning |

## Event Format

Each trip appended to `.vibe/perf-guardrails-events.jsonl`:

```json
{
  "rule": "main-thread-block",
  "timestamp": 1715000000000,
  "observedValue": 650,
  "thresholdValue": 500,
  "context": "chatThreadService._runChatAgent"
}
```

## Consumer

`vibe doctor --perf` reads the JSONL file, aggregates via `aggregatePerfGuardrails`,
and renders a markdown dashboard showing trip counts, max/avg observed values, and
top contexts.

## NOT responsibilities

- Does not block IDE launch on threshold trips (telemetry-only)
- Does not aggregate across multiple machines
- Does not replace dedicated profiling (Chrome DevTools / VS Code profiler)
- Does not enforce SLA for production deployments (that is the SLA document's job)

## Integration with `performanceGuardrailsService.ts`

The service records events by calling:

```ts
perfGuardrailsService.record({ rule: 'chunk-gap', observedValue: gapMs, context: 'stream' });
```

The CJS mirror `scripts/lib/perf-guardrails-aggregator.cjs` reads the resulting JSONL
for `vibe doctor` without requiring a live IDE.
