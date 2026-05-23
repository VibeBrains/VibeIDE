# XML tool-call normalization pipeline

← [Knowledge Index](../README.md)

Архитектура того, как VibeIDE превращает разнообразные format'ы tool-call'ов от LLM моделей (Anthropic invoke, self-closing, DSML, malformed close) в каноническое XML дерево, которое парсер выполняет как tool calls.

---

## [архитектура] Двухслойная защита

```
LLM emit'ит tool call в произвольном формате
        ↓
┌───────────────────────────────────────────────────────┐
│ Layer 1 (structural normalize)                        │
│   normalizeAlternativeToolSyntax() — text → text      │
│                                                       │
│   Конвертирует vendor format'ы в canonical block:     │
│     <tool><param>v</param></tool>                     │
└───────────────────────────────────────────────────────┘
        ↓
┌───────────────────────────────────────────────────────┐
│ Layer 2 (streaming parser)                            │
│   extractXMLToolsWrapper() — streaming state machine  │
│                                                       │
│   Ищет canonical <tool_name> open tag, парсит body,   │
│   эмитит tool_call object'ом downstream'у             │
└───────────────────────────────────────────────────────┘
        ↓
┌───────────────────────────────────────────────────────┐
│ Layer 3 (UX safety net)                               │
│   stripUnclaimedToolTags() — text → text              │
│                                                       │
│   Если parser НЕ claim'нул XML (multiple tool calls   │
│   в одном turn'е, tool не в active chat mode, etc.),  │
│   заменяет паттерны в text на placeholder italic-md   │
│   чтобы user не видел сырой XML.                      │
└───────────────────────────────────────────────────────┘
```

**Layer 1** — pure `string → string`, lives в `common/xmlToolNormalize.ts`. Testable unit-тестами без electron deps. **Layer 2** — streaming-state machine, lives в `electron-main/llmMessage/extractGrammar.ts` — owns transient buffers, не testable изолированно. **Layer 3** — pure, lives с Layer 1.

## [архитектура] Поддерживаемые format'ы

| Формат | Origin | Pre-fix поведение | Normalize result |
|---|---|---|---|
| Canonical `<tool><param>v</param></tool>` | VibeIDE expectation | Direct match | Untouched (fast-path return) |
| Anthropic `<invoke name="X"><parameter name="Y">V</parameter></invoke>` | Claude family | Match `<invoke>` regex | `<X><Y>V</Y></X>` |
| `<invoke>` с extra attrs `<parameter name="Y" string="true">V</parameter>` | deepseek-v4-pro | Old regex skipped extra attrs | `<X><Y>V</Y></X>` (extra attrs ignored) |
| Self-closing `<tool_name attr="v" />` | deepseek-v4-pro, Kilo-trained | Leaked raw в чат (no match) | `<tool_name><attr>v</attr></tool_name>` |
| DSML fullwidth-pipe `<｜｜DSML｜｜invoke name="X">…</｜｜DSML｜｜invoke>` | Qwen, deepseek-via-openCode | Leaked raw | DSML markers stripped → invoke normalized → canonical |
| Malformed close `<tool_calls<invoke ...>…</invoke</tool_calls` | deepseek-v4-pro 2026-05-23 | Wrappers leaked (требовали `>`) | Tolerant close `(?:>|(?=<|$))` strips orphans |
| `<tool_calls>` outer wrap | Generic | Stripped via STRIP_WRAPPERS_RE | Removed before invoke regex |
| Namespaced `<minimax:tool_call>`, `<claude:tool_use>`, etc. | Various | Stripped via STRIP_WRAPPERS_RE | Removed |

## [архитектура] Decision tree (normalize)

```
text input
   ↓
fast-path check: any FAST_PATH_SNIFF substring present?
   no  → return text (most prose hits this path)
   yes ↓
DSML strip: any `[｜|]+ID[｜|]+` markers?
   yes → strip them
   ↓
STRIP_WRAPPERS_RE: any `<tool_calls>`/`<function_calls>`/etc?
   yes → strip them (tolerant close — `>` optional)
   ↓
<invoke name="X">...</invoke> regex match?
   yes → resolve tool name + transform body's <parameter>s → <X><Y>V</Y></X>
   ↓
SELF_CLOSING_TOOL_RE: `<tool_name attrs />` present?
   yes → resolve tool name + transform attrs → block form
   ↓
return result (potentially multi-transformed text)
```

Idempotency: `normalize(normalize(x)) === normalize(x)` for every supported format (5 unit tests assert this).

## [архитектура] Single source of truth для wrapper списков

`VENDOR_WRAPPER_NAMES` и `VENDOR_NAMESPACED_SUFFIXES` const arrays в `common/xmlToolNormalize.ts`. От них derive:

- `STRIP_WRAPPERS_RE` — regex для strip фазы
- `FAST_PATH_SNIFFS` — substring сниффы для early-bail
- `ALT_PARTIAL_REGEXES` в `extractGrammar.ts` (импортит arrays) — partial-tag detection для streaming buffer

Добавление нового vendor wrapper'а (например `<assistant_actions>` в гипотетическом vendor X):

```ts
const VENDOR_WRAPPER_NAMES: readonly string[] = [
    'tool_code',
    'function_calls',
    'tool_calls',
    'tool_use',
    'tools',
    'assistant_actions',  // ← одна строка
]
```

Автоматически обновляются: STRIP_WRAPPERS_RE, FAST_PATH_SNIFFS, ALT_PARTIAL_REGEXES (через imported derivation).

## [правило] Asymmetry: aliases в normalize, не в safety net

- **`SELF_CLOSING_TOOL_RE` включает aliases** (`<read attr="v" />` → canonical `<read_file>`). Self-closing form в прозе редко встречается, поэтому false-positive risk низкий.
- **`stripUnclaimedToolTags` использует только `builtinToolNames`** (исключает aliases). Paired form `<read>...</read>` ЧАСТО встречается в прозе как объяснение кода/команд. Замена placeholder'ом мангала бы regular text.

Не выравнивать — это deliberate trade-off. Документировано в file header `xmlToolNormalize.ts`.

## [правило] Защитные паттерны — symmetry checklist

При добавлении нового regex / transform проверить (см. `audit-checklist` в agent-collaboration/):

1. **`escapeRegexLiteral(name)`** на динамические имена в regex
2. **Idempotency test** `normalize(normalize(x)) === normalize(x)`
3. **Null/empty input guard** в публичной функции
4. **Тест assertion структурный**, не verbatim локализуемый текст (placeholder может быть RU/EN)
5. **Pattern в `FAST_PATH_SNIFFS`** если новый wrapper marker
6. **Symmetric defense** — где ещё нужна та же transform? (paired vs self-closing, open vs close)
7. **Streaming edge** — partial префикс buffer'ится корректно?
8. **Verbatim fixture** от реального model output для unit-теста (если есть incident)

## Связано

- [xml-tool-format-incidents.md](../runtime-quirks/xml-tool-format-incidents.md) — catalog observed-в-production format'ов с датой/моделью/fix-commit'ом
- [tool-calling.md](./tool-calling.md) — общая архитектура tool dispatch
- [model-quirks.md](./model-quirks.md) — какие модели идут через XML pipeline (force-XML quirks)
- [xml-normalize-audit-checklist.md](../agent-collaboration/xml-normalize-audit-checklist.md) — pre-merge gate для new XML transforms
