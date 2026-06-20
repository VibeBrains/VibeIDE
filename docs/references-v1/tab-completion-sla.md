# Tab Completion SLA

> Status: normative.
> Source: roadmap §1014 (Tab completion SLA в `references/v1/tab-completion-sla.md`).
> Owner: Tab completion / FIM track (autocompleteService.ts, vibeNextEditPredictionService.ts).

## Targets

| Metric                          | Target                                       | Measurement window |
|---------------------------------|----------------------------------------------|--------------------|
| End-to-end latency p95          | ≤ 200 ms                                     | Per 1k completions, rolling. |
| End-to-end latency p99          | ≤ 500 ms                                     | Per 1k completions, rolling. |
| Cancel rate                     | < 30%                                        | Per 1k completions.  |
| Accept rate                     | ≥ 25%                                        | Per 1k completions.  |
| Empty-suggestion rate           | < 5%                                         | Per 1k completions.  |
| Cache hit rate (when warm)      | ≥ 60%                                        | Per 1k completions.  |

End-to-end latency = keystroke debounce expiry → ghost text rendered.
Accept = user kept the suggestion (Tab) or the predicted next-edit became the
actual edit. Reject = user typed something different within 500 ms after ghost
text appeared.

## Benchmark sources

- **Cursor:** publicly cites p95 ~200ms target on Tab.
- **GitHub Copilot:** p95 ~200-300ms in third-party benchmarks (Pylance, Sourcegraph).
- **VibeIDE local Ollama:** depends on hardware, but p95 ≤ 200 ms for
  `qwen2.5-coder:7b` on M-series Apple Silicon and well-provisioned
  workstations.

A cloud provider with TLS handshake + first-token latency in the high three
digits will not meet p95 200 ms; for those providers the SLA target is
relaxed to p95 ≤ 350 ms with a banner notice in the autocomplete settings.

## Measurement plumbing

- `autocompleteService.ts` emits one `RoutingDecisionEvent` per completion
  request and one `ModelPerformanceEvent` per outcome. Both flow into
  `VibeideTelemetryService` (local-only — see
  `references/v1/telemetry-service-scope.md`).
- `aggregatePerfGuardrails` (see `common/perfGuardrailsAggregator.ts`)
  consumes the events and emits the SLA verdict in the
  `vibe doctor --perf` output.
- `performanceGuardrailsService.ts` runtime trip thresholds reflect this
  table; if a metric strays past target for ≥ 60 seconds, the dashboard
  renders the metric in red.

## What "SLA breach" triggers

- Single keystroke past p95: noise; no action.
- 1k-completion window with p95 > 250 ms: dashboard amber, surfaces in
  `vibe doctor`.
- 1k-completion window with p95 > 500 ms or accept rate < 10%: dashboard
  red, surfaces in onboarding banner ("model X is not meeting tab-completion
  targets — switch?").

The user can dismiss the banner; the underlying metric stays in the
dashboard until the next 1k window.

## Privacy note

All metrics are computed locally. The telemetry events are stored in the
local IndexedDB-style sink and never leave the device. See
`references/v1/telemetry-policy.md`.

## Acceptance for §1014

- [x] Document landed (this file).
- [ ] `autocompleteService.ts` header references this document.
- [ ] `vibe doctor --perf` reads the SLA table and renders amber/red bands.
- [ ] Dashboard banner copy ("Model X not meeting Tab targets") wired to a
  1k-window aggregate from the telemetry service.
