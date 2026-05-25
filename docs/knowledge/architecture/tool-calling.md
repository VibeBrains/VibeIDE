# Tool calling — каналы доставки и пути парсинга

> Карта того, как VibeIDE-агент отдаёт модели набор тулов и как разбирает её ответ. Полезно открыть при любой работе с tool-calling, прежде чем что-то менять.

---

## Контекст

VibeIDE поддерживает 5 разных каналов «модель ↔ тулы», в зависимости от провайдера/модели и режима чата:

| Канал | Когда задействован | Где формируется payload |
|---|---|---|
| AI SDK `tools:` (нативное function-calling через `@ai-sdk/openai-compatible`) | агрегаторы (openCode, openRouter, liteLLM, openAICompatible, lmRoute, openCodeZen, pollinations) + direct cloud (deepseek, mistral chat, xAI, groq, awsBedrock, googleVertex, microsoftAzure) | `aiSdkAdapter.ts` → `convertToolsToAiSdkToolSet()` → `streamText({ tools })` |
| Anthropic native | provider `anthropic` | `sendLLMMessage.impl.ts` → `anthropicTools()` |
| Gemini native | provider `gemini` | `sendLLMMessage.impl.ts` → `geminiTools()` |
| OpenAI native legacy | provider `openAI` | `sendLLMMessage.impl.ts` → `_sendOpenAICompatibleChat` |
| XML fallback (текстовый) | любая модель, у которой `specialToolFormat === undefined` | system prompt: `systemToolsXMLPrompt` + парсер `extractXMLToolsWrapper` |

`specialToolFormat` приходит из `getModelCapabilities()` (`common/modelCapabilities.ts`) и принимает значения `'openai-style' | 'anthropic-style' | 'gemini-style' | undefined`.

---

## Суть

### Правило одного канала

Native function-calling и XML-описания в системном промпте — это **взаимоисключающие** каналы. Если модель имеет нативный канал, в системный промпт XML-описания тулов больше **не вставляются**: дублирование путало модель в по-имени-vs-по-индексу.

Контроль — `convertToLLMMessageService.ts`:

```ts
const includeXMLToolDefinitions = !specialToolFormat
```

Это правило заменило прежнее `!specialToolFormat || chatMode === 'agent' || chatMode === 'plan'`, которое для agent/plan включало двойной канал даже у нативных моделей.

### Тулы — всегда в AI SDK

`aiSdkAdapter.ts` теперь передаёт `tools:` в `streamText` **всегда**, независимо от `specialToolFormat`. Если апстрим не поддерживает function-calling — он просто не вернёт `tool_call`, и `extractXMLToolsWrapper` (включается при `!specialToolFormat`) подхватит вызов из текста. Прежняя жёсткая привязка `specialToolFormat === 'openai-style'` означала, что aggregator с неузнанной моделью (`__aggregator_unknown__`) вовсе не получал tools-поле.

### Resilience: `experimental_repairToolCall` + `invalid` псевдо-тул

В `streamText` подключён двухступенчатый хук-чинилка (по образцу Kilo, `packages/opencode/src/session/llm.ts:391-410`):

1. **Case-mismatch**: `Read_File` / `BASH` / `READ` → пробуем lowercase, если такое имя есть в реестре — подменяем `toolName` на lowercase-вариант.
2. **Всё остальное** (числовые имена `"2"`, `"5"`, `"20"`; выдуманные идентификаторы) — подменяем `toolName` на зарезервированный `invalid` и упаковываем оригинальные `tool` + `error.message` в `input` как JSON.

`invalid` зарегистрирован в AI SDK `tools`-Record (через флаг `includeInvalidTool` в `convertToolsToAiSdkToolSet`), но **скрыт от модели** через `activeTools: Object.keys(tools).filter(k => k !== 'invalid')` — она его не видит в схеме, сама не вызовет. Единственный путь — через repair-хук.

`invalid` имеет `execute`, который возвращает строку `"The arguments provided to the tool are invalid: ${error}"` — 1-в-1 как у Kilo (`packages/opencode/src/tool/invalid.ts`). Это нужно AI SDK для корректного завершения turn — он эмитит `tool-result` событие и не падает на NoSuchToolError. На уровне нашего pipeline тот же `tool-call` всё равно всплывает в upstream через stream-handler.

Когда `invalid` доходит до `chatThreadService._runToolCall` (короткая ветка в начале функции, до builtin/MCP проверок), формируется `tool_error`-сообщение `"The arguments provided to the tool are invalid: ${reason}. Available built-in tools: ..., Available MCP tools: ..."`. Список тулов добавляется только если SDK-ная `error.message` ещё не содержит `available tool` (иначе дубль). Эмпирически: модели с baked-in numeric-name квирком (minimax/qwen) recovery'ятся когда видят список реальных имён — гипотеза 0.9.2 «список провоцирует квирк» оказалась неверной, квирк baked-in в обучение и не зависит от формата ошибки.

`isABuiltinToolName('invalid')` намеренно возвращает `false` — `invalid` НЕ в `builtinTools`, не должен попадать в системный промпт, approval-флоу, telemetry. Это AI-SDK-internal plumbing, изолированное в `aiSdkAdapter.ts` (`INVALID_TOOL_NAME` const) и распознаваемое одной веткой в `chatThreadService._runToolCall`.

### Recovery на legacy путях (Anthropic native / Gemini native / XML fallback)

Эти каналы НЕ проходят через `experimental_repairToolCall` — у них нет AI SDK. Соответствующее восстановление выполняется в `chatThreadService._runToolCall` в начале функции:

1. **Case-mismatch**: lowercase-нормализация имени до проверки `isABuiltinToolName`. `Read_File` → `read_file` диспетчится корректно. `const toolName: ToolName = (lowered !== requested && isABuiltinToolName(lowered)) ? lowered : requested` — обязательно `const`, иначе TS теряет narrowing через type guard.
2. **Unknown name через MCP-ветку**: вместо `throw new Error("Tool 'N' is not a known tool...")` эмитится `tool_error` `"The arguments provided to the tool are invalid: Unknown tool name 'X'. Available built-in tools: ..., Available MCP tools: ..."`. Это убирает красную ошибку в чате и даёт модели единообразный recovery-path на всех каналах.

### Auto-downgrade + circuit-breaker: tool-call resilience pipeline

Двухступенчатый механизм в agent-loop (`_runChatAgent` в `chatThreadService.ts`). После каждого `_runToolCall` инспектируется последнее сообщение треда; per-(provider×model) счётчик `consecutiveToolErrorsByModel: Map<string, number>` обновляется:

- `tool_error` или `invalid_params` → `+= 1`.
- `success` → `= 0`.
- `tool_request` / await approval → не меняется.

**Stage 1 — Auto-downgrade на `AUTO_DOWNGRADE_THRESHOLD = 3`** (срабатывает один раз на сессию на модель через `downgradedModelsThisSession: Set<string>`):

1. Классификация причины: helper `classifyToolErrorReason(toolName, content)` → `'numeric-tool-name' | 'missing-required-field' | 'wrong-tool-name' | 'other'`.
2. Запись override через `_settingsService.setOverridesOfModel(provider, model, { specialToolFormat: undefined, _autoDetected: true, _detectedAt: Date.now(), _reason })`.
3. Toast через `_notificationService.warn` с reason-specific текстом и hint на откат через Settings → Models → Overrides.
4. Запись в `_agentActivityLog.logFinished(`Auto-downgrade: ${modelKey} → XML (${reason})`)`.
5. Counter для этой модели сбрасывается в 0 (XML-путь получает 5 свежих попыток до Stage 2).
6. `return` НЕ выполняется — agent-loop продолжается, следующая итерация LLM-вызова берёт обновлённый `getModelCapabilities` (который теперь видит override и возвращает `specialToolFormat: undefined`).

Override живёт `AUTO_DOWNGRADE_TTL_MS = 7 дней`, потом игнорируется в `getModelCapabilities` (model снова получает default native FC). User-set manual overrides (без `_autoDetected: true`) живут вечно.

**Stage 2 — Circuit-breaker на `MAX_CONSECUTIVE_TOOL_ERRORS = 5`** (safety net):

- Toast через `_notificationService.warn`.
- `tool_error` сообщение в тред с подсказкой («Switch to a different model (Claude, GPT, Gemini, DeepSeek)»).
- `_setStreamState(undefined)` + `return` — agent-loop останавливается.

Срабатывает только если auto-downgrade не помог (модель ломается и на XML тоже), или для случаев когда трудно классифицировать (одна модель сломала всё подряд без шанса на recovery).

### Глобальный override-режим: `vibeide.llm.toolFallbackMode`

Enum-настройка `'auto' | 'native' | 'xml'` (default `'auto'`) для aggregator-synthesized моделей. Применяется в `aiSdkAdapter.ts` и `sendLLMMessage.impl.ts`:

- `'auto'` — `caps.specialToolFormat` (которое уже учитывает auto-detected override'ы). Дефолт.
- `'native'` — форсит `'openai-style'`, **игнорируя auto-detected override'ы** (полезно если auto-downgrade ошибочно сработал).
- `'xml'` — форсит `undefined` (XML-в-промпте) глобально.

Backward-compat: legacy `vibeide.llm.assumeNativeTools` (boolean, deprecated) read с миграцией — `false` мапит на `'xml'` если новый mode `'auto'`. Scope ограничен aggregator-synthesized (т.е. `recognizedModelName === '__aggregator_unknown__'`), известные модели не затрагиваются.

### Root cause всех minimax-quirk бед: `Object.keys(array)` в `convertToolsToAiSdkToolSet`

**Урок 2026-05-16 (после 10 часов отладки):** в `aiSdkAdapter.ts:convertToolsToAiSdkToolSet` параметр был типизирован как `{ [k: string]: InternalToolInfo }` (record), но фактически на call site передавался **массив** `InternalToolInfo[]` (return type `availableTools()`), и `as any` cast скрыл это от TypeScript.

```ts
// БЫЛО (broken):
allowed: { [k: string]: InternalToolInfo }
for (const name of Object.keys(allowed)) { ... out[name] = tool({...}) }
// На массиве Object.keys → ["0", "1", "2", ...], имена тулов = индексы массива
```

В результате модели приходил request body вида:
```json
{
  "tools": [
    {"name": "0", "description": "ALWAYS use this tool to read file contents..."},
    {"name": "1", "description": "Lists files and folders..."},
    {"name": "5", "description": "Returns workspace files matching a glob pattern..."}
  ]
}
```

Модель добросовестно эмитила `tool_use { name: "5" }` — она читала наш реальный массив, видела `name: "5"`, его и звала. Это **не quirk минимакса**, это наш баг в регистрации тулов.

```ts
// СТАЛО (correct):
allowed: InternalToolInfo[] | { [k: string]: InternalToolInfo }
const toolsArray: InternalToolInfo[] = Array.isArray(allowed) ? allowed : Object.values(allowed);
for (const t of toolsArray) { out[t.name] = tool({...}) }
```

И на call site убран `as any`, чтобы TypeScript ловил подобные ошибки в будущем.

**Что это объясняет ретроактивно** (все попытки лечения симптомов до 2026-05-16):

| Что делали | Что на самом деле | Что было нужно |
|---|---|---|
| Hardcoded substring для minimax/qwen | Симптом — модель эмитила "0"/"1"/"5" | Чинить регистрацию тулов |
| Anthropic SDK routing через models.dev | Симптом — protocol mismatch (не зря, нужная фича) | Дополнение, не корень |
| `x-opencode-*` headers, `User-Agent: opencode/...` | Гипотеза про aggregator-prompt-injection | Бессмыслено для нашего случая |
| `anthropic-beta: fine-grained-tool-streaming` | Полезный header вообще, но не корень | Косвенная польза |
| Bullets вместо numbered "Important notes" | Гипотеза что numbering provoking quirk | Косвенная польза |
| Positional fallback (`"5"` → `tools[5]`) | Сработало случайно потому что массив-имя совпало с массив-индекс | Не нужно после корневого фикса |
| Auto-downgrade pipeline O.0–O.10 | Универсальный safety net для любых будущих квирков | Полезен в любом случае |
| Tool inventory reduction (MCP off) | Симптом стал реже — другие индексы реже совпадали с попытками модели | Не корень |

**Архитектурный урок:** `as any` на парамтере функции которая принимает structured data — это код-смрад. TypeScript должен ловить мисматч массив/объект на этапе compile. Здесь cast был добавлен потому что один из call site'ов передавал `availableTools()` result, у которого type drift со временем превратился из объекта в массив, и вместо рефакторинга обоих сторон сделали "пусть TS заткнётся". Цена этого one-line cheat — 10 часов отладки и 8 итераций релизов (0.9.1–0.9.3).

### NO hardcoded model patterns в коде

Ключевой принцип: имена моделей (minimax, qwen, m2.7) **не вшиваются** в код. Все per-model decisions делаются runtime'ом через auto-downgrade pipeline. Это даёт три преимущества:
1. Новая проблемная модель не требует patch'а кода — система сама обнаружит.
2. Известные хорошие модели не страдают от ложных «known broken» классификаций.
3. Diff кода предсказуем — нет «магических» substring-match в файлах capabilities.

**Исключение нет.** Protocol routing полностью data-driven через `modelsDevCatalog.ts` — никаких имён моделей/семейств/regex в коде. См. секцию «Protocol routing» ниже.

### Protocol routing: data-driven через models.dev (нет хардкода)

**Урок 2026-05-16:** для openCode/openCodeZen провайдеров безусловное использование `@ai-sdk/openai-compatible` для ВСЕХ моделей даёт неправильный wire-protocol для части моделей. Согласно `opencode.ai/docs/go` и `models.dev/api.json`:

| Модель на opencode-go | Endpoint | AI SDK Package |
|---|---|---|
| GLM-5/5.1, Kimi K2.5/K2.6, DeepSeek V4, MiMo-V2.5/Pro | `/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| **MiniMax M2.5 / M2.7** | **`/v1/messages`** | **`@ai-sdk/anthropic`** |
| **Qwen3.5 / 3.6 Plus** | `/v1/chat/completions` | **`@ai-sdk/anthropic`** (per models.dev) |

minimax-m2.7 — Anthropic-протокол. Если послать его OpenAI tool_calls schema, модель отвечает деградировавшим output'ом: numeric tool names (`"0"`, `"1"`, `"5"`), пустые params. Это НЕ training quirk minimax'а, это **protocol mismatch на клиенте**.

**Решение — модуль `modelsDevCatalog.ts`** (electron-main/llmMessage). Лениво загружает `https://models.dev/api.json` при первом запросе, кеширует в памяти на время работы процесса. Для каждой модели на aggregator провайдере:

```ts
// In aiSdkAdapter.ts:
const sdkNpm = await getModelSdkNpm(baseURL, modelName);  // 'OK' '@ai-sdk/anthropic' / '@ai-sdk/openai-compatible' / undefined
const languageModel = sdkNpm === '@ai-sdk/anthropic'
    ? createAnthropic({ baseURL, apiKey, headers, fetch })(modelName)
    : createOpenAICompatible({ ... }).chatModel(modelName);
```

**Никакого hardcoded model-name / family / regex в коде.** Все routing-знания — в models.dev:
- Aggregator провайдер матчится по `provider.api` (точное соответствие нашему baseURL после нормализации trailing `/`).
- Per-модель override берётся из `models[id].provider.npm`.
- Если override нет — используется default `provider.npm`.
- Если modеls.dev недоступен (offline / 5xx / timeout 10s) — возврат `undefined`, caller использует свой default (openai-compatible).

**Что это даёт:**
- Завтра появится `maximax-m1` на opencode-go с `provider.npm: '@ai-sdk/anthropic'` в models.dev → автоматически правильный SDK без изменений кода.
- Новый aggregator (например `https://newprovider.example/v1`) попадает в models.dev → автоматически работает по `provider.api` matching.
- Если models.dev ошибётся (редко) — пользователь может через `vibeide.overridesOfModel[provider][model]` указать что-то, плюс auto-downgrade (O.0–O.10) поймает деградацию.

**Что НЕ требуется после этого фикса:**
- `vibeide.llm.toolFallbackMode = 'xml'` — для минимакса он теперь работает на native FC через правильный протокол.
- Auto-downgrade pipeline (O.0–O.10) — не срабатывает на правильно-роутящихся моделях, остаётся как страховка для других проблемных комбинаций.
- Headers (x-opencode-*) — могут оставаться для аналитики, но не gating-фактор. Гипотеза что aggregator routes по headers оказалась неверной — он routes по URL path (`/messages` vs `/chat/completions`).

### Headers для opencode.ai aggregator

Согласно `anomalyco/opencode src/session/llm.ts:361-374`, opencode CLI шлёт следующие headers для запросов на `opencode.ai/zen/*`:
- `User-Agent: opencode/<InstallationVersion>`
- `x-opencode-client: cli` (или из env `OPENCODE_CLIENT`)
- `x-opencode-project: <project-id>`
- `x-opencode-session: <session-id>`
- `x-opencode-request: <user-id>`

В VibeIDE (`aiSdkAdapter.ts`) тот же набор — `x-opencode-client: vibeide` (наша честная identification), `x-opencode-project/session` — стабильные per-process UUID'ы, `x-opencode-request` — fresh UUID на каждый вызов. Headers нужны для analytics aggregator'а, **не критичны** для функциональности тулов (правильный SDK-routing — критичен).

### Альтернатива: вытащить routing-table из models.dev в runtime

Долгосрочный план (открыт): вместо хардкода `OPENCODE_GO_ANTHROPIC_MODELS` в коде — fetcher `https://opencode.ai/zen/go/v1/models` или `https://models.dev/api.json` для получения `npm` поля (имя AI SDK package). Тогда новые модели на этом aggregator'е автоматически получат правильный routing. См. также `references/v1/models-dev-integration.md` (будущий документ).

### invalid_params: явный retry-hint

В `_runToolCall` при ошибке валидации параметров builtin-тула (line ~3066) сырое сообщение валидатора (`"Provided uri must be a string, but it's a(n) undefined"`) оборачивается в:

```
The tool "X" was called with invalid arguments: <raw>. Re-issue the call with correct parameter types — every field should match the type described in the tool's schema in the system prompt.
```

Без hint'а модель видит голую техническую ошибку и не понимает что от неё хотят — продолжает слать варианты с теми же ошибками типов. С hint'ом — переигрывает правильно.

### XML-парсер: case-insensitive lookup

`extractGrammar.ts`:

- `resolveCanonicalToolName` пробует точное совпадение, потом alias, потом lowercase-варианты обоих.
- `findIndexOfAny` ищет open-tag сначала точно, потом case-insensitive, возвращая литеральный отрезок из исходного текста (без потери регистра, важно для slice).

### Alias-таблица

`TOOL_NAME_ALIASES` + `PARAM_ALIASES_BY_TOOL` живут в `common/prompt/toolAliases.ts` (общий слой, импортируется и из `browser/`, и из `electron-main/`). Однонаправленная мапа `bash → run_command`, `view → read_file`, `read → read_file` (Kilo), `edit → edit_file` (Kilo), `apply_patch → edit_file` (Kilo), `fetch → browse_url` (Kilo), `str_replace_editor → edit_file`, etc. Покрывает модели, обученные на Anthropic / Cursor / Kilo Code / OpenAI каталогах.

Применение алиасов происходит в трёх местах одновременно (единый источник истины):

1. **AI SDK repair-hook** (`aiSdkAdapter.ts` → `experimental_repairToolCall`) — Stage 2 между lowercase-fallback и routing на `invalid`. Без этого SDK бросал NoSuchToolError для имён `read` / `bash` / `apply_patch`, ломая стрим.

2. **Dispatcher** (`chatThreadService._runToolCall` в начале функции) — для legacy native каналов (Anthropic native, Gemini native, OpenAI native) и сетки безопасности на AI SDK пути. Резолвит `requestedToolName` → `toolName` через цепочку `isCanonical → lowercase → TOOL_NAME_ALIASES`.

3. **XML-парсер** (`extractGrammar.ts` → `resolveCanonicalToolName`, `resolveInvokeParamName`) — для моделей без native function-calling, эмитящих тулы как XML-теги в тексте.

`PARAM_ALIASES_BY_TOOL` обрабатывает кросс-экосистемные имена ПОЛЕЙ:
- `path` / `file_path` / `filepath` / `file` / `filename` → `uri` (read_file, edit_file, rewrite_file, create_file_or_folder, delete_file_or_folder, ls_dir, get_dir_tree, open_file)
- Kilo `offset` → `start_line`, `limit` / `max_lines` → `line_limit` для read_file
- `cmd` / `shell_command` / `bash_command` / `ps_command` → `command`, `working_directory` / `dir` / `path` → `cwd` для run_command
- `glob_pattern` → `pattern`, `regex` / `search` → `pattern` для grep

`applyParamAliases(toolName, rawParams)` — pure function в `toolAliases.ts`. Вызывается в `chatThreadService._runToolCall` до validateParams и переписывает ключи rawParams через мапу. First-wins: если canonical имя уже есть в params, alias не перетирает. Без этого вызова minimax/qwen с native function-calling валятся на `Provided uri must be a string, but it's a(n) undefined` потому что эмитят `{path: ...}` вместо `{uri: ...}`.

### MCP-префикс

MCP-тулы видятся модели под именем `<sanitize(server)>_<sanitize(tool)>`, где `sanitize = s => s.replace(/[^a-zA-Z0-9_-]/g, '_')`. Это решает коллизию двух MCP-серверов с одинаковым tool-name (раньше выигрывал первый в порядке итерации `Object.keys`). Конструкция совпадает с Kilo (`packages/opencode/src/mcp/index.ts`).

- Поле `originalName` в `InternalToolInfo` хранит bare-name для отправки в MCP-протокол через `_mcpService.callMCPTool({ toolName: originalName ?? prefixed })`.
- Plan-mode allowlist (`_mcpCallMatchesPlanAllowlist`) принимает совпадение по **обоим** именам (prefixed и original), чтобы старые планы со списком bare-names продолжали работать.
- В системном промпте MCP-тулы перечисляются с префиксированными именами (если XML вообще включён — то есть для моделей без нативного канала).

### Identification of model family

`common/prompt/modelFamily.ts` — утилита `detectModelFamily(providerName, modelName, specialToolFormat)`. Возвращает `'anthropic' | 'gpt' | 'gemini' | 'default'`. Сейчас **только пробрасывается** через `chat_systemMessage` / `chat_systemMessage_local` (поле `modelFamily?`) без потребителей внутри функции — инфраструктура под будущие per-family квирки. Кешер `_systemMessageCache` учитывает `providerName/modelName`, чтобы при появлении ветвлений не было перекрёстных загрязнений.

---

## Применение

### При работе над прогрессом tool-calling

1. **Никогда не вставлять нумерацию в перечисление тулов** (`toolCallDefinitionsXMLString`). Модели интерпретируют `1. read_file` как «у тула есть числовой индекс» и галлюцинируют `MCP tool 1`.
1.1. **Это правило шире — не только для tool definitions.** ЛЮБОЙ нумерованный список в system prompt, который рядом с цифрой упоминает имена тулов, провоцирует тот же квирк у training-broken моделей (minimax-m2.x, qwen-coder). Конкретный кейс из 2026-05-16: блок `importantDetails` в `chat_systemMessage` имел нумерацию `${i + 1}. ${d}` где `d` содержал «Use read_file, edit_file, search_for_files, run_command» — минимакс трактовал это как numbered tool list и кидал `tool name "1"`, `"4"`, `"5"`. Исправлено на bullets (`- ${d}`). Это объясняло почему у Kilo с тем же минимакс через тот же aggregator всё работало: у них bullets, у нас были numbers.
2. **Не возвращать дублирование** `includeXMLToolDefinitions = !specialToolFormat || chatMode === 'agent' || …`. Если для какой-то модели native-канал действительно сломан — добавить её в branch внутри `aiSdkAdapter.ts` (отдельный фолбэк), а не открывать оба канала.
3. **При добавлении нового direct-провайдера в Stage 2b/3 миграции (см. [[ai-sdk-migration-wip-full]])** — расширить `detectModelFamily` switch-кейсом по providerName.
4. **При добавлении нового tool-alias** — править `TOOL_NAME_ALIASES` (только active при наличии canonical таргета в chatMode).
5. **При новых MCP-проверках по имени** — учитывать, что `tool.name` уже префиксированный. Bare-имя — в `originalName`.

### При диагностике «модель не видит тулы»

- Проверить `specialToolFormat` для модели в `modelCapabilities.ts`.
- Если `undefined` → должен быть `extractXMLToolsWrapper`-путь. Прогнать smoke-тест с явным XML-тегом в ответе модели.
- Если установлен → AI SDK должен получать `tools:` (`aiSdkAdapter.ts:382-389`). Проверить, что модель действительно эмитит `tool-call` event в `result.fullStream`.
- При жалобах «MCP tool N not found» → искать нумерацию в промптах (см. правило 1 выше) или ловить упущенный кейс в `resolveCanonicalToolName`.

### Откат изменений из этой миграции

| Изменение | Файл | Как откатить |
|---|---|---|
| Снятие двойного канала | `convertToLLMMessageService.ts:1308, 1515` | Вернуть `|| chatMode === 'agent' || chatMode === 'plan'` |
| Безусловная передача tools в AI SDK | `aiSdkAdapter.ts:382` | Вернуть тернарник по `specialToolFormat` |
| Нумерация в XML-описании | `prompts.ts:530` | Вернуть `${i+1}. ${t.name}` |
| MCP-префикс | `mcpService.ts:getMCPTools` | Убрать `sanitizedServer + '_'` и поле `originalName` |
| `experimental_repairToolCall` | `aiSdkAdapter.ts:streamText` | Удалить поле |
| `invalid` псевдо-тул (execute + dispatcher) | `aiSdkAdapter.ts`, `chatThreadService.ts` начало `_runToolCall` | Удалить execute у invalid, вернуть `throw new Error(...)` в MCP-ветке |
| Lowercase normalization в `_runToolCall` | `chatThreadService.ts` начало `_runToolCall` | Удалить `loweredRequested`-блок и переименовать обратно в `toolName` параметр |
| Case-insensitive `findIndexOfAny` | `extractGrammar.ts` | Удалить второй цикл |

---

## Реестр тулов — Kilo-style per-tool модули

Каждый из встроенных тулов живёт в `common/prompt/tools/<tool>.ts` отдельным модулем. Структура:

```
common/prompt/
├─ prompts.ts                     ← system-prompt builder, re-export `builtinTools`
├─ snakeCase.ts                   ← leaf-типы SnakeCase / SnakeCaseKeys
├─ modelFamily.ts                 ← detectModelFamily()
└─ tools/
   ├─ _constants.ts               ← leaf-константы (timeouts, ORIGINAL/DIVIDER/FINAL, tripleTick)
   ├─ _helpers.ts                 ← uriParam, paginationParam, terminalDescHelper, cwdHelper, replaceTool_description, ToolDef<T>
   ├─ index.ts                    ← агрегатор: builtinToolDefs satisfies { [T]: ToolDef<T> }
   ├─ read_file.ts
   ├─ ls_dir.ts
   ├─ … (30 файлов)
   └─ browse_url.ts
```

**Граф зависимостей строго один-направленный** (нет циклов):

```
tools/<tool>.ts  →  _helpers.ts  →  _constants.ts
                 ↘  ../snakeCase.ts (leaf)
                 ↘  ../../toolsServiceTypes.ts
tools/index.ts   →  все tools/<tool>.ts
prompts.ts       →  tools/index.ts, tools/_constants.ts
```

Чтобы избежать цикла, `toolsServiceTypes.ts` больше **не** импортирует runtime-значение `builtinTools` — `BuiltinToolParamNameOfTool<T>` теперь вычисляется как `keyof SnakeCaseKeys<BuiltinToolCallParams[T]>`.

**При добавлении нового встроенного тула:**
1. Создать `tools/new_tool_name.ts` с одним экспортом `export const NEW_TOOL_NAME_TOOL: ToolDef<'new_tool_name'> = {...}`.
2. Добавить запись в `tools/index.ts` (`builtinToolDefs.new_tool_name = NEW_TOOL_NAME_TOOL`).
3. Дополнить `BuiltinToolCallParams` и `BuiltinToolResultType` в `toolsServiceTypes.ts`.
4. Реализовать execute-логику в `toolsService.callTool[name]` (это пока остаётся в `toolsService.ts`, переезд в per-tool — отдельная задача).

`satisfies { [T in BuiltinToolName]: ToolDef<T> }` в `tools/index.ts` гарантирует, что забытый тул вызовет compile error.

---

## [правило] Граница workspace — config-driven (read открыт, write закрыт)

`validateURI()` в `toolsService.ts` решает, можно ли тулу трогать путь вне открытой рабочей области. С 2026-05-24 это **не зашитый запрет**, а две настройки в `vibeAgentBehaviorConfiguration.ts`:

| Ключ | Default | Кого касается |
|---|---|---|
| `vibeide.agent.allowReadOutsideWorkspace` | `true` (открыто) | read-only тулы: read_file, ls_dir, get_dir_tree, search_in_file, read_lint_errors, open_file, go_to_definition, find_references, search_symbols, automated_code_review, + search-root у search_for_files / glob / grep |
| `vibeide.agent.allowWriteOutsideWorkspace` | `false` (закрыто) | изменяющие тулы: edit_file, rewrite_file, create_file_or_folder, delete_file_or_folder, rename_symbol, extract_function, generate_tests |

**Почему read открыт по умолчанию:** жёсткий запрет тривиально обходился через `run_command` + `Get-Content`, поэтому давал не безопасность, а трение (агент застревал в обходных попытках, тегами протекая в чат — см. incident в [xml-tool-normalization.md](./xml-tool-normalization.md) Layer 4). Write остаётся закрытым: защита от случайной записи в системные файлы и соседние проекты.

**Механика:** конструктор `ToolsService` определяет `requireWorkspaceForRead()` / `requireWorkspaceForWrite()` (читают config на каждый вызов) и обёртки `validateReadURI` / `validateWriteURI` / `validateOptionalReadURI`. Каждый валидатор в `validateParams` зовёт нужную обёртку. При отказе бросается чистое локализованное сообщение с **точным ключом настройки** (copy-paste в поиск Параметров), без технического блока и без подсказок про обходы.

---

## Связанные файлы

- [aiSdkAdapter.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/aiSdkAdapter.ts) — AI SDK путь, `convertToolsToAiSdkToolSet`, `experimental_repairToolCall`.
- [sendLLMMessage.impl.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/sendLLMMessage.impl.ts) — legacy пути (Anthropic native, Gemini native, OpenAI native).
- [extractGrammar.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/extractGrammar.ts) — XML-парсер, alias-таблица, partial-tag detection.
- [prompts.ts](../../../src/vs/workbench/contrib/vibeide/common/prompt/prompts.ts) — `systemToolsXMLPrompt`, `chat_systemMessage`, `InternalToolInfo`, re-export `builtinTools`.
- [tools/index.ts](../../../src/vs/workbench/contrib/vibeide/common/prompt/tools/index.ts) — реестр всех встроенных тулов.
- [tools/_helpers.ts](../../../src/vs/workbench/contrib/vibeide/common/prompt/tools/_helpers.ts) — `ToolDef<T>`, общие helpers.
- [modelFamily.ts](../../../src/vs/workbench/contrib/vibeide/common/prompt/modelFamily.ts) — `detectModelFamily()` утилита.
- [mcpService.ts](../../../src/vs/workbench/contrib/vibeide/common/mcpService.ts) — `getMCPTools()` с префиксацией.
- [chatThreadService.ts](../../../src/vs/workbench/contrib/vibeide/browser/chatThreadService.ts) — диспетчер тулов (built-in vs MCP), `_mcpCallMatchesPlanAllowlist`, информативная ошибка при неизвестном tool name.
- [ai-sdk-migration-wip.md](ai-sdk-migration-wip.md) — параллельная незавершённая миграция провайдеров.
