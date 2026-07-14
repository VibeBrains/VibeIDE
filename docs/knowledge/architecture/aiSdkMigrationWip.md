# Vercel AI SDK migration — WIP, незавершено

> **СТАТУС: НЕЗАВЕРШЕНО.** Если новая сессия открывает этот файл — мы посреди многоступенчатой миграции с нативных SDK на Vercel AI SDK (`ai` + `@ai-sdk/*`), и ни одна стадия пока не протестирована в рантайме. Не считать «закрытым» пока чек-листы ниже не выставлены в [x].

---

## Контекст

Триггер — баг `Empty response from openCode/minimax-m2.7 (reason: tool_calls)`. Корень: `_sendOpenAICompatibleChat` в [sendLLMMessage.impl.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/sendLLMMessage.impl.ts) парсит SSE-чанки руками — `chunk.choices[0]?.delta?.tool_calls[i].index !== 0` дропает tool_calls без `index`, что присылают агрегаторы (openCode/openCodeZen и т.п.) под не-OpenAI-апстримами.

Kilo Code ([github.com/Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode), `packages/opencode/src/provider/`) решает это иначе: они вообще не парсят OpenAI-чанки. Используют `streamText` из `ai` + полтора десятка `@ai-sdk/*` адаптеров. Каждый адаптер изолирует квирки своего провайдера и эмитит нормализованный поток событий `text-delta`/`reasoning-delta`/`tool-input-start`/`tool-input-delta`/`tool-call`/`finish`. Никакого `delta.tool_calls[i].index` в коде Kilo нет.

Поставленная пользователем цель: перенять подход Kilo для VibeIDE.

## Суть — что уже сделано

### Точечный фикс (отдельный коммит — НЕ часть миграции)

- В `_sendOpenAICompatibleChat`: `const index = tool.index` → `const index = tool.index ?? 0`. Защищает все остальные пути, ещё не мигрированные ниже.

### Зависимости

- Добавлены: `ai@^6.0.182`, `@ai-sdk/openai-compatible@^2.0.47` (через `npm install --save --ignore-scripts`).
- Транзитивно: `@ai-sdk/provider@3.0.10`, `@ai-sdk/provider-utils@4.0.27`. Peer-dep `zod` удовлетворён существующим `4.3.6`.

### Стадия 1 — 7 агрегаторов

Создан [aiSdkAdapter.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/aiSdkAdapter.ts) (~430 строк).

Переключены на `sendViaAISdk` в [sendLLMMessage.impl.ts → sendLLMMessageToProviderImplementation](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/sendLLMMessage.impl.ts):

- `openCode`, `openCodeZen`, `openRouter`, `openAICompatible`, `liteLLM`, `lmRoute`, `pollinations`.

`SendChatParams_Internal` стал `export type` (нужно адаптеру).

### Стадия 2a — 7 direct cloud-провайдеров

Резолвер в `aiSdkAdapter.ts` стал async и принимает `modelName` (нужно для Azure deployment-URL и для async `getGoogleApiKey()`).

Переключены: `deepseek`, `mistral` (chat), `xAI`, `groq`, `awsBedrock`, `googleVertex`, `microsoftAzure`.

`getGoogleApiKey`, `assertHttpHeaderSafe` стали `export` в `sendLLMMessage.impl.ts`.

Azure: `baseURL = .../openai/deployments/{modelName}` + `queryParams = { 'api-version': azureApiVersion }`. AI SDK сам дописывает `/chat/completions`.

`mistral.sendFIM` оставлен на нативном `@mistralai/mistralai` через `sendMistralFIM` — FIM не мигрирует.

### Что НЕ мигрировано

| Провайдер | Текущий путь | Почему не тронут |
|---|---|---|
| `openAI` (native) | `_sendOpenAICompatibleChat` | Уникальный retry на `400 unsupported_value/stream` + `"organization must be verified"` — тихо повторяет без stream. Для reasoning-моделей у неверифицированных org. В адаптере не воспроизведено. Дублировать — отдельная правка в Стадии 3. |
| `anthropic` | `sendAnthropicChat` (нативный `@anthropic-ai/sdk`) | Стадия 2b. Thinking-блоки с подписями, `redacted_thinking`, `anthropicReasoning` в `onFinalMessage` для прокатки в следующие ходы, `tool_use`/`tool_result` блоки, обязательный `max_tokens`, `system` на верхнем уровне. Требует `@ai-sdk/anthropic`. |
| `gemini` | `sendGeminiChat` (нативный `@google/genai`) | Стадия 2b. Формат `parts`, `thinkingConfig.thinkingBudget`, парсер rate-limit ошибок с вложенным JSON и `retryDelay`. Требует `@ai-sdk/google`. |
| `ollama`, `vLLM`, `lmStudio` | `_sendOpenAICompatibleChat` | Стадия 3. Другие таймауты: rolling stall (60s) для local, first-token 10s. Local-only сценарии: `getModelCapabilities` для них даёт фолбэк-конфигурацию через `extensiveModelOptionsFallback`. |
| Mistral FIM | `sendMistralFIM` (нативный `@mistralai/mistralai`) | FIM не покрывается AI SDK. Удалить `@mistralai/mistralai` не получится без альтернативы. |
| `_sendOpenAICompatibleFIM` | свой путь | Используется liteLLM/openRouter/lmRoute/openAICompatible/awsBedrock для FIM. Не трогаем. |

### Аспекты, сохранённые внутри `sendViaAISdk`

- `extractReasoningWrapper` (open-source `<think>`-теги) и `extractXMLToolsWrapper` (XML-fallback при `specialToolFormat=undefined`) — применяются 1-в-1, как в legacy.
- `assumeNativeTools` kill-switch для синтезированных `__aggregator_unknown__` — соблюдается.
- `additionalOpenAIPayload` пробрасывается через `transformRequestBody: (body) => ({...body, ...payload})`.
- Corporate-CA: `customFetch` оборачивает `undici.fetch` с module-level `sharedDispatcher = ensureSystemCADispatcher()`.
- Single-slot tool accumulator (`toolName`/`toolId`/`toolParamsStr`) — `tool-input-start` с уже занятым слотом игнорируется. Мульти-тул в одном ответе пока не поддерживается (как и в legacy).
- Timeouts: first-token 30s, общий 180s (`runtimeOptions.timeoutMs.aggregator`). Partial-flush при таймауте через `onFinalMessage`.

## Применение — что делать в следующей сессии

### Если пользователь хочет продолжить миграцию

**Стадия 2b** (две под-стадии, каждая ≈ отдельный PR):

1. **2b.1 — Anthropic через `@ai-sdk/anthropic`.** Самое сложное. Семантика `anthropicReasoning` (подписанные thinking-блоки) должна выживать через `providerOptions.anthropic.thinking` и `ReasoningPart` в `ModelMessage`. Иначе follow-up ходы reasoning-моделей сломаются. План: спросить пользователя, можно ли терять подписи при первом ходе ради простоты, или нужно делать честный маппинг.

2. **2b.2 — Gemini через `@ai-sdk/google`.** Маппинг `parts` ↔ `ModelMessage.content`. Rate-limit парсер (Gemini-специфичный, `RESOURCE_EXHAUSTED` + `retryDelay`) перенести в catch-блок `sendViaAISdk` как Gemini-специфичную ветку.

**Стадия 3** — local + openAI native + cleanup:

- `ollama`, `vLLM`, `lmStudio` на `@ai-sdk/openai-compatible` с правильными таймаутами (отдельные ветки в `resolveEndpoint` или флаг `isLocal` в результате).
- `openAI` native + воспроизведение org-verify retry в адаптере (catch специфичной ошибки → второй вызов через `generateText({stream:false})`).
- Удалить `_sendOpenAICompatibleChat`, `getOpenAICompatibleClient`, `parseHeadersJSON` (его копия живёт в адаптере), `openai` npm-зависимость.
- Удалить `@anthropic-ai/sdk` (после 2b.1), `@google/genai` (после 2b.2), `google-auth-library` (после 2b.1, использовался для Vertex — но Vertex на новом пути через `getGoogleApiKey()`, проверить, что ничего больше не зависит).

### Перед продолжением — ОБЯЗАТЕЛЬНО

Текущий код **не собирался и не запускался** после Стадии 1 и 2a. TypeScript-проверка прошла, но это не доказывает что AI SDK правильно собирает URL для Azure, что Vertex access-token не теряется, что reasoning-стрим у DeepSeek R1 эмитит `reasoning-delta`, что openRouter не отваливается на каком-нибудь дополнительном поле. Прежде чем добавлять anthropic/gemini — попросить пользователя собрать и прогнать smoke-тест по чек-листу ниже.

### Smoke-чек-лист после сборки

- [ ] `openCode` + `minimax-m2.7` + tool_call → ИСХОДНЫЙ БАГ ЗАКРЫТ.
- [ ] `openCode` или `openRouter` + `claude-sonnet-4` → обычный текст + tool_call.
- [ ] `openAICompatible` с пользовательским endpoint + `headersJSON` → custom headers доходят.
- [ ] `deepseek-chat` + `deepseek-reasoner` → второй должен показывать reasoning-стрим.
- [ ] `groq/llama-*` → обычный текст + tool_call.
- [ ] `xAI/grok-*` → обычный текст.
- [ ] `mistral` chat + FIM → FIM не сломался (legacy путь).
- [ ] `microsoftAzure` с реальным deployment → URL вида `.../deployments/<deployment>/chat/completions?api-version=X` в DevTools Network.
- [ ] `googleVertex` с реальным project/region → access-token свежий, не висит на старом.
- [ ] `awsBedrock` через локальный LiteLLM-прокси → `/v1`-нормализация работает.
- [ ] Не мигрированные пути не регрессировали: `openAI` native, `anthropic`, `gemini`, `ollama`/`vLLM`/`lmStudio`.

### Если smoke-чек-лист падает

- Azure URL-структура — наибольший риск. Если 404 → `@ai-sdk/azure` отдельной зависимостью.
- Reasoning у DeepSeek R1 — если `reasoning-delta` не приходит, может потребоваться маппинг `nameOfReasoningFieldInDelta` (`reasoning_content`) через `providerOptions` или вернуть DeepSeek на legacy путь.
- OpenRouter `additionalOpenAIPayload` (`provider_routing` и т.п.) — проверить через `transformRequestBody`.

### Откат любой стадии

Точечно — переключить записи в таблице `sendLLMMessageToProviderImplementation` обратно с `sendViaAISdk` на `_sendOpenAICompatibleChat` / `sendAnthropicChat` / `sendGeminiChat`. Адаптер остаётся в репо как мёртвый код до следующего PR.

---

## [пробел→фикс] AI-SDK путь не отправлял reasoning-control payload (проверено 2026-06-08)

**Контекст:** legacy `_sendOpenAICompatibleChat` вычисляет `reasoningInfo` (`getSendableReasoningInfo`) и мёржит `providerReasoningIOSettings.input.includeInPayload(reasoningInfo)` в тело запроса (`reasoning_effort`, `thinking:{...}`). А `sendViaAISdk` этого НЕ делал — в нём вообще не было `modelSelectionOptions`/`getSendableReasoningInfo`. `transformRequestBody` слал только статичный `additionalOpenAIPayload`.

**Суть:** для ВСЕХ провайдеров на AI-SDK пути (minimax, deepseek, openRouter, …) слайдер/тумблер reasoning были **мёртвыми** — выбор пользователя не доходил до запроса. Фикс: в `aiSdkAdapter` добавлен `modelSelectionOptions` в destructure, считается `reasoningInputPayload = providerReasoningIOSettings.input.includeInPayload(getSendableReasoningInfo('Chat', …))` и мёржится в `transformRequestBody` рядом с `additionalOpenAIPayload` (только для openai-compatible; google/anthropic создаются отдельными factory без этого transform). Пустой payload (reasoning по умолчанию) ничего не добавляет.

**Применение:** если у какой-то AI-SDK модели «слайдер усилия не действует» — payload теперь уходит; проверять сторону вендора (как MiniMax-M3, см. [[modelQuirks]]), а не плюминг. Anthropic-style `thinking:{budget_tokens}` через transformRequestBody НЕ идёт (anthropic — отдельный factory `createAnthropic`, у него свой `providerOptions.anthropic`).

---

## Связанные файлы

- [aiSdkAdapter.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/aiSdkAdapter.ts) — адаптер.
- [sendLLMMessage.impl.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/sendLLMMessage.impl.ts) — таблица провайдеров и legacy-пути.
- [extractGrammar.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/extractGrammar.ts) — `extractReasoningWrapper`/`extractXMLToolsWrapper`.
- [systemCAFetch.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/systemCAFetch.ts) — `ensureSystemCADispatcher()`.
- [llmAndContext.md](llmAndContext.md) — общая архитектура LLM-провайдеров (без деталей миграции).
