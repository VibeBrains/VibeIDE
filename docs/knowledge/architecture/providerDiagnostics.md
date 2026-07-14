# Диагностика провайдеров («Проверка провайдеров»)

← [Knowledge Index](../README.md) · связано: [dynamicProviders.md](dynamicProviders.md), [commandsPaletteModal.md](commandsPaletteModal.md), [llmAndContext.md](llmAndContext.md)

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

## [правило] Трейс send-path: всегда включён (лёгкий ринг) + редакция секретов в экспорте

**Контекст:** для отчёта нужны события send-path, но постоянное логирование — шум и риск утечки ключей. Изначальный дизайн «буфер только при открытой модалке» пересмотрен при реализации (Фаза 2, 2026-07-06): залипание случается ДО того, как пользователь открыл модалку — трейс, стартующий с открытия, не застаёт сам инцидент.

**Суть / Применение (как реализовано):**
- **Ринг всегда включён** — `common/llmSendTrace.ts`: module-level буфер на 200 событий, детали ≤200 симв., живёт в main (прецедент always-on — счётчики нормализации в `xmlToolNormalize.ts`); в renderer читается через IPC `getSendTrace`/`clearSendTrace` на LLM-канале. Шума в `vibeLog` нет — трейс отдельный.
- Точки перехвата: `sendLLMMessage.ts` (providers-sync), `sendLLMMessage.impl.ts` (client-cache-hit/miss, clients-reset), `systemCAFetch.ts` (dispatcher-create/reset), `sendLLMMessageChannel.ts` (ipc-send, aborter-set, first-chunk, final, error, abort — с requestId-корреляцией).
- **Секреты не попадают в буфер у источника** (детали = имена провайдеров, счётчики, генерации пула, усечённые ошибки); экспорт дополнительно прогоняет снапшот через `redactSecretsInObject` (defense-in-depth).
- L5 (сквозной тест): кнопка на карточке провайдера, **только по клику** («тратит токены»); сообщения строятся `prepareLLMSimpleMessages` (provider-корректная форма — Anthropic/OpenAI/Gemini различаются), модель = выбранная в чате, иначе первая нескрытая из настроек провайдера; таймаут 30с через `llm.abort(requestId)`. Сигнатура «L1–L4 ok, L5 fail» → инлайн-подсказка «Сбросить клиентов».
- MD-экспорт (untitled `.md` + копия в буфер): слои + колонка L5, latency, **маскированные** источники ключей, число моделей, выбранная модель, и таблица последних событий трейса с **вырезанными** секретами.
- UI — отдельный resizable-React-апп (`react/src/provider-diagnostics-tsx`), новая tsup-точка + ручной `.d.ts`, `@@`-className-футган и `.vibe-scroll` — по образцу `commandsPaletteModal.md`.
