# XML tool-call format coverage matrix

← [Knowledge Index](../README.md)

Living matrix observed vendor formats × coverage layer × regression fixture. При появлении нового vendor format'а — добавить строку.

**Chronological catalog incidents:** [xmlToolFormatIncidents.md](../runtimeQuirks/xmlToolFormatIncidents.md).
**Pipeline architecture:** [xmlToolNormalization.md](xmlToolNormalization.md).
**Pre-merge audit checklist:** [xmlNormalizeAuditChecklist.md](../agentCollaboration/xmlNormalizeAuditChecklist.md).

---

## Coverage layers (legend)

- **L1 normalize** — `normalizeAlternativeToolSyntax` в `common/xmlToolNormalize.ts` структурно преобразует форму в canonical. Tool executor видит правильный shape.
- **L2 parser** — canonical block parser в `extractGrammar.ts`. Принимает paired-tag `tool/param` form literal.
- **L3 safety net** — `stripUnclaimedToolTags` placeholder для leak'ов сквозь L1+L2.

Format должен покрываться **хотя бы одним** layer. Идеально — L1 (execute as tool) > L3 (placeholder) > leak в чат.

---

## Observed formats — coverage matrix

| Vendor | Provider | Format | Layer | Fixture in tests | First observed |
|---|---|---|---|---|---|
| **Anthropic** | direct | Canonical block (`tool/param` paired tags) | L2 | `canonicalBlock` | builtin baseline |
| **Anthropic** | direct | Invoke wrapper (`invoke name="X"`) | L1 | `invokeForm` | builtin baseline |
| **Anthropic** | direct | `function_calls` outer wrap | L1 | `outerFunctionCalls` | builtin baseline |
| **OpenAI compat** | native FC | JSON tool_calls (out-of-band) | N/A — native | n/a | builtin baseline |
| **DeepSeek-v4-pro** | openCode aggregator (force-XML) | Self-closing `tool path="..."` form | L1 | `selfClosing*` (5 tests) | 2026-05-22 |
| **Qwen / DeepSeek-v4-pro** | openCode aggregator | DSML fullwidth-pipe wrapper | L1 | `dsmlFullwidth`, `dsmlFromUserScreenshot` | 2026-05-22 |
| **DeepSeek-v4-pro** | openCode aggregator | Malformed close (missing trailing `>`) | L1 | `malformedClose*` (4 tests) | 2026-05-23 |
| **DeepSeek-v4-pro** | openCode aggregator | `tool_calls` outer wrap | L1 | `outerToolCalls` | builtin baseline |
| **Kimi-K2** | openCode aggregator (force-XML) | Canonical + aliases (`<read>` → `read_file`) | L1 | `aliasResolution` | 2026-05-22 |
| **Minimax-m2.7** | openCode aggregator | Native FC cross-tool args confusion | force-XML quirk via `model-quirks.json` | n/a (X.14.2 backlog) | 2026-05-23 |

---

## Not-yet-observed but plausible formats — proactive fixtures (X.5 backlog)

Cross-vendor formats где **известно** что vendor может emit, но в product use ещё не observed:

| Vendor | Plausible format | Mitigation status |
|---|---|---|
| **GLM (Z.AI)** | Raw `tool_call` JSON inside markdown code block | not covered — L1 needs additional pattern |
| **Mistral** | Function-call XML `function_calls/function` namespace | partially covered (namespaced suffix `:tool_call`) |
| **Cohere** | Multi-tool batch JSON-in-XML | not covered |
| **Llama 3.x** | Tool-use special tokens (`[TOOL_CALL]...[/TOOL_CALL]`) | not covered |

При первом encounter — добавить fixture + L1 transform.

---

## Coverage gaps (X.0 / X.13 / X.15 audit findings — open backlog)

Известные edge-cases где `L1+L2+L3` могут пропустить:

| Gap | Severity | Roadmap ID |
|---|---|---|
| Attribute value with `>` inside quotes | Theoretical — never observed | X.0.2 |
| Mid-DSML streaming flicker (50-300ms) | Cosmetic — final text clean | X.0.5 |
| Param name regex ASCII-only | Theoretical — non-ASCII names not observed | X.0.7 / X.15.5 |
| DSML marker ASCII-only identifier | Theoretical | X.15.6 |
| Self-closing invoke combo (`invoke name="X" attrs />`) | Plausible — not observed | X.13.5 |
| Paired form with attribute on open + body | Plausible — not observed | X.13.6 |
| Escaped quotes in attribute values | Theoretical | X.15.8 |
| Stream tick non-idempotency для canonical close + prose | Edge case — rare | X.13.4 |

---

## Adding a new format

1. **Observe** — get verbatim model output (screenshot, log, user message).
2. **Catalog incident** — add entry в [xmlToolFormatIncidents.md](../runtimeQuirks/xmlToolFormatIncidents.md) с datestamp, model, fix commit.
3. **Add fixture** — verbatim copy в `src/vs/workbench/contrib/vibeide/test/common/xmlToolNormalize.test.ts`.
4. **Pick layer:** L1 (preferred) — добавить transform в `normalizeAlternativeToolSyntax`; L3 (fallback) — расширить `stripUnclaimedToolTags`.
5. **Pre-merge gate** — [xmlNormalizeAuditChecklist.md](../agentCollaboration/xmlNormalizeAuditChecklist.md).
6. **Update matrix** — добавить строку в эту таблицу.

---

## См. также

- [`docs/roadmap.md`](../../roadmap.md) sections X.1 / X.5 — vendor format expansion roadmap
- [xmlToolNormalization.md](xmlToolNormalization.md) — pipeline overview + decision tree
- [xmlToolFormatIncidents.md](../runtimeQuirks/xmlToolFormatIncidents.md) — chronological catalog
- [xmlNormalizeAuditChecklist.md](../agentCollaboration/xmlNormalizeAuditChecklist.md) — pre-merge gate
- `src/vs/workbench/contrib/vibeide/common/xmlToolNormalize.ts` — implementation
- `src/vs/workbench/contrib/vibeide/test/common/xmlToolNormalize.test.ts` — fixtures
