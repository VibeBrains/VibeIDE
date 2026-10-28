# Claude API версии 2026-10-21: нас не задевает, и по каким причинам

← [Knowledge Index](../README.md)

---

## [факт] Ломающая версия API Anthropic и что она значит для провода `anthropic`

**Контекст:** сводка 28.10.2026 сообщила о версии API `2026-10-21` и предложила сделать запрет сэмплинга общим квирком протокола `anthropic`.
Первоисточник — руководство миграции `platform.claude.com/docs/en/api/migration-2026-10-21` (открыто 28.10.2026, markdown-вариант страницы по суффиксу `.md`).
Изменения действуют, только если запрос несёт `anthropic-version: 2026-10-21`; новые мажорные SDK шлют её сами.

**Суть руководства:**
- `temperature`, `top_p`, `top_k` дают 400 даже при значении по умолчанию; без них запрос сэмплирует с умолчаниями (температура 1.0)
- `document` в сообщении `assistant` и непустые `citations` на `text` в сообщении `user` — 400
- SDK и CLI шлют ключ как `Authorization: Bearer`, а не `X-Api-Key`; сам API принимает оба заголовка
- Из SDK убраны Text Completions и клиентская компакция в tool runner (TypeScript SDK 1.0.0, Python 2.0.0)

**Почему нас не задевает (сверено с кодом `next` 28.10.2026):**
- Чат Anthropic идёт через `@ai-sdk/anthropic` 3.0.135: версия `2023-06-01` зашита в пакете, ключ уходит `x-api-key`, `Authorization: Bearer` пакет ставит только при заданном `authToken`
- Запрос каталога моделей добавляет `anthropic-version: 2023-06-01`, если файл провайдера своей не объявил (`vibeProvidersFile.ts`, `catalogRequestOf`)
- Сэмплинг для Claude не уходит: правила `claude-*` в `resources/model-quirks.json` не задают `temperature`, `topP`, `topK`, а профили Claude в `modelCapabilities.ts` не несут `defaultTemperature` (поле есть только в типе)
- Параметры собирает `aiSdkAdapter.ts` (блок `modelParams`) из `default*` провайдера и правил каталога, поэтому общий запрет для провода `anthropic` ничего не убрал бы: сторонние маршруты (Kimi Code, MiniMax) получают температуру 1.0 по своим правилам каталога, к Anthropic это не относится
- Ключ размещает `keyPlacement`: для провода `anthropic` по умолчанию `x-api-key`, а `auth: bearer` в файле провайдера даёт `Authorization: Bearer`; ничего нового в поле файла не нужно
- Прямой `@anthropic-ai/sdk` (`package.json`, `^0.92.0`) в коде `src/vs/workbench/contrib/vibeide/` не импортируется

**Применение:** когда поднимаешь `@ai-sdk/anthropic` на мажор, который шлёт `2026-10-21`, проверить две вещи.
Первая: `defaultTemperature`, `defaultTopP`, `defaultTopK` из файла провайдера для Claude-модели начнут давать 400, и тогда общий отказ от сэмплинга для Claude оправдан.
Вторая: прокси или шлюз, читающий только `X-Api-Key`, перестанет видеть ключ, если пакет перейдёт на Bearer.
Пока пакет шлёт `2023-06-01`, правок не нужно.

**Связано:** [DIGEST-1028 в roadmap](../../roadmap.md), [providerApiKeyFromEnv.md](providerApiKeyFromEnv.md)
