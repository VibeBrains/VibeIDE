# XML tool-call format incidents — catalog

← [Knowledge Index](../README.md)

Living document. Каждый новый incident с XML tool-call format'ом, который не покрыт текущим normalizer'ом, попадает сюда новой записью. Цель — recurrent observation pattern в пределах одной таблицы вместо разрозненных commit messages.

Колонки: дата → модель/провайдер → format symptom → root cause → fix commit → regression test.

---

## [архитектура] См. также

- [xml-tool-normalization.md](../architecture/xml-tool-normalization.md) — pipeline overview
- [`docs/roadmap.md`](../../roadmap.md) секция X — все audit passes / fix iterations
- `src/vs/workbench/contrib/vibeide/common/xmlToolNormalize.ts` — реализация
- `src/vs/workbench/contrib/vibeide/test/common/xmlToolNormalize.test.ts` — fixtures

---

## Catalog (chronological, newest last)

### 2026-05-22 — deepseek-v4-pro / openCode — self-closing `<read_file path="..." />`

| Поле | Значение |
|---|---|
| **Модель** | deepseek-v4-pro |
| **Провайдер** | openCode aggregator |
| **Format symptom** | Self-closing inline: `<read_file path="d:\..." />`, chain'ил 5-6 одновременно |
| **Что было сломано** | Canonical парсер искал `<read_file>` literal (no space + immediate `>`). Attribute-form open `<read_file` его не находил. Safety net требовал paired close → раз в чате как раз self-closing form → leaked verbatim |
| **Root cause** | Один из force-XML моделей через openCode эмитит compact inline XML вместо canonical block form. Модель не виновата — формат валидный XML; парсер был узкий. |
| **Fix commit** | `baafe380` — added `SELF_CLOSING_TOOL_RE` matching canonical/alias tool names + `\s+attrs\s*\/>`. `<read_file path="x" />` → `<read_file><path>x</path></read_file>` |
| **Regression test** | `test/common/xmlToolNormalize.test.ts` → suite `normalizeAlternativeToolSyntax — self-closing` (5 tests) |

---

### 2026-05-22 — Qwen / DeepSeek via openCode — DSML fullwidth-pipe `<｜｜DSML｜｜invoke ...>`

| Поле | Значение |
|---|---|
| **Модель** | Qwen variants + deepseek-v4-pro (некоторые turns) |
| **Провайдер** | openCode aggregator |
| **Format symptom** | `<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="X"> ... </｜｜DSML｜｜invoke> </｜｜DSML｜｜tool_calls>` — fullwidth-pipe (U+FF5C) marker wrapping каждый tag |
| **Что было сломано** | STRIP_WRAPPERS_RE искал literal `<invoke` / `<word:tool_call>`. С fullwidth-pipe prefix'ом `<｜｜DSML｜｜invoke` — это не `<invoke` literal. Не match → leak в чат |
| **Root cause** | Chinese-ecosystem модели иногда эмитят DSML markers для structural protocol. `｜` (U+FF5C) — fullwidth Chinese-style вертикальная черта, не ASCII `|` |
| **Fix commit** | `baafe380` — added `DSML_MARKER_STRIP_RE = /[｜|]{1,4}[A-Za-z][\w-]*[｜|]{1,4}/g` — strip любой ASCII identifier обрамлённый pipe markers. Structural, not hardcoded literal "DSML" |
| **Regression test** | `test/common/xmlToolNormalize.test.ts` → `dsmlFullwidth` + `dsmlFromUserScreenshot` (verbatim user fixture) |

---

### 2026-05-23 — deepseek-v4-pro — malformed close `<tool_calls<invoke ...>...</invoke</tool_calls`

| Поле | Значение |
|---|---|
| **Модель** | deepseek-v4-pro |
| **Провайдер** | openCode aggregator (force-XML) |
| **Format symptom** | Wrapper open и close теги без trailing `>`: `<tool_calls<invoke name="X">...</invoke</tool_calls`. invoke open сам по себе с `>`, но wrapper'ы — без |
| **Что было сломано** | STRIP_WRAPPERS_RE требовал `\s*>` для match. `<tool_calls` followed by `<` (другой tag) — не match. `</invoke<` следующий tag — invoke regex требовал `</invoke>` literal — не match. Wrappers leaked |
| **Root cause** | Модель ИНОГДА теряет `>` при chaining close tag'ов. Не stable repro — но happens enough that пользователь увидел в чате |
| **Fix commit** | `629c0625` + `2400d897` — STRIP_WRAPPERS_RE, invoke close, parameter close все switched на tolerant `\s*(?:>|(?=<|$))` lookahead pattern. Matches `>`, OR`<` of next tag, OR end of buffer |
| **Regression test** | `test/common/xmlToolNormalize.test.ts` → suite `malformed close tags` (4 tests, включая verbatim user fixture с i18n JSON ru.json) |

---

### 2026-05-23 — minimax-m2.7 / openCode — native FC cross-tool args confusion (NOT XML — related class)

| Поле | Значение |
|---|---|
| **Модель** | minimax-m2.7 |
| **Провайдер** | openCode aggregator |
| **Format symptom** | Native FC tool_call: `read_file({nl_input: "Check Dokku apps"})`. `nl_input` — required param `run_nl_command` тула, не `read_file`'s |
| **Что было сломано** | Native FC pipeline проходит ВНЕ XML normalizer'а. Schema hint отправляется обратно модели через invalid_params, но minimax не делает retry в том же turn'е → 120s stream-stall watchdog отстреливает |
| **Root cause** | Native FC schema validation на стороне OpenAI-compatible adapter не enforce'ит alignment между tool name и provided args. Same bug class что deepseek-via-openCode (уже force-XML с обоснованием в model-quirks). Minimax не имел такой quirk-rule |
| **Fix commit** | `62c54f76` — добавил `{ match: "minimax", provider: "openCode", forceToolCallFormat: "xml", ... }` quirk + smart-suggest schema hint (scan'ит все builtin tools, suggest альтернативу когда `rawKeys ∩ requiredParams` score > 0.6 у другого тула). Помогает любой native FC модели с cross-tool confusion |
| **Regression test** | None — нужен reproduction fixture. Backlog X.14.2 |

---

### 2026-06-11 — JSON-массив в тексте (X.16) — слабые модели / OpenAI-style FC текстом

| Поле | Значение |
|---|---|
| **Модель** | nemotron-nano (free) и др. слабые; OpenAI-style function-call, отрендеренный текстом |
| **Провайдер** | агрегаторы (OpenRouter / openCode) |
| **Format symptom** | tool-call как JSON-массив в тексте вместо XML: `[{"name":"read_file","arguments":{…}}]` или namespaced `[{"type":"tool","tool":"fs","command":"read","args":{…}}]` |
| **Что было сломано** | `normalizeAlternativeToolSyntax` не знал JSON-форму → массив утекал в чат / тул не вызывался |
| **Fix** | X.16 — `convertJsonToolArrayToCanonical` (`xmlToolNormalize.ts`): конвертирует `[{…}]` → канонический `<tool><param>…</param></tool>`, переиспользуя `resolveToolNameLoose`/`resolveInvokeParamName` (тот же маппинг, что у XML-путей). **КОНСЕРВАТИВНО:** конвертит массив только если ВСЕ объекты резолвятся в реальный тул, иначе оставляет байт-в-байт (не мис-роутит). String `arguments` (OpenAI кодирует JSON-строкой) парсятся |
| **НЕ покрыто (осознанно)** | namespaced `{"tool":"fs","command":"read"}` (nemotron) — `fs` не канонический тул, а `command`→tool + `args`→param маппинг не подтверждён verbatim-сэмплом → такие записи не резолвятся и оставляются нетронутыми (safe). Уточнить при реальном логе nemotron |
| **Fix commit** | `<pending>` (v0.21.4) |
| **Regression test** | `test/common/xmlToolNormalize.test.ts` → suite `JSON-array tool form (X.16)` (6 тестов) |

---

### 2026-06-11 — minimax: невалидный edit_file → каскад в Python-патч-скрипты

| Поле | Значение |
|---|---|
| **Модель** | minimax (форсирован в XML по quirk) |
| **Провайдер** | агрегатор |
| **Format symptom** | `edit_file` `search_replace_blocks` приходит как `<<<<<<< ORIGINAL>` + search-текст, **без** `=======` и `>>>>>>> UPDATED` (6× за сессию, ни одного divider/final). Парсер `extractSearchReplaceBlocks` требует `ORIGINAL\n` + `DIVIDER` + `FINAL` → 0 блоков |
| **Что было сломано (каскад)** | Тупиковая ошибка `«No Search/Replace blocks were received!»` ничего не объясняла → модель решила «edit_file ненадёжен», перешла на `rewrite_file` → тот **урезал** большие файлы (модель не до-эмитит весь файл) → модель изобрела обход: писать одноразовые `__patch_*.py` в `tests/support/`, прогонять, удалять (11+ скриптов) → мусор в репо → loop на `final_check` → анти-луп гард остановил прогон |
| **Fix** | `editCodeService._searchReplaceFormatHint` — обучающая ошибка вместо тупиковой: диагноз (что именно из ORIGINAL/DIVIDER/FINAL отсутствует, толерантно к `<<<<<<< ORIGINAL>`) + точный шаблон + «для больших правок — rewrite_file; НЕ пиши скрипт для патча файла». Транспорт ни при чём — XML-извлечение параметра берёт всё между тегами; модель реально не производит divider/final |
| **Осталось (follow-up)** | (а) ✅ `rewrite_file` truncation-guard сделан (см. `tool-system/edit-safety.md`); (б) промпт-нудж против `__patch`-скриптов — не сделан |
| **Fix commit** | `<pending>` (v0.21.5) |
| **Regression test** | None — нужен fixture с verbatim minimax edit_file |

---

## [правило] Запись новой incident'а

При добавлении новой строки в catalog:

1. **Скопировать template** — `docs/knowledge/_template-incident.md` (краткая форма) или существующий блок выше (расширенная таблица form).
2. **Datestamp ISO** — `YYYY-MM-DD` от события, не от commit fix'а.
3. **Verbatim model output** — если screenshot/log есть, копировать verbatim как regression fixture (в `xmlToolNormalize.test.ts`).
4. **Fix commit hash** — обязательно. Если ещё нет — `<pending>` + roadmap ID.
5. **Add regression test ссылку** — file path + suite/test name.
6. **Cross-link** в roadmap secция X.* запись (если есть).
