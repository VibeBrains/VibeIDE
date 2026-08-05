# Ключ провайдера из окружения ОС + тупик подписочного OAuth Anthropic

← [Knowledge Index](../README.md)

---

## [архитектура] Env-ключ провайдера — почему одного резолва в electron-main мало

**Контекст:** 2026-07-22, ветка `next`. Задача звучала как однострочная — «подставлять `ANTHROPIC_API_KEY` из окружения, если ключ не введён в настройках». Наивная реализация (подстановка в `sendAnthropicChat`) выглядит достаточной и молча не работает.

**Суть:** ключ участвует в ДВУХ независимых местах, и они живут в разных процессах.

1. **Транспорт** — `electron-main`, `sendLLMMessage.impl.ts`: реальный `apiKey` уходит в SDK-клиент. Здесь `process.env` надёжен.
2. **Гейтинг UI** — `computeDidFillInProviderSettings` в [vibeideSettingsService.ts:178](../../../src/vs/workbench/contrib/vibeide/common/vibeideSettingsService.ts#L178), считается в renderer из сохранённых настроек. Флаг `_didFillInProviderSettings` решает, показывать ли провайдера, его модели и давать ли выбрать его в чате (потребители: `Settings.tsx`, `chatThreadService`, `resolveAutoModelSelection`).

Если сделать только (1), провайдер аутентифицируется, но остаётся **невидимым**: моделей нет, выбрать нечего, ключ бесполезен. Классическое полурешение, которое проходит компиляцию и тесты.

Решение — **пробрасывать только ФАКТ наличия ключа**, не значение:

- `apiKeyEnvVarOfProvider` (common) — карта провайдер → каноническое имя переменной. Значение НИКОГДА не в renderer.
- `vibeEnvApiKeysContribution` (electron-browser) — читает `IShellEnvironmentService.getShellEnv()`, собирает набор провайдеров с ключом, зовёт `applyEnvApiKeyProviders(set)`.
- `computeDidFillInProviderSettings` — считает env-ключ заполненным полем.
- `withEnvApiKey` (common, чистая, env параметром) + `withProcessEnvApiKey` (electron-main, подставляет `process.env`).

**Почему `getShellEnv()`, а не `process.env` в renderer:** резолвит окружение login-shell — ключ из `~/.zshrc` виден, даже когда приложение запущено из Finder/Dock, а не из терминала. Тот же источник использует терминал и extension host.

**Применение:**

- В карту `apiKeyEnvVarOfProvider` можно добавлять ТОЛЬКО провайдеров, у которых `apiKey` — единственное обязательное поле. У `liteLLM`/`lmRoute` есть `endpoint`, у `microsoftAzure` — `project`, у `awsBedrock` — `region`: env-ключ их всё равно не разблокирует, потому что `computeDidFillInProviderSettings` требует непустыми ВСЕ поля. Это гейтится тестом `providerEnvApiKey.test.ts` («every listed provider has apiKey as its only required setting»).
- Имена переменных не выдумывать. Провайдеры без устоявшегося канона (`openCodeZen`, `openCodeGo`, `pollinations`) в карту не добавлены намеренно.
- Значение env всегда `trim()` — шеллы и CI оставляют хвостовой перевод строки, который всплывёт много позже как невнятная ошибка HTTP-заголовка (ровно тот класс, что ловит `assertHttpHeaderSafe`).

**Антипаттерны:**

- Копировать значение env-ключа в зашифрованный стор настроек при старте. Выглядит проще (ни одной правки в гейтинге), но: секрет размножается, ротация переменной перестаёт влиять, ключ становится виден в поле настроек. Отвергнуто осознанно.
- Складывать env-факты в `applyProviderActiveOverrides` — у этого канала уже есть владелец (`.vibe/providers.json`, `vibeDynamicProvidersService`), два писателя затирали бы друг друга. Заведён отдельный метод.

---

## [квирк] 2026-07-22 — подписочный OAuth-токен Anthropic: рабочий, но закрытый ToS

**Контекст:** проверялось, можно ли дать пользователю ходить в Claude по лимитам подписки Pro/Max вместо оплаты по токенам API. Разведка + два живых смоука на реальном токене от `claude setup-token`.

**Суть (всё — факты живых прогонов, не документация):**

- Токен от `claude setup-token` (`sk-ant-oat01-…`) **работает** на прямом `api.anthropic.com` через `Authorization: Bearer`. `@anthropic-ai/sdk` поддерживает это опцией `authToken` (client.d.ts) — Agent SDK для этого не нужен.
- Как `x-api-key` тот же токен даёт `401 invalid x-api-key` — то есть только Bearer.
- Заголовок `anthropic-beta: oauth-2025-04-20` **необязателен** — запрос проходит и без него.
- **Главное:** API проверяет системный промпт. `200` приходит, только когда первый системный блок **дословно** равен преамбуле Claude Code (`You are Claude Code, Anthropic's official CLI for Claude.`). Свой system-промпт, отсутствие system, и даже склейка «преамбула + свой текст ОДНОЙ строкой» — отклоняются. Массив блоков, где первый = ровно преамбула, а второй свой, проходит.
- **Отказ маскируется под `429 rate_limit_error`**, а не `401`/`403`. Отличить троттлинг от отказа удалось только изолированными прогонами с паузами 20–60 с: между падающими вариантами валидные проходили с `200` на том же токене.

**Применение:** не реализовывать. Чтобы это работало, VibeIDE должен выдавать себя за Claude Code, обходя проверку, поставленную ровно против этого. Поверх лежит прямой запрет в Commercial ToS: Anthropic не разрешает сторонним разработчикам предлагать claude.ai-логин или лимиты подписок в своих продуктах, включая построенное на Agent SDK. Риск — бан аккаунтов пользователей и мгновенная поломка при любом изменении на стороне Anthropic.

Легальные пути для Claude в VibeIDE: **API-ключ** (текущий, по токенам; теперь ещё и из `ANTHROPIC_API_KEY`) либо локальные модели. Если пользователь хочет свою подписку — он использует Claude Code отдельно, вне IDE.

**Связано:** [[apiProtocolRouting]], [[dynamicProviders]], [[providerDiagnostics]]

---

## [исследование] 2026-08-05 — тупик ОБОЙДЁН: Zed не подключает подписку, а запускает официальный клиент (ACP)

**Заказ владельца:** «как Zed подключает подписку Claude — применимо ли то же у нас». Ответ переоткрывает тему, закрытую 22.07, потому что вопрос там стоял иначе.

**Что делает Zed — фактами:**
- Подписку он **не подключает вовсе**. Официальный Claude Code запускается как **отдельный процесс**, Zed даёт только UI и общается с ним по **ACP** (Agent Client Protocol) — JSON-RPC поверх stdio, по образцу LSP ([zed.dev/docs/ai/external-agents](https://zed.dev/docs/ai/external-agents)).
- **«External Agent owns its own runtime, auth, model selection, tools»**, а «Zed does not charge for External Agents» — авторизация целиком внутри агента: пользователь делает `/login` в его сессии и выбирает API-ключ либо Claude Code. Токен Zed не видит и не пересылает.
- **Особого соглашения с Anthropic нет** — в разборе Zed о нём ни слова, механизм общий для всех ACP-клиентов ([zed.dev/blog/anthropic-subscription-changes](https://zed.dev/blog/anthropic-subscription-changes)).

**Почему это законно, а наш прошлый заход — нет.** Запрет ToS (февраль 2026, ужесточён баном 4 апреля) касается **использования OAuth-токенов подписки в стороннем продукте**: «OAuth токены из Free/Pro/Max во всех контекстах вне Claude Code и Claude.ai» ([alternativeto](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)). Мы 22.07 пытались ходить токеном САМИ — это и есть запрещённое. При ACP токен остаётся внутри официального клиента Anthropic; сторонний редактор к нему не прикасается.

**Критично для решения — биллинг:** разделение 15.06 (Agent SDK credit $20/$100/$200) **приостановлено в день вступления в силу**. `claude -p`, Agent SDK и сторонние приложения **продолжают тянуть из подписки Pro/Max/Team/Enterprise как раньше**, лимиты не изменились; Anthropic перерабатывает план и обещает предупредить заранее ([The New Stack](https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/)). То есть механизм работает **прямо сейчас**, а не гипотетически.

**Трудоёмкость ниже ожидаемой:** протокол открытый, есть официальный TypeScript SDK `@agentclientprotocol/sdk` (v0.12.0) с готовой клиентской стороной — `client({name})`, хендлеры `requestPermission`/`sessionUpdate`, `connectWith(stream, …)`, плюс примеры клиентов в репозитории ([agentclientprotocol.com/libraries/typescript](https://agentclientprotocol.com/libraries/typescript)). Писать протокол с нуля не нужно.

**Побочная выгода, которая может оказаться главной:** ACP — не про Claude. Реализовав клиента ОДИН раз, VibeIDE получает **любого ACP-агента**: Claude Code, Gemini CLI, Codex и всё из реестра ACP (Zed и JetBrains ведут его совместно с января 2026). Это не «ещё один провайдер», а второй класс интеграции рядом с BYOK.

**Чего это НЕ отменяет:** запись выше про подписочный OAuth остаётся в силе — ходить токеном самим по-прежнему нельзя. ACP не обход запрета, а другая архитектура: мы не клиент API, мы хост чужого агента.
