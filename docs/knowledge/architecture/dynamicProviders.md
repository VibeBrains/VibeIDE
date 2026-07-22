# Динамические провайдеры — `providers.json` (глобальный + workspace)

← [Knowledge Index](../README.md)

---

## [архитектура] 2026-07-22 — волна «равные права»: конфиг-провайдеры = встроенные

**Контекст:** директива владельца — «провайдеры из конфигов не должны быть обделены правами; всё, что ложится на провайдера, идёт по смерженному массиву». До волны конфиг-провайдер был вторым сортом: не участвовал в авто-выборе модели, жил только в workspace-папке, ключ из OS-env не разблокировал его в UI, а типизация (`ProviderName` = compile-time union встроенных) заставляла каждый шов кастовать `as unknown as string`.

**Суть — пять решений:**

1. **`ProviderId = string`** ([vibeideSettingsTypes.ts](../../../src/vs/workbench/contrib/vibeide/common/vibeideSettingsTypes.ts)) — runtime-идентификатор смерженного набора; `ProviderName` остался только ключом таблиц встроенных дефолтов. Гард `isBuiltinProviderId` сужает там, где нужен typed-доступ. `SettingsOfProvider` — интерсекция мапы встроенных с `[id: ProviderId]: AnyProviderSettings`, поэтому индексация конфиг-id легальна без кастов.
2. **`autoFallbackProviderIds(settingsOfProvider)`** — единый порядок авто-выбора: конфиг-провайдеры ПЕРВЫМИ (симметрично их месту в пикере — это явная конфигурация пользователя), затем `autoModelFallbackProviderOrder`. Все 5 потребителей переведены; новые обходы провайдеров обязаны использовать его, не сырой встроенный список.
3. **Глобальный `~/.vibe/providers.json` (+ `~/.vibe/.env`)** — равноправие в области действия. Мерж — чистая `mergeProvidersLists` (workspace перекрывает по полям через `mergeProviderEntry`, модели по id, уцелевший `extends` сохраняется — [vibeProvidersFile.ts](../../../src/vs/workbench/contrib/vibeide/common/vibeProvidersFile.ts)). Глобальная папка — correlated-вотчер (вне workspace её никто не следит), `~` через `IPathService.userHome()`.
4. **Кэш + перечитывание** — смерженный набор в сторе приложения (`VIBE_CONFIG_PROVIDERS_CACHE_KEY`, MACHINE-target), восстанавливается синхронно при старте: провайдеры видны до дочитывания файлов и в окне без папки. Каждое чтение перезаписывает кэш → реконсиляция призраков; UI-ключ (`dynamicProviderApiKeys`) и тумблеры (`dynamicModelHidden`) живут отдельно и переживают удаление/возвращение id. Сломанный workspace-файл не гасит глобальных провайдеров (парсинг посторонний); «всё сломано» держит последний рабочий набор до починки.
5. **OS-env ключи для конфиг-провайдеров** — `vibeEnvApiKeysContribution` проверяет объявленную `apiKeyEnv`-переменную каждого активного конфиг-провайдера в login-shell окружении и шлёт в renderer ФАКТ наличия; сервис гейтит: ключ только в OS-env → `keyStatus 'unverified'` + статические модели доступны. Раньше транспорт работал, а UI считал провайдера мёртвым.

**Гоча split-brain, из-за которой вырезание в `_storeState` ОСТАВЛЕНО:** сиды конфиг-провайдеров в `settingsOfProvider` — derived (пересобираются из кэша+файлов на каждый старт). Персистить их ещё и в блоб настроек = два источника правды и воскрешение призраков. Всё пользовательское персистится в своих местах: определения — кэш сервиса, ключ — side-map, тумблеры — side-map. Это не поражение в правах, а разделение владения.

**Антипаттерны:**
- Новая итерация по `providerNames` там, где смысл — «все активные провайдеры». Правильно: `autoFallbackProviderIds` / ключи `settingsOfProvider` / `allProviderEntries`.
- Типизировать новый API `ProviderName`-ом «потому что так было» — так разделение отрастёт заново.

**Связано:** [[providerApiKeyFromEnv]], [[apiProtocolRouting]]

---

## [архитектура] User-defined LLM-провайдеры без пересборки (WIP)

**Контекст:** 2026-06-12. Цель — пользователь добавляет/переопределяет/выключает LLM-провайдеров и модели через `.vibe/providers.json` (JSONC), без правки кода и пересборки. Препятствие: `ProviderName = keyof typeof defaultProviderSettings` — **compile-time union**, пронизывающий выбор моделей, capabilities, транспорт, каталог, UI.

**Формат (утверждён, см. `common/vibeProvidersFile.ts` — типы = канон схемы):**
- JSONC; секреты вне файла (`apiKeyEnv` / `apiKeyRef`).
- `active:true|false` на провайдере и модели.
- Совпадение `id` со встроенным → **патч** built-in; новый `id` → новый провайдер; `extends:"<id>"` → клон.
- Слияние моделей по `id`. Подробные рецепты — в корневом `README.md` («Свои провайдеры»).

### Готово (Фаза 1, закоммичено)
- `common/vibeProvidersFile.ts` — типы + JSONC-парсер + `mergeProviderEntry` (override-wins + models-by-id) + тест.
- `browser/vibeProvidersSchemaContribution.ts` — JSON Schema (IntelliSense) + `files.associations`→`jsonc` + `json.schemas` (как defaults).
- `browser/vibeDynamicProvidersService.ts` — чтение/резолв файла, watch, классификация `definition`/`override`/`extends-builtin`, логи `vibeLog 'DynProviders'`. **Eager**-singleton.
- `browser/vibeProvidersDiagnosticContribution.ts` — команда «Показать распознанные провайдеры» (дамп: что распарсилось/во что резолвнулось/warnings).
- `.vibe-defaults/providers.example.jsonc` — самодокументирующийся пример (засевается).
- **2b-1:** `vibeideSettingsService.applyProviderActiveOverrides` + фильтр в `_validatedModelState` → `active:false` у built-in **прячет** провайдера/модель из выбора. Чисто (без файла — поведение не меняется).

### 2b-2 — динамические провайдеры РЕАЛЬНО работают

- **A. Список — ГОТОВО** (typecheck exit=0). `applyProviderActiveOverrides({…, dynamicModelOptions})` инжектит модели динамиков в `_modelOptions` (`providerName` как `as any`). Overlay — module-level holder `_providerActiveOverrides`, БЕЗ `_storeState` (derived, не персистится).
- **B. Capabilities — ГОТОВО** (typecheck exit=0). `setDynamicProviderModelCaps(capsMap)` + `modelEntryToCaps()`; `getModelCapabilities` guard отдаёт caps для динамического id из holder `_dynamicProviderModelCaps`.
- **C. Транспорт — КОД ГОТОВ (typecheck exit=0, layers — без новых нарушений). ← E2E-проверка в dev ещё не прогнана.** Реализовано по чек-листу ниже: overlay `transportConfigs` едет через `applyProviderActiveOverrides` → `getDynamicTransportConfigs()` → транзиентный merge в `settingsOfProvider` на send-site → fallthrough в `newOpenAICompatibleSDK` (electron-main) маршрутизирует динамический `providerName` как openai-compatible (`apiKeyEnv` резолвится в main через `process.env`, `apiKeyRef` — в рендерере; headers через `assertHttpHeaderSafe`). `baseURL` обязателен — extends-builtin без явного baseURL пока не маршрутизируется (merge built-in baseURL — follow-up). Осталось: `npm run compile` + `run-dev.bat`, создать `.vibe/providers.json` с реальным провайдером (OpenRouter `apiKeyEnv`), проверить дропдаун + реальный ответ.

#### Чек-лист шага C (overlay едет в `settingsOfProvider` по существующему IPC-пути, новый канал НЕ нужен)

Ключевой ограничитель слоёв: `common/sendLLMMessageService.ts` (send-site) **не может** импортировать `IVibeDynamicProvidersService` (он в `browser/`). Поэтому transport-конфиг течёт через **общий settings-overlay**, который browser-сервис уже толкает в common (`applyProviderActiveOverrides`). Расширяем этот overlay.

1. **`common/vibeideSettingsService.ts`**
   - Добавить `export interface DynProviderTransportConfig { baseURL: string; headers?: Record<string,string>; apiKey?: string; apiKeyEnv?: string }`.
   - Расширить `VibeProviderActiveOverrides` полем `transportConfigs?: Record<string, DynProviderTransportConfig>`.
   - В интерфейс `IVibeideSettingsService` + impl: `getDynamicTransportConfigs(): Record<string, DynProviderTransportConfig>` → `return _providerActiveOverrides?.transportConfigs ?? {}`. (Чистый геттер holder'а, не трогает persisted state.)

2. **`browser/vibeDynamicProvidersService.ts`** → `_applyOverridesToSettings` (строки ~211–242, ветка definition/extends-builtin)
   - Собрать `transportConfigs: Record<string, DynProviderTransportConfig>` для активных definition/extends-builtin:
     - `baseURL = p.entry.baseURL` → **если нет — skip** (extends-builtin без явного baseURL = пока не маршрутизируем; merge built-in baseURL — follow-up).
     - `apiKey` из `apiKeyRef`: `this._settingsService.state.settingsOfProvider[p.entry.apiKeyRef]?.apiKey` (резолв ref — в рендерере).
     - `apiKeyEnv: p.entry.apiKeyEnv` — **имя** прокидываем как есть (env читается в electron-main).
     - `headers: p.entry.headers`.
   - Добавить `transportConfigs` в объект `overrides` (и в условие «overrides не undefined» учесть непустой transportConfigs).

3. **`common/sendLLMMessageService.ts`** (send-site — стр. 223 читает, стр. 291 `this.channel.call('sendLLMMessage', {…, settingsOfProvider, …})`)
   - Транзиентный merge: `const settingsOfProvider = { ...state.settingsOfProvider, ...this.vibeideSettingsService.getDynamicTransportConfigs() } as <тип SettingsOfProvider или as any>`. Передать этот merged в `channel.call`. **Не персистится** — локальная копия на отправку. (FIM-путь — позже, по аналогии при необходимости.)

4. **`electron-main/llmMessage/sendLLMMessage.impl.ts`** — фабрика `newOpenAICompatibleSDK`, **стр. 364** `else throw new Error(\`VibeIDE providerName was invalid: ${providerName}.\`)`
   - Заменить на fallthrough:
     ```ts
     else {
         const cfg = settingsOfProvider[providerName] as unknown as { baseURL?: string; headers?: Record<string,string>; apiKey?: string; apiKeyEnv?: string }
         if (cfg && typeof cfg.baseURL === 'string' && cfg.baseURL) {
             const apiKey = cfg.apiKey || (cfg.apiKeyEnv ? (process.env[cfg.apiKeyEnv] ?? '') : '') || 'noop'
             const headers = (cfg.headers && typeof cfg.headers === 'object') ? cfg.headers : undefined
             if (headers) {
                 for (const [hName, hValue] of Object.entries(headers)) {
                     assertHttpHeaderSafe(`Dynamic provider "${providerName}" header name "${hName}"`, hName)
                     if (typeof hValue === 'string') { assertHttpHeaderSafe(`Dynamic provider "${providerName}" header "${hName}" value`, hValue) }
                 }
             }
             return new OpenAI({ baseURL: cfg.baseURL, apiKey, defaultHeaders: headers, ...commonPayloadOpts })
         }
         throw new Error(`VibeIDE providerName was invalid: ${providerName}.`)
     }
     ```
   - `assertHttpHeaderSafe` уже в файле (исп. на стр. 338). `process.env` в electron-main доступен. `apiKeyEnv` резолвится ИМЕННО здесь.

5. **После правок:** `npm run compile-check-ts-native` (ждём exit=0) → затем `npm run compile` (~4.5 мин) + `run-dev.bat` для e2e: создать `.vibe/providers.json` с реальным провайдером (напр. OpenRouter с `apiKeyEnv`), проверить что модель появляется в дропдауне И реально отвечает.

**Маршрут ключа (важно):** `apiKeyRef` → резолв в рендерере (есть `settingsOfProvider[ref].apiKey`); `apiKeyEnv` → резолв в electron-main (`process.env`, надёжно). В файле `.vibe/providers.json` секрета НЕТ никогда.

**⚠ Риск (учтён):** `settingsOfProvider` персистится (`_storeState`), динамику персистить нельзя. Поэтому overlay — отдельный holder, merge в `settingsOfProvider` делается **только** транзиентно на send-site (п.3), в persisted state не попадает.

## [архитектура] Единый реестр провайдеров — CANONICAL (заменил overlay-caps путь выше)

**Контекст:** 2026-06-14 (v1.2.0). Динамики сперва шли ОТДЕЛЬНОЙ обеднённой веткой (overlay `dynamicModelOptions` + `_dynamicProviderModelCaps` + ветка в `getModelCapabilities` + `remoteModelToCaps`). Итог — whack-a-mole: каждую капу (tool-format, vision, reasoning) переоткрывали руками и ловили по одной (MiniMax-M3: нет тулов → не видит `vibe_complete`; нет vision → тост; утечка сырых `<think>`). Переписано на ЕДИНЫЙ путь.

**Суть (текущая правда):**
- `common/modelCapabilities.ts` — рантайм-реестр: `resolveProvider(id) → { info, source }`, `setExternalProviders(descriptors)`, `allProviderEntries()`. Built-in сидируются из `modelSettingsOfProvider`; динамики **регистрируются** как openai-compatible (`info.modelOptionsFallback = aggregatorOpenAIFallback`).
- `getModelCapabilities` / `getProviderCapabilities` резолвят ЛЮБОГО провайдера через `resolveProvider` — **без ветки для динамиков**. Капы динамика приходят из той же базы знаний по ИМЕНИ модели (`extensiveModelOptionsFallback`: claude/gpt/gemini/qwen/deepseek/llama/grok/**minimax**…) → vision/reasoning/tool-format/context «бесплатно».
- Файловый `static` → `modelCapOverrides` (per-model partial caps поверх распознанного baseline), строит `vibeDynamicProvidersService` через `modelEntryToCaps`.
- УДАЛЕНО: `_dynamicProviderModelCaps`/`setDynamicProviderModelCaps`, `remoteModelToCaps`, ветка в `getModelCapabilities`, fallback-хак `getProviderCapabilities`. (Разделы «2b-2 A/B» выше — историческое описание снятого подхода.)

**⚠ GOTCHA (корень «тулы/vision не доезжали до модели»):** `getModelCapabilities` зовётся в ДВУХ процессах — рендерер (UI/пикер) И electron-main (send-path, `aiSdkAdapter`). Реестр — module-state, заполняется в РЕНДЕРЕРЕ и границу процесса НЕ пересекает → в main реестр пустой → у динамика нет `specialToolFormat` → тулы не шлются. Фикс: `DynamicProviderSeed.modelCapOverrides` едет в `settingsOfProvider` (он и так пересекает границу per-request), а `sendLLMMessage` (main) зовёт `setExternalProviders` из него ДО любого `getModelCapabilities`.

**Урок:** для динамиков НЕ плодить параллельный путь — гнать через общий реестр+распознавание. Добавить семейство в `extensiveModelOptionsFallback` — польза ВСЕМ openai-compat (и openRouter, и динамику). Любой capability-гейт (vision: `visionModelHelper`/`imageQAIntegration`; tool-format в `aiSdkAdapter`) обязан спрашивать `getModelCapabilities`, а не свою эвристику-набор провайдеров (именно отдельная vision-эвристика и держала тост у динамика).

**Применение:** провайдер распознаваемого семейства работает из коробки; неизвестная модель → openai-style дефолт + per-model override (тоггл vision в «Модели» / `static` в файле). Каталог `/v1/models` отдаёт только id (не капы) — vision/reasoning из базы знаний или override.

## [convention] JSONC-комментарии в `.vibe/*`-примерах — один пробел, без выравнивания

**Контекст:** 2026-06-13, обратная связь автора по `providers.json`.
**Суть:** Трейлинг-комментарий отбивается от значения **одним пробелом**: `"order": 10, // …`. НЕ выравнивать столбцом пробелами (`"order": 10,            // …`) — выравнивание ломается при любой правке и даёт шумные диффы. Касается всех наших JSONC (`providers.json`, `commands.json`, …). Исключение — намеренные таблицы внутри блочных комментариев (шпаргалка id), там колоночное выравнивание оставляем.
**Применение:** так писать во всех генерируемых/примерных JSONC; существующие приводить к стилю при касании.

## [operational] После правки `.vibe/providers.json` — перезапустить VibeIDE

**Контекст:** 2026-06-13. Неочевидно для пользователя.
**Суть:** Изменения провайдеров надёжно подхватываются только после рестарта; ключи из `apiKeyEnv` читаются в electron-main из `process.env` **только при старте процесса** — новая переменная окружения без перезапуска не видна.
**Применение:** написано в шапке `providers.example.jsonc`; упоминать при выдаче готового файла пользователю.

## [архитектура] `.vibe/.env` — локальный источник ключа для `apiKeyEnv`

**Контекст:** 2026-06-13. OS-переменные требуют рестарта и неудобны; `apiKeyRef` для нового динамического id некуда сохранить (нет UI-слота).
**Суть:** `apiKeyEnv` теперь резолвится так (приоритет ↓): `apiKeyRef` (secure settings) → **`.vibe/.env`** (строка `ИМЯ=значение`) → `process.env` (фолбэк в electron-main). `.vibe/.env` парсится в `browser/vibeDynamicProvidersService` (`common/vibeEnvFile.ts`, pure+тест), значение кладётся в транзиентный `transportConfigs.apiKey` — тем же путём, что `apiKeyRef` (в persisted state и в файл не попадает). Сервис вотчит `.vibe/.env` → смена ключа подхватывается **без рестарта** (в отличие от OS-переменных).
**Применение:** для своих провайдеров рекомендовать `.vibe/.env`. Парсер — минимальный dotenv-сабсет (`KEY=VALUE`, `#`-комменты, `export`, кавычки; без интерполяции).

## [reference] Два ignore-файла в `.vibe/` — разное назначение

**Контекст:** легко спутать.
**Суть:** `.vibe/.gitignore` — для **git** (что не коммитить: рантайм-артефакты + `.env` с секретами; сеется `vibeConfigInitService`). `.vibe/ignore` — для **агента** (что не читать/индексировать/подмешивать в контекст: `.env`, `.env.*`, `secrets/`, `node_modules/`, …). Секрету нужны ОБА: `ignore` прячет его от модели, `.gitignore` — от коммита.
**Применение:** добавляя новый секретный артефакт в `.vibe/` — занести и туда, и туда.

## [recipe] Как заставить динамическую модель «думать» (reasoning/thinking)

**Контекст:** 2026-06-13, фича `dynamic-providers-transport` (фаза B). Неочевидно, что нужны ДВА поля.
**Суть:** в `.vibe/providers.json` у модели:
- `"reasoning": { "canTurnOff": true, "effort": ["low","medium","high"] }` → маппится в `reasoningCapabilities` (effort_slider) в `modelEntryToCaps`; openai-compat reasoning-хук шлёт `reasoning_effort` и парсит `reasoning_content`. Дефолт усилия — высший (`high`, если есть).
- `"extraBody": { "thinking": { "type": "enabled" } }` → `additionalOpenAIPayload`, уходит в тело **дословно** (Moonshot-специфичный тумблер). `extraBody` — общий канал для любых провайдеро-специфичных полей.

Инъекция в запрос — в `sendViaAISdk` (`aiSdkAdapter.ts:770-780`, спред `openAICompatExtraBody` через `transformRequestBody`); ядро для этого не правили. Поле `reasoning.field` в формате есть, но Фазой B НЕ потребляется (effort_slider сам шлёт `reasoning_effort`; провайдеро-специфичное — через `extraBody`). Пользовательский рецепт — блок 5 в `providers.example.jsonc`.

**Применение:** для thinking-моделей (Kimi K2.x, и т.п.) — оба поля; только `reasoning` без `extraBody` даёт effort, но не включит Moonshot-`thinking`.

**Связано:** [[vibeDefaults]] (пример засевается тем же механизмом), [[commandsPaletteModal]], [[settingsNamespaces]].
