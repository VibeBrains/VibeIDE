# LLM-провайдеры и контекст

← [Knowledge Index](../README.md)

Записи про общий каркас провайдеров, remote catalog, OpenCode Zen vs Go vs OpenRouter, context filter, `@diagram`.

---

## [архитектура] LLM-провайдеры VibeIDE: общий каркас vs точечные источники моделей

**Контекст:** Вопрос, можно ли тем же приёмом закрыть все провайдеры или всё индивидуально.

**Суть:**
1. **Общее для всех:** `getModelCapabilities` (реестр `modelOptions` → `modelOptionsFallback` / `extensiveModelOptionsFallback` → `defaultModelOptions`, затем **`overridesOfModel`**). Сбор чата, бюджет контекста и **smart truncation** в **`convertToLLMMessageService`** завязаны на эти числа, а не на имя провайдера отдельной веткой.
2. **Обновление каталога:** кнопка «Refresh … model catalog» → **`refreshRemoteCatalog`** → **`remoteCatalogService.fetchCatalog`** → при наличии числового **`contextWindow`** в элементах — **`mergeOverridesForProviderModels`** (единая запись в состояние).
3. **Точечно по провайдеру:** в **`remoteCatalogService`** для многих провайдеров пока заглушки `[]`; реально каталог: **OpenRouter** (`context_length`), **OpenCode Zen / OpenCode** (OpenAI-style `GET …/v1/models`, парсер контекста общий, пока Zen часто без поля лимита). Локальные **ollama / vLLM / lmStudio** — список через **`list`** в main (`_openaiCompatibleList` / ollama), не через `remoteCatalogService`; прокидывание контекста из этого списка в overrides — отдельная доработка, если понадобится.
4. **Реестр в `modelCapabilities`:** у части провайдеров большие **`modelOptions`**; у OAI-совместимых часто пустой объект и опора на **fallback по строке имени** — это поддержка каталога «новая модель», а не дублирование логики truncation на каждый бренд.

**Применение:** добавить провайдер с API списка моделей — новый `case` + вызов общего **`fetchOpenAICompatibleModelsCatalog`** или свой парсер; не копировать логику чата. Нет каталога — дополнять **`modelOptions`** / эвристики **`extensiveModelOptionsFallback`** или ручные **Model Overrides**.

---

## [архитектура] Удалённый каталог моделей провайдеров — UI и хранение

**Контекст:** настройка списков моделей OpenRouter и других облачных провайдеров без зашитых id; запрос поиска, рефреша, поведения «всё выкл» и очистки при обновлении каталога (2026-05).

**Суть:** актуальные id подтягиваются через **`IRemoteCatalogService.fetchCatalog`** + **`IRefreshModelService.refreshRemoteCatalog`**. Список в UI — это **`settingsOfProvider[provider].models`**; «включена в дропдаун» = **`!isHidden`**. После каждого **успешного** синка с удалённым каталогом **`setAutodetectedModels(..., { defaultHiddenForNew: true })`**: для **нового** id с каталога ставится **`isHidden: true`** (тумблер off), для id, которые уже были у пользователя — **сохраняется прежний** `isHidden`. Локальные провайдеры (Ollama / vLLM / LM Studio) передают **`defaultHiddenForNew: false`**. После merge оверрайдов с API вызывается **`pruneOverridesToProviderModels`**: удаляются записи **`overridesOfModel[provider][modelName]`** для моделей, которых больше нет в `models`. **`setAutodetectedModels`** — `async` с **`await setSettingOfProvider`**, чтобы не гонять порядок с **`mergeOverridesForProviderModels`**. Пустой ответ каталога (`0` моделей) **не затирает** сохранённый список. В React **`Settings.tsx` → `ModelDump`**: поиск по подстроке, **иконка обновления** (`RefreshRemoteCatalogButton` с `compact`) для провайдеров из **`remoteCatalogCapableProviderNames`**. В **`defaultCustomSettings`** (типы) обязателен ключ **`publicCatalog`** под OpenRouter.

**Применение:** менять логику «какие модели видны по умолчанию», синк или кнопку рефреша — смотреть `vibeideSettingsService.ts`, `refreshModelService.ts`, `remoteCatalogService.ts`, `Settings.tsx`.

---

## [термин] OpenCode Zen vs OpenCode Go vs OpenRouter

**Контекст:** запрос на восстановление интеграции после sync; в коде провайдер **`openCodeZen`**, путаница с OpenRouter. Позже добавлен отдельный UI-провайдер **OpenCode** (план Go).

**Суть:**
- **OpenCode Zen** — шлюз OpenCode, OpenAI-compatible base **`https://opencode.ai/zen/v1`**, ключ с [opencode.ai/zen](https://opencode.ai/zen).
- **OpenCode Go** (в продукте — карточка **OpenCode**, id **`openCode`**) — та же экосистема аккаунта, отдельный API prefix **`https://opencode.ai/zen/go/v1`** ([доки Go](https://dev.opencode.ai/docs/go)), модели Qwen / DeepSeek V4 / Kimi / GLM / MiMo / … (часть моделей на Go использует не `/chat/completions` — в дефолтный список попадают только OAI-compatible id).
- **OpenRouter** — другой агрегатор, **`https://openrouter.ai/api/v1`**.

Порядок карточек **Main Providers** задаётся порядком ключей в **`defaultProviderSettings`** (`modelCapabilities.ts`) → `providerNames` / `nonlocalProviderNames`. Старт non-local: **Zen → OpenCode (Go) → OpenRouter**, далее по файлу.

**Применение:** при правках LLM-провайдеров и саппорте уточнять endpoint и ключ (Zen vs Go vs OR).

**Устарело:** короткая запись про «OpenRoute Zen» без Go и без порядка UI.

---

## [референс] OpenCode upstream (anomalyco/opencode) — где смотреть headers / transform / errors

**Контекст:** при триггере skill `opencode-repo` («как у opencode», «у opencode работает»). Эталон-репо для поведения чата против `opencode.ai/zen` aggregator, потому что у пользователя через opencode CLI проблемные модели (kimi-k2, minimax-m2, deepseek-v4-pro) стримятся стабильно, а в VibeIDE — нет.

**Суть:**
- **Upstream:** [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode), `dev` branch. Структура отличается от Kilo: выделены пакеты `packages/llm/` (HTTP-протоколы, `providers/`, `protocols/`) и `packages/opencode/` (агент, сессии, инструменты). GUI (`packages/desktop/`) — Electron-обёртка вокруг того же core, **своего LLM-пути не имеет** (структура: `main/preload/renderer`, в `main/src/*.ts` LLM-кода нет; стрим идёт через shared `opencode/src/session/llm.ts`).
- **Headers:** [`packages/opencode/src/session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/request.ts) **строки 158-184** — **единственный** источник заголовков в репо (поиск `x-opencode-session` даёт ровно один файл + server-side handler в `console/`). Логика двухветочная: если `model.providerID.startsWith("opencode")` — шлёт `x-opencode-project` / `x-opencode-session` / `x-opencode-request` / `x-opencode-client` + `User-Agent: opencode/<InstallationVersion>`. Иначе (другой aggregator/native cloud) — шлёт `x-session-affinity: <sessionID>` + опциональный `x-parent-session-id` + `User-Agent`. `x-opencode-request` = `input.user.id` (id текущего user-сообщения, не uuid per HTTP-call).
- **Model quirks:** [`packages/opencode/src/provider/transform.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts) — model-specific `temperature/topP/topK` пресеты (строки 478-510 для kimi/minimax/glm/gemini), форсированный `{ type: "reasoning", text: "" }` placeholder на каждый assistant message для deepseek-семейства (строки 285-301), дублирование reasoning в `providerOptions.openaiCompatible.reasoning_content` для моделей с `interleaved.field` capability (строки 311-336).
- **Error classification:** [`packages/opencode/src/provider/error.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/error.ts) **строки 11-31** — `OVERFLOW_PATTERNS` регексы, специфичные для каждого провайдера: `/exceeded model token limit/i` (Kimi, Moonshot), `/context window exceeds limit/i` (MiniMax), `/maximum context length is \d+ tokens/i` (OpenRouter/DeepSeek/vLLM) и др. При матче — error type становится `context_overflow`, не «unknown».
- **maxRetries:** [`packages/opencode/src/session/llm.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm.ts) — `maxRetries: input.retries ?? 0` в `streamText({...})`. Upstream **не ретраит** на уровне AI SDK; вся recovery — на стороне aggregator/error-classifier.

**Применение:** при триггере skill `opencode-repo` идти именно в эти 4 файла (`session/llm/request.ts`, `provider/transform.ts`, `provider/error.ts`, `session/llm.ts`). Не путать с Kilo Code — у них родственная, но не идентичная архитектура (у Kilo `packages/opencode/src/provider/transform.ts` тоже есть, но без выделенного `llm/` пакета). Сравнение VibeIDE vs opencode по этим 4 точкам — главный диагностический инструмент для проблем «Empty response from openCode/…».

---

## [архитектура] IVibeContextFilterService — dynamic context compaction

**Контекст:** закрытие «Dynamic context filtering / sandbox aggregation» из roadmap § F/G.

**Суть:** `IVibeContextFilterService.compact(toolName, result, contextFillPct)` → отфильтрованная строка:
- Режимы: `auto` (default) / `raw` / `aggregate` / `off`
- `auto`: если `contextFillPct ≥ vibeide.context.filterThresholdPct` (default 70) → `aggregate`, иначе → `raw`
- Per-tool compactors: `read_file` (≤N строк + truncate marker), `grep`/`glob`/`semantic_search` (≤N хитов), `run_terminal_command` (последние N строк), unknown tools (≤8KB)
- **Прозрачность:** `getLastFilterStats()` возвращает `{fullResult, compactedResult, wasCompacted}` — `VibeDebugPromptService` получает **оба** варианта для "debug my prompt" replay
- Каждое усечение явно маркируется `[... N lines/chars truncated ...]` — нет тихого удаления данных
- `hasCompactedThisSession()` → статус-бар может показать индикатор
- Phase 3b: hook в `chatThreadService._runToolCall` — injection point документирован в `references/v1/context-filtering-policy.md`

**Применение:** добавить новый compactor — добавить ключ в `TOOL_COMPACTORS` в `vibeContextFilterService.ts`; режим — настройка `vibeide.context.filterMode`.

---

## [архитектура] @diagram mention + IVibeDiagramContextService

**Контекст:** реализация `@diagram` picker для прикрепления PNG/SVG/drawio в контекст агента.

**Суть:** `IVibeDiagramContextService.resolveDiagramForContext(value)` → `DiagramContextBlock`:
- PNG/JPG/WEBP/BMP → base64 data URI (vision models); блокируется в stealth mode или при `vibeide.context.diagram.allowBase64=false`
- SVG → inline ` ```svg ` блок (text, не base64)
- `.drawio`/`.excalidraw`/`.mermaid`/`.puml` → raw XML/text в code fence
- Remote URL / figma.com → placeholder (пользователь использует Figma MCP)
- Файл > `vibeide.context.diagram.maxSizeBytes` (default 200KB) → placeholder с размером
- `parseDiagramMentions()` в `VibeMentionService`: разбирает `@diagram`, `@diagram:path.png`, `@diagram:https://...`
- `vibeide.context.pickDiagram` → workspace scanner (рекурсивно, ≤5 уровней, исключает node_modules/.git/out/dist) → QuickPick → `@diagram:path` в буфер обмена
- `vibeide.context.previewDiagram` — показывает что попадёт в LLM (label / content / isBase64)
- Phase 3b: inject в LLM message builder при `@diagram` mention через `convertToLLMMessageService`

**Применение:** поддержка новых типов диаграмм — добавить ext в `MIME_MAP` или `TEXT_DIAGRAM_EXTS` в `vibeDiagramContextContribution.ts`.
