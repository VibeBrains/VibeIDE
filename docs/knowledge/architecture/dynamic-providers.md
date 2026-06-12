# Динамические провайдеры — `.vibe/providers.json`

← [Knowledge Index](../README.md)

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

**Связано:** [[vibe-defaults]] (пример засевается тем же механизмом), [[commands-palette-modal]], [[settings-namespaces]].
