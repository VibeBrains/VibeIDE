# Диагностика провайдеров («Проверка провайдеров»)

← [Knowledge Index](../README.md) · связано: [dynamic-providers.md](dynamic-providers.md), [commands-palette-modal.md](commands-palette-modal.md), [llm-and-context.md](llm-and-context.md)

Модалка диагностики связи до LLM-провайдеров: пункт brain-меню под «VibeIDE Команды», команда `vibeide.commands.checkProviders`. Цель — понять, провайдер недоступен или запросы не уходят из-за состояния внутри VibeIDE, и отдать отчёт в Markdown.

---

## [баг] Стейл-кэш SDK-клиентов → «токены не уходят до перезапуска IDE»

**Контекст:** пользователь видел, что в какой-то момент запросы к моделям перестают уходить (токены не приходят). Смена провайдера/модели не помогала — **помогал только перезапуск всего VibeIDE** (2026-06).

**Суть:** причина зависит от типа провайдера — две разные ветки, обе на уровне модуля в main, обе живут до перезапуска процесса.

**(A) Облачные провайдеры (кейс пользователя: «менял провайдеров — помог только рестарт»).** Все облачные запросы через AI SDK идут через **один process-wide undici-диспетчер**:

```
electron-main/llmMessage/systemCAFetch.ts    ensureSystemCADispatcher() — мемоизирует _dispatcher (undici Agent)
electron-main/llmMessage/aiSdkAdapter.ts:81  const sharedDispatcher = ensureSystemCADispatcher()  // захват в module-const при загрузке
                                  :98  customFetch → undiciFetch(..., { dispatcher: sharedDispatcher })
```

Диспетчер общий для ВСЕХ облачных провайдеров. Если пул keep-alive соединений заклинит (зависшие сокеты, VPN/прокси-икота, TLS) — токены перестают идти у всех провайдеров разом, и `setGlobalDispatcher` не помогает, т.к. `customFetch` держит **захваченную** ссылку `sharedDispatcher`. Только новый процесс = новый Agent. Это объясняет «разные провайдеры не помогали».

**(B) Локальные провайдеры (ollama / vLLM / lmStudio / localhost).** Кэши SDK-клиентов, которые **никогда не инвалидируются** (облачные клиенты НЕ кэшируются — создаются заново каждый запрос, гейт `isLocalProvider` в `getOpenAICompatibleClient`):

```
electron-main/llmMessage/sendLLMMessage.impl.ts  L42 openAIClientCache  L48 ollamaClientCache
```

Ollama-кэш ключуется **только по endpoint** → смена прочего конфига не сбрасывает клиент. `_externalProviders` (`common/modelCapabilities.ts`) ресинкается только внутри `sendLLMMessage()`.

Новый процесс (перезапуск IDE) = свежий dispatcher + свежие кэши = «заработало». Отсюда симптом «лечит только перезапуск».

**Применение:**
- Мгновенный фикс — кнопка **«Сбросить клиентов провайдера»**: новый IPC в electron-main (1) чистит `openAIClientCache`/`ollamaClientCache`, (2) **пересоздаёт shared dispatcher** (`resetSystemCADispatcher`: закрыть старый Agent → новый → `setGlobalDispatcher`), (3) форсит ресинк `_externalProviders`. **Условие для (2):** `aiSdkAdapter.customFetch` должен резолвить диспетчер **в момент запроса** (`ensureSystemCADispatcher()` внутри `customFetch`), а не держать module-const — иначе сброс не виден.
- Durable-фикс (отдельный пункт роадмапа): кэши клиентов — инвалидировать при изменении `settingsOfProvider`/`.vibe/providers.json`; dispatcher — health/recreate при подозрении на залипший пул. Кнопка остаётся safety-net.
- **Важно для диагностики:** probe каталога (L2–L4) идёт через ОТДЕЛЬНЫЙ канал `vibeide-channel-remoteCatalogFetch` (свой fetch, мимо `sharedDispatcher` и кэшей). Поэтому probe бывает зелёным, а реальная отправка — мёртвой. Ловит расхождение только L5 (сквозной тест через настоящий `sendLLMMessage`).

---

## [архитектура] Послойная модель проверки (L1–L5)

**Контекст:** «один пинг» не отличает «провайдер лежит» от «ключ протух» от «запрос не уходит изнутри IDE». Нужны независимые слои со своим статус-чипом.

**Суть:**

| Слой | Что проверяет | Источник |
|---|---|---|
| L1 Конфиг | провайдер резолвится, baseURL/протокол/auth, источник ключа | `IVibeDynamicProvidersService.getState()` + built-in `settingsOfProvider` |
| L2 Сеть | DNS/TLS/доступность baseURL (connect-fail ≠ auth) | probe `<baseURL>/v1/models` |
| L3 Авторизация | 200 vs 401/403 | `IRemoteCatalogService.fetchDynamicWithStatus` → `{status:'ok'|'unauthorized'|'error'}` |
| L4 Модели | каталог не пуст, выбранная модель в списке, latency | тот же fetch |
| L5 Реальный токен (Фаза 2, opt-in) | сквозная отправка через боевой `sendLLMMessage` | новый diag-канал; «тратит токены» |

**Применение:**
- «Активный провайдер» = резолвится API-ключ. Источники (приоритет ↓): GUI (`dynamicProviderApiKeys[id]`) → `apiKeyRef` (secure settings другого провайдера) → `apiKeyEnv` (из `.vibe/.env`, читается в main). Встроенные — `settingsOfProvider[name]._didFillInProviderSettings`.
- Enumerate: `IVibeDynamicProvidersService.getState().providers` + встроенные из settings.
- Connectivity: `IRemoteCatalogService.fetchDynamicWithStatus(baseURL, apiKey, modelsUrl?)` (динамические) / `fetchCatalog(providerName, forceRefresh)` (встроенные).
- Процессные границы: все сетевые вызовы — в electron-main через каналы; `apiKeyEnv` резолвится `process.env[name]` в main и НЕ покидает его → в UI/экспорт уходит только источник, не секрет.

---

## [правило] Диаг-режим: логи только при открытой модалке + редактирование секретов в экспорте

**Контекст:** для отчёта нужны события send-path, но постоянное логирование — шум и риск утечки ключей.

**Суть / Применение:**
- Кольцевой буфер включается на время открытой модалки; точки перехвата (наметка): `sendLLMMessage.ts:58` (sync провайдеров), `sendLLMMessage.impl.ts:106-110/133-135` (cache hit/miss), `sendLLMMessageChannel.ts:98` (установка abortRef), `sendLLMMessageService.ts:299` (IPC-send), first-token / ошибки / таймауты.
- MD-экспорт (untitled `.md` + копия в буфер): слои, latency, **маскированные** источники ключей, число моделей, выбранная модель, версия/OS/app, и в диаг-режиме — последние события буфера с **вырезанными** секретами.
- UI — отдельный resizable-React-апп (`react/src/provider-diagnostics-tsx`), новая tsup-точка + ручной `.d.ts`, `@@`-className-футган и `.vibe-scroll` — по образцу `commands-palette-modal.md`.
