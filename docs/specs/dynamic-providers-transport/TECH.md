# TECH — Динамические LLM-провайдеры: реальная отправка + reasoning + надёжность под Moonshot/Kimi

Парная к [PRODUCT.md](./PRODUCT.md). Поведение — там; здесь реализация, заземлённая в коде. Фазы A/B/C из PRODUCT.

## Context

Поток отправки LLM-запроса:

- **Диспатч:** `electron-main/llmMessage/sendLLMMessage.ts:132-136` — `sendLLMMessageToProviderImplementation[providerName]`; если записи нет → `onError('Provider not recognized')` и ранний выход. Карта определена в `sendLLMMessage.impl.ts:1701` (тип `CallFnOfProvider`, ключи — только встроенные `ProviderName`). Каждый встроенный провайдер маппится на `sendViaAISdk`, либо legacy `_sendOpenAICompatibleChat`/`sendAnthropicChat`/`sendGeminiChat`.
- **AI-SDK путь:** `electron-main/llmMessage/aiSdkAdapter.ts` → `sendViaAISdk` (:752). Резолв транспорта — `resolveEndpoint(providerName, modelName, settingsOfProvider)` (:837) → `{baseURL, apiKey, headers, queryParams}` (switch `resolvePerProvider` :147-298). Пустой `baseURL` → `onError('missing endpoint configuration')` (:843-846). SDK выбирается data-driven (models.dev / `apiProtocol` override / fallback openai-compatible :864, :877-934).
- **Инъекция тела (openai-compatible):** `createOpenAICompatible({... transformRequestBody: body => ({...body, ...openAICompatExtraBody})})` (:923-934). А `openAICompatExtraBody` (:780) = `{ ...additionalOpenAIPayload, ...reasoningInputPayload }`, где `additionalOpenAIPayload`/`reasoningCapabilities` берутся из `getModelCapabilities` (:770-771), а `reasoningInputPayload` — из `providerReasoningIOSettings.input.includeInPayload(reasoningInfo)` (:777-779). Для openai-compat это `openAICompatIncludeInPayloadReasoning` → `{reasoning_effort}` (`modelCapabilities.ts:1013-1020`), output `reasoning_content` (`:1700-1708`).
- **Тулы:** `tools = specialToolFormat ? convertToolsToAiSdkToolSet(availableTools(chatMode, mcpTools), true) : undefined` (`aiSdkAdapter.ts:996`).
- **Динамические caps:** `browser/vibeDynamicProvidersService.ts` → `modelEntryToCaps` (:40-56) маппит только `contextWindow/reservedOutputTokenSpace/specialToolFormat/supportsVision/supportsSystemMessage/cost`. `reasoning`/`extraBody`/`fim` из `VibeProviderModelEntry` (`common/vibeProvidersFile.ts:42-68`) НЕ маппятся. Транспорт (baseURL/apiKey/apiKeyEnv/headers, ключ резолвится `apiKeyRef→.vibe/.env→env`) уже кладётся overlay'ем в `settingsOfProvider[id]` (2b-2 C, `applyProviderActiveOverrides` + send-site merge).

**Главная находка:** динамик не доходит до `sendViaAISdk` — диспатч отбивает неизвестный id. А reasoning/extraBody на AI-SDK пути **уже инжектятся** — нужно лишь наполнить caps. Это определяет дешевизну фазы B.

## Proposed changes

### Фаза A — динамики реально отправляют

**A1. Дефолт-ветка резолва транспорта** — `aiSdkAdapter.ts`, `resolvePerProvider`/`resolveEndpoint` (:147-298, :837).
Для не-встроенного `providerName` читать `settingsOfProvider[providerName]` как динамический транспорт: `{ baseURL, apiKey: cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : '') || 'noop', headers: cfg.headers, queryParams: undefined }`. Заголовки — через `assertHttpHeaderSafe` (как в `newOpenAICompatibleSDK`). Если `baseURL` пуст — вернуть пустой baseURL (существующий guard :843 даст явную ошибку → инвариант PRODUCT 3). Это зеркало уже существующего fallthrough в `newOpenAICompatibleSDK` (`sendLLMMessage.impl.ts ~364`), но для AI-SDK.

**A2. Фолбэк диспатча** — `sendLLMMessage.ts:132-136`.
Если `!implementation` И `settingsOfProvider[providerName]?.baseURL` присутствует (признак динамического транспорта) → использовать `{ sendChat: (p) => sendViaAISdk(p), sendFIM: null, list: null }` вместо ошибки. Встроенные не затрагиваются (для них `implementation` найден — ветка фолбэка не выполняется → инвариант 8). Без baseURL → существующая ошибка остаётся.

После A: динамик идёт по тому же AI-SDK пути, что и агрегаторы — repair-hook, алиасы, models.dev routing, XML-fallback «бесплатно» (PRODUCT 6, 7).

### Фаза B — reasoning/thinking

**B1. Маппинг caps** — `modelEntryToCaps` (`vibeDynamicProvidersService.ts:40-56`), единственная правка фазы:
- `m.extraBody` → `additionalOpenAIPayload` (verbatim pass-through; AI-SDK путь уже спредит его в тело — PRODUCT 14).
- `m.reasoning` (объект) → `reasoningCapabilities`: форму копировать с существующей reasoning-capable openai-compat модели (изучить пример в `modelCapabilities.ts` перед правкой, не выдумывать поля). Маппинг: `reasoning.effort[]` → значения слайдера усилия; `reasoning.canTurnOff` → возможность выключения; `reasoning.thinkTags` → `openSourceThinkTags`/`stripThinkTags` (для моделей, дублирующих CoT в `<think>`). `reasoning: false` → не задавать `reasoningCapabilities` (PRODUCT 12).
- Дефолт высокого усилия для thinking-моделей при незаданном effort (PRODUCT 11) — задать дефолт в маппинге reasoningCapabilities.

Инъекция в запрос (reasoning_effort + extraBody, в т.ч. `thinking:{type:"enabled"}` через extraBody) уже выполняется в `sendViaAISdk:770-780` — **доп. правок ядра не требуется**. Round-trip `reasoning_content` (PRODUCT 13) обеспечивается существующим output-маппингом openai-compat (`:1700-1708`); проверить, что для динамика он активен.

### Фаза C — надёжность под Moonshot (часть to-validate)

**C1. maxOutputTokens** — `aiSdkAdapter.ts`, опции `streamText` (вызов после :1109).
Передавать `maxOutputTokens` из `getReservedOutputTokenSpace(providerName, modelName, {isReasoningEnabled, overridesOfModel})` (`modelCapabilities.ts:2228`) для динамиков/reasoning — против пустого 200 (PRODUCT 15). **To-validate:** влияет ли это на встроенные, идущие через AI-SDK; если да — гейтить (инвариант 8 важнее).

**C2. Нормализация tool-схемы** — новый ЧИСТЫЙ helper `common/vibeToolSchemaNormalize.ts` (порт идеи `kosong/.../kimi-schema.ts`): `derefJsonSchema` (инлайн локальных `$ref`/`$defs`) + проставление недостающего `type` вложенным property (enum/const/structure → type, fallback `string`), сохраняя `anyOf/oneOf/allOf`. Идемпотентно (PRODUCT 16). Применить в `convertToolsToAiSdkToolSet` (`aiSdkAdapter.ts:996`) ТОЛЬКО для динамического/openai-compat пути (gating — см. open question), на встроенных не трогать (PRODUCT 17, 19). **To-validate:** что `@ai-sdk/openai-compatible` уже нормализует — применять только непокрытое.

**C3. tool_call_id ≤64 + санитизация** — симметрично на исходящих сообщениях (assistant `tool_calls` + соответствующие `tool`-результаты), в `convertMessagesToModelMessages` (`aiSdkAdapter.ts`). Чистый helper `sanitizeToolCallId(id, 64)`. **To-validate:** делает ли это AI-SDK/SDK сам; включать только если реально ломается (PRODUCT 18).

**Gating (C2/C3):** решить по факту — всегда на openai-compat динамическом пути vs детект по baseURL/каталогу. По умолчанию склоняемся к «на динамическом openai-compat пути», т.к. это и есть проблемная зона; встроенные не задеваются.

## Testing and validation

- **PRODUCT 1, 2, 6 (отправка + AI-SDK + тулы):** e2e вручную — Kimi K2.7 в `.vibe/providers.json` + ключ в `.vibe/.env`; убедиться: модель отвечает потоково, вызывает встроенный тул (напр. read_file) и MCP-тул.
- **PRODUCT 3, 4 (явные ошибки):** unit/manual — динамик без `baseURL` → ошибка с причиной, не «not recognized»; без ключа во всех источниках → ошибка-подсказка.
- **PRODUCT 8, 9 (НЕ-регрессия) — главный риск:** после A и после C прогнать чат на встроенных (anthropic + openRouter + openAICompatible): ответ, reasoning, tool-call работают как раньше. Проверить в DevTools-логе `aiSdkAdapter`, что для встроенных `sdkNpm`/тело запроса не изменились. `compile-check-ts-native` exit=0 после каждой фазы. `scripts\test.bat` — без новых падений.
- **PRODUCT 3 (приоритет ключа):** покрыт `test/common/vibeEnvFile.test.ts` (парсер `.vibe/.env`); добавить кейс на порядок `apiKeyRef→.vibe/.env→env`, если резолвер вынесен в чистую функцию.
- **PRODUCT 10–14 (reasoning):** unit на `modelEntryToCaps` — `reasoning`→`reasoningCapabilities`, `extraBody`→`additionalOpenAIPayload`, `reasoning:false`→нет caps. e2e: K2.7 показывает блок размышления; `thinking:{type:"enabled"}` уходит в теле (проверить request dump).
- **PRODUCT 15:** e2e — reasoning-модель не возвращает пустой ответ при разумном maxOutputTokens.
- **PRODUCT 16 (идемпотентность нормализатора):** unit на `vibeToolSchemaNormalize` — enum-only без type, `$ref`/`$defs`, `anyOf/oneOf/allOf` сохранены, повтор = один проход.
- **PRODUCT 17, 19 (gating):** unit/manual — схемы встроенных провайдеров идентичны до/после (нормализатор на их пути не вызывается).

## Risks and mitigations

- **Регрессия встроенных (инвариант 8)** — высший риск: правки в общем `aiSdkAdapter`/диспатче. Митигировать узким гейтингом (фолбэк только при `!implementation`; default-ветка резолва только для не-встроенных id; C2/C3 только на динамическом пути) + обязательным прогоном встроенных после A и C.
- **`reasoningCapabilities` форма** — легко задать неверно. Митигировать: копировать с реального примера в `modelCapabilities.ts`, не из головы; unit на маппинг.
- **C2/C3 over-engineering** — AI-SDK может уже покрывать. Митигировать «to-validate»: сначала замер на живом Kimi, код — только под непокрытое.

## Follow-ups

- `fetch: true` авто-список моделей для динамиков.
- UI-поле ключа для динамиков (тогда `apiKeyRef` для них станет полноценным).
- Merge baseURL встроенного для `extends`-провайдера без своего baseURL (PRODUCT 5 снимет ограничение).
- FIM для динамиков (`sendFIM`).
