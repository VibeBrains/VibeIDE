# Перевод провайдеров на Vercel AI SDK

← [Knowledge Index](../README.md)

---

## [архитектура] Весь чат идёт через `sendViaAISdk` (завершено 2026-09-23)

**Контекст:** миграция шла стадиями. Стадия 1 (июнь 2026) — семь агрегаторов, стадия 2a — семь прямых облачных провайдеров. Встроенные `anthropic`, `openAI`, `gemini`, `ollama`, `vLLM` и `lmStudio` оставались на старых путях (`sendAnthropicChat`, `sendGeminiChat`, `_sendOpenAICompatibleChat`). Довела перевод находка дайджеста 23.09: старые пути не отдавали `usage` вовсе, и учёт расхода встроенных провайдеров был пуст — вместе с файлами набора, которые патчат встроенных (`anthropic.jsonc`, `openai.jsonc`).

**Суть:**

- **Одна точка чата.** Все провайдеры, встроенные и из файлов `.vibe/providers`, идут через [`sendViaAISdk`](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/aiSdkAdapter.ts). Адреса живут в одном месте — `resolveEndpoint`. Старые пути удалены. Своими клиентами остались только автодополнение (FIM: `openAICompatible`, `openRouter`, `liteLLM`, `lmRoute`, Mistral, Ollama) и список моделей (`vLLM`, `lmStudio`, Ollama).
- **Провод встроенного — свой, а не догадка каталога.** `builtinWireSdkNpm` в `common/modelCapabilities.ts`:
  - `anthropic` — `@ai-sdk/anthropic`;
  - `gemini` — `@ai-sdk/google`;
  - локальные — `@ai-sdk/openai-compatible`;
  - `openAI` — `@ai-sdk/openai` в Chat Completions, а для моделей, которым нужен Responses, `.responses()`. Кому нужен, знает провайдер (`wireProtocolOfModel` — GPT-6), и это может объявить файл, правящий встроенного (`protocol` у модели).
  - Порядок выбора: переопределение пользователя → провод встроенного → протокол из файла → models.dev → совместимый.
- **Рассуждение по проводам** — [`common/wireReasoning.ts`](../../../src/vs/workbench/contrib/vibeide/common/wireReasoning.ts):
  - Claude: `thinking` adaptive с показом (настройка `vibeide.llm.claudeThinkingDisplay`) и уровнем, бюджет для моделей 4.x, `drop_block` для моделей с пометкой `reasoningBoundToModel`. Только для API самого Anthropic: совместимые апстримы (MiniMax, Kimi, MiMo) пишут мышление по-своему.
  - OpenAI: `reasoningEffort`; «выключено» — значением модели (`reasoningOffEffort`, у GPT-6 Sol и Luna `none`), иначе вендор включит своё умолчание.
  - Gemini: `thinkingConfig` — бюджет у 2.5, уровень у 3.x.
- **Подписи рассуждения Claude.** Поток собирает целые блоки (`AnthropicReasoningCollector` в [`common/llmStreamFinish.ts`](../../../src/vs/workbench/contrib/vibeide/common/llmStreamFinish.ts)), и они уходят обратно частями `reasoning` с `providerOptions.anthropic.signature` / `redactedData` — только на проводе Anthropic.
- **Почему модель остановилась.** Отказ классификатора (`content-filter`, категория из `stop_details`) и обрыв по лимиту вывода (`length`) больше не выглядят пустым или законченным ответом: они едут полем `finishNotice`, и чат показывает уведомление. Вызов инструмента из оборванного ответа не выполняется никогда.
- **Таймеры.** Общий потолок теперь ограничивает только молчание до первого содержимого (`timeoutMs.cloud` / `.aggregator` / `.local`). После первого фрагмента ответ идёт, пока текут токены; простой ловит `streamIdle`, и его сбрасывают аргументы вызова инструмента тоже.

**Перенесено со старых путей (иначе было бы хуже, чем до миграции):**

| Что | Было | Стало |
|---|---|---|
| Ключ из переменной окружения ОС | только старые пути; у мигрированных в стадиях 1–2a терялся | `withProcessEnvApiKey` в начале `sendViaAISdk` для всех |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` | читали официальные SDK | читает `resolveEndpoint`; у Anthropic дописывается `/v1`, которого старый клиент в переменной не ждал |
| Повтор без потока для неверифицированной организации OpenAI | `_sendOpenAICompatibleChat` | `generateText` в `catch`, один раз, с теми же параметрами вызова, что у потока (`callOptions`) — иначе повтор терял бы температуру модели, число попыток и починку вызовов |
| Пауза Gemini при 429 | разбор тела в сообщении об ошибке («Rate limit reached…») | `RetryInfo` из тела становится заголовком `retry-after` (`common/googleRetryInfo.ts`). Короткую паузу SDK выдерживает на месте, длинную — пауза чата: 429, перекрашенный в 402, несёт исходный статус заголовком `x-vibe-original-status` и сообщается как лимит, хотя слова Google о лимите не говорят |
| Разбор сетевой ошибки | `describeConnectionError` | [`common/connectionErrorDiagnostics.ts`](../../../src/vs/workbench/contrib/vibeide/common/connectionErrorDiagnostics.ts); ошибка уходит с префиксом `APIConnectionError:`, и слой отправки добавляет подсказку («Ollama не запущен», «перехват TLS») |
| Причуда `anthropicStrictBlocks` | только встроенный Anthropic | любой провод Anthropic |
| Разделитель между текстовыми блоками, метка `[redacted_thinking]` | `sendAnthropicChat` | цикл потока |
| История Gemini | формат `parts` (`GeminiLLMChatMessage`) | блоки в форме Anthropic; `@ai-sdk/google` сам делает `functionCall`/`functionResponse` |

**Сознательно не перенесено:**

- Скрытый повтор «без инструментов» при `does not support tools` — это видимо делает окно: переключает модель на XML-формат и повторяет ход (`chatThreadService`, поиск по `noToolsEndpoint`).
- Первый токен локальной модели за 10 секунд — холодная загрузка модели в память дольше. Потолок теперь `timeoutMs.local` (30 секунд) до первого содержимого.

**Зависимости:** `ai` 6.0.289 и последние патчи `@ai-sdk/*` внутри текущих мажоров — у всех один `@ai-sdk/provider-utils` 4.0.53. `@ai-sdk/anthropic` 3.0.121 нужен ради `display: "updates"` и `blockBinding`. `@google/genai` удалён: им пользовался только старый путь Gemini. `@anthropic-ai/sdk` остаётся — на него ссылается тип в `src/vs/platform/agentHost/node/shared/copilotApiService.ts` апстрима. `openai` остаётся ради автодополнения и списков моделей.

**Проверено:**

- Юнит-тесты: `wireReasoning`, `llmStreamFinish`, `providerWireHelpers`, `builtinModelProfiles`; поле `reasoning.off` файла провайдера — в `providerModelEntryMapping`.
- Интеграционный тест [`test/node/aiSdkAdapter.test.ts`](../../../src/vs/workbench/contrib/vibeide/test/node/aiSdkAdapter.test.ts) против локального сервера с настоящими потоками вендоров, восемь сценариев:
  - Anthropic: запрос, подписи, вызов и расход; отказ; обрыв посреди вызова;
  - GPT-6 через Responses;
  - повтор без потока для организации без верификации — тот же запрос, кроме самого потока;
  - запись в кэш на совместимом проводе;
  - «выключено» рассуждения полем `reasoning.off` на совместимом проводе (MiMo) — только в положении «выключено»;
  - пауза Google.
- Тест лежит в `test/node`, хотя адаптер — `electron-main`: код адаптера — чистый Node, а юнит-раннер Electron грузит тесты в рендерер, где undici не находит внутренностей Node (`markResourceTiming`, `unref` у таймеров). Импорт через слой помечен `eslint-disable` с этим объяснением.
- **Живьём не проверено:** ключей Anthropic, OpenAI и Gemini нет, Ollama на машине нет.

**Применение:**

- Новый провайдер — строка в `AiSdkProviderName`, ветка в `resolveEndpoint` и, если у него свой провод, строка в `builtinWireSdkNpm`. Нового пути отправки не заводить.
- Новое поле запроса вендора — сначала провайдер-опция `@ai-sdk/*`. Поле, которого SDK ещё не знает, — повод поднять версию пакета, а не переписать тело запроса руками.
- Сценарий вендора, который трудно проверить без ключа, — новый поток в `aiSdkAdapter.test.ts`: сервер отдаёт события, тест смотрит, что ушло и что пришло.

**Грабли:**

- **На `max_tokens` SDK всё равно выдаёт `tool-call` для недописанного блока**, а хук починки аргументов «восстанавливает» префикс JSON. Признак обрыва — только причина остановки, а не наличие события. Отсюда правило: при `length` вызов не выполняется никогда.
- **Уровень провайдера в файле набора — умолчание, а не контракт.** У OpenCode Zen в файле `protocol: "openai"`, а Claude он отдаёт через `/messages`. Встроенному передаются только протоколы конкретных моделей и `promptCacheKey` (`common/builtinWireHints.ts`), иначе умолчание файла перебило бы точный выбор каталога.
- **Запасные записи каталога подменяли модель на проводе:**
  - выбран `claude-opus-5-5` — уходил `claude-opus-5`;
  - выбран `claude-sonnet-4-5` — уходил `claude-sonnet-4-20250514`;
  - выбран `gpt-5.5` — уходил `gpt-5`.

  Вдобавок в цепочках побеждало последнее совпадение. Теперь `firstMatchingProfile`: профиль по первому совпадению от частного к общему, имя модели не трогается.
- **Системный промпт в сообщениях** — наш собственный, ради точки кэша Anthropic; `allowSystemInMessages: true`, иначе SDK печатает предупреждение об инъекции на каждый запрос.

**Связано:** [modelQuirks.md](modelQuirks.md), [apiProtocolRouting.md](apiProtocolRouting.md), [toolCalling.md](toolCalling.md), [llmAndContext.md](llmAndContext.md).

---

## [пробел→фикс] AI-SDK путь не отправлял reasoning-control payload (проверено 2026-06-08)

**Контекст:** старый `_sendOpenAICompatibleChat` вычислял `reasoningInfo` (`getSendableReasoningInfo`) и мёржил `providerReasoningIOSettings.input.includeInPayload(reasoningInfo)` в тело запроса (`reasoning_effort`, `thinking:{...}`). `sendViaAISdk` этого не делал.

**Суть:** для всех провайдеров на AI-SDK пути ползунок и тумблер рассуждения были мёртвыми. Фикс: `reasoningInputPayload` считается в адаптере и мёржится в `transformRequestBody` рядом с `additionalOpenAIPayload` — только для совместимого провода. Для остальных проводов тот же выбор с 23.09 идёт провайдер-опциями (см. выше).

**Позднее уточнение (23.09):** у встроенного OpenAI старый путь клал `reasoning_effort` в опции КЛИЕНТА (`new OpenAI({...includeInPayload})`), а не в тело запроса. То есть усилие не доходило и там — до перевода на `providerOptions.openai.reasoningEffort`.
