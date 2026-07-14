# Model Quirks Catalog

← [Knowledge Index](../README.md)

Каталог поведенческих квирков LLM-моделей: temperature/topP/topK пресеты, reasoning-content normalization, переключатель формата tool-call'ов. Реализация заменяет хардкод-таблицу из v0.13.5 на JSON-каталог с CDN-загрузкой.

---

## [архитектура] Зачем нужен и почему хардкод не годится

**Контекст:** каждая LLM-модель через aggregator (opencode.ai/zen, openrouter и подобные) имеет специфические требования для стабильного стриминга, не публикуемые в API. Без правильных пресетов:
- `qwen3.6-plus` через openCode галлюцинирует имена параметров native FC (`path_pattern` вместо `pattern`) + эмитит XML tool-call'ы в текст.
- `deepseek-v4-pro` падает с HTTP 400 или silent empty stream, если assistant message не содержит `reasoning` slot.
- `minimax-m2.7` без `topK=40` возвращает `Empty response (reason: unknown)`.
- `kimi-k2.5+` без `temperature=1.0 / topP=0.95` уходит в зацикленные reasoning loops.

**Суть:** в v0.13.5 эти квирки жили в `aiSdkAdapter.ts` как три хардкод-хелпера (`getModelParamPresets`, `isDeepseekFamily`, `hasInterleavedReasoning`, ~90 строк). Каждая новая проблемная модель требовала PR в код + новый релиз VibeIDE. В v0.13.6 это вынесено в JSON-каталог `resources/model-quirks.json` + CDN-fetch с `main`-ветки.

**Применение:** для добавления квирка новой модели — PR на правку `resources/model-quirks.json`, без TS-кода и без релиза. Пользователи получат новые квирки на следующем CDN-refresh (default 24 часа после старта или вручную через команду).

---

## [реализация] Fallback chain и lifecycle

**Контекст:** сервис должен работать сразу при старте (до `getQuirks()` из `aiSdkAdapter`), переживать отсутствие сети, и быть устойчивым к плохому JSON.

**Суть — источники с приоритетом + date-freshness (v0.13.17, по образцу `models.dev`):**
1. **exe-adjacent** — `<exeDir>/model-quirks.json` рядом с исполняемым файлом. **МАКС приоритет** (явный override, действует всегда, даже офлайн). Если старее bundled/CDN по `date` → флаг `staleExeAdjacent` → тост **один раз при старте VibeIDE**.
2. **CDN-кэш** — `${userData}/model-quirks-cache.json` (ETag + timestamp), пишется `fetchFromCDN()`.
3. **Bundled** — TS-константа `BUNDLED_CATALOG` (mirror `resources/model-quirks.json`); сам JSON gulp в пакет НЕ копирует (нет stderr на Windows GUI → console.warn нельзя).
4. **Empty** — provider defaults.

Без exe-adjacent активным становится **более свежий по `date`** из {CDN-кэш, bundled}. `fetchFromCDN` уважает exe-pin (не свапает активный `_catalog`, только обновляет кэш + пересчитывает staleness). Top-level `date` (ISO `YYYY-MM-DD`) — критерий свежести. CDN-down → остаёмся на кэше/bundled/exe (работа не встаёт).

User override (`vibeide.modelQuirks`) merge'ится поверх per-field (user wins).

**Матчинг правил:** `matchQuirks` — **field-merge most-specific** (НЕ first-match): все совпавшие правила сливаются, каждое поле берётся из самого специфичного (provider-scoped > длиннее `match`). Устраняет затенение provider-scoped правил (model-stalls #009).

**Lifecycle:**
- `initModelQuirksService(userDataPath)` из `src/main.ts` после `app.setPath('userData', …)`. Сохраняет `_userDataPath`, синхронно резолвит источник по приоритету, kicks off background CDN fetch.
- `getModelQuirks(modelId, providerName?)` — синхронный lookup (EMPTY_QUIRKS до init).
- `getModelQuirksCatalogStatus()` — provenance + staleness; отдаётся в renderer через ProxyChannel `vibeide-channel-modelQuirksStatus` → `modelQuirksCatalogStatusContribution` (тост при старте).
- `refreshModelQuirksCatalogNow()` / команда `vibeide.modelQuirks.refresh` — ручной CDN-refresh (резерв при падении сети).

**Применение:** работа сервиса полностью изолирована от main-bundle init (нет throw из module-init level). Любой failure → fallback вниз по цепочке без UI ошибок.

---

## [контракт] Schema каталога

**Контекст:** контрибьюторы будут править JSON, нужно зафиксировать поля и валидаторы.

**Суть — `ModelQuirksRule` (из [`modelQuirksTypes.ts`](../../../src/vs/workbench/contrib/vibeide/common/modelQuirks/modelQuirksTypes.ts)):**

```ts
interface ModelQuirksRule {
  match: string                              // case-insensitive substring
  temperature?: number                       // 0..2
  topP?: number                              // 0..1
  topK?: number                              // positive int
  forceEmptyReasoning?: boolean              // DeepSeek family
  mirrorReasoningContent?: boolean           // interleaved families
  forceToolCallFormat?: 'native'|'xml'|'auto'
  note?: string                              // freeform, ignored at runtime
}
```

**Валидация (`validateCatalog`):**
- Throws на структурную поломку (root не object, missing `version`, `rules` не array).
- НЕ throws на per-rule ошибки — невалидные правила силент-скипаются. Это **forward-compat policy**: новый каталог с неизвестными полями работает на старых IDE (просто игнорирует), broken rule не валит весь каталог.
- Out-of-range числа dropped (например `temperature: -1` → undefined).
- Boolean с не-boolean значением dropped.
- Enum (`forceToolCallFormat`) с unknown value dropped.

**Применение:** при добавлении нового поля — append к Rule + add validator branch в `validateCatalog`. Старые IDE будут игнорировать новое поле (forward compat) до своего апгрейда.

---

## [квирки] Что покрыто в каталоге на старте

**Контекст:** v0.13.6 initial catalog покрывает все 15 моделей openCode Go провайдера + family fallbacks для будущих версий.

**Суть:**
- `kimi-k2.6 / k2.5 / k2-thinking / k2 / kimi*` — temperature presets (старый k2 → 0.6, новые → 1.0+topP 0.95).
- `minimax-m2.7 / m2.5 / m2.x → topK=40`, `minimax-m2 → topK=20`, family fallback → topK=40.
- `deepseek*` — `forceEmptyReasoning + mirrorReasoningContent`. Любая DeepSeek модель.
- `qwen*` — `temperature=0.55 + topP=1.0 + forceToolCallFormat='xml'`. Native FC не используется из-за галлюцинации param names.
- `glm*` — `temperature=1.0` (z.ai upstream, 4.6 / 4.7 / 5 / 5.1).
- `gemini*` — temperature=1.0 / topP=0.95 / topK=64 (через aggregator; не для native @ai-sdk/google пути).

**Без квирков (получают provider defaults):** `mimo-v2-pro / v2-omni / v2.5-pro / v2.5`, `hy3-preview` — данных пока нет. Появится отчёт о проблемах → PR в каталог.

**Применение:** для подтверждения квирков смотреть upstream `opencode/src/provider/transform.ts:478-510` (опытные значения от их LLM-team), либо empirical observation в чате через `Empty response (reason: unknown)` toast.

---

## [квирки] `forceEmptyReasoning` — строго deepseek; mirror — capability-driven (проверено 2026-05-28)

**Контекст:** периодически возникает вопрос «у thinking-модели X есть `mirrorReasoningContent`, но нет `forceEmptyReasoning` — не пробел ли это?» (роадмап про `kimi-k2-thinking`). Сверено с живым `anomalyco/opencode .../provider/transform.ts` (`normalizeMessages`).

**Суть (две независимые reasoning-трансформации в opencode):**
1. **Пустой reasoning-слот** `{type:"reasoning",text:""}` на assistant-ходах без reasoning — вставляется СТРОГО при `model.api.id.toLowerCase().includes("deepseek")`. Это `forceEmptyReasoning` у нас. **Kimi и minimax апстримом НЕ получают.** Назначение: deepseek-reasoner API требует reasoning-блок на каждом assistant-ходе.
2. **Mirror `reasoning_content`** в `providerOptions.openaiCompatible.[field]` — gated по `model.capabilities.interleaved.field` (model-agnostic, исключая `@openrouter/...`). Это `mirrorReasoningContent` у нас. Применяется к любой interleaved-модели, включая kimi.

**Вывод по kimi-k2-thinking:** `mirrorReasoningContent` без `forceEmptyReasoning` **в точности** повторяет трактовку kimi в opencode → корректно, НЕ пробел. Добавлять `forceEmptyReasoning` к kimi = отклонение от рабочего апстрима + спекуляция без репорта (урок #005).

**Открытое расхождение (data-point для #009/#014):** наш `minimax` имеет `forceEmptyReasoning:true` (добавлен по #009), а opencode минимаксу пустой слот НЕ ставит — и у них minimax работает. Значит либо (a) наш AI-SDK-путь отличается от opencode и слот реально нужен, либо (b) #009-фикс был шире необходимого. **НЕ править без данных** (#009 у пользователя закрыт; смена = регресс-риск). Проверять при разборе #009/#014 через `vibeide.debug.dumpFullPrompt`.

**Применение:** прежде чем добавлять `forceEmptyReasoning` новой модели — убедиться, что её id-семейство реально deepseek (или есть подтверждённый репорт HTTP-400/empty-stream без reasoning-слота). Mirror — ставить по факту interleaved-reasoning (thinking-модель).

---

## [квирки] MiniMax-M3 — двойной reasoning-канал + игнор effort/off (проверено 2026-06-08)

**Контекст:** интеграция прямого провайдера `minimax` (OpenAI-совместимый, `https://api.minimax.io/v1`). Тестовая модель — `MiniMax-M3` (контекст 1M, MSA-архитектура, мультимодальная). Диагностика — через временный debug-лог сырого AI-SDK стрима (`aiSdkAdapter`, fullStream parts + finishReason).

**Суть (эмпирически, по debug-логу 152 ходов + 3 прогона high/low/off):**
1. **Дублирует chain-of-thought в ДВУХ каналах одновременно:** нативный `reasoning-delta` (= `reasoning_content` delta) И тот же текст inline в `content` как `<think>…</think>`. То есть мысль приходит дважды.
2. Старая `extractReasoningWrapper` (для `openSourceThinkTags`) на этом интерливе **ломалась**: перезаписывала нативный reasoning своим разбором, а на финале (`getOnFinalMessageParams`), если `</think>` не попал в её аккумулятор, сваливала ВЕСЬ текст в reasoning → **тело ответа пустело, а reasoning терялся в пайплайне** (в экспорте не было ни `<think>`, ни `🧠 Размышления`).
3. **Игнорирует управление reasoning:** ни `reasoning_effort: low|high`, ни `thinking:{type:disabled}` не действуют (off всё равно даёт reasoning-блоки; low даёт рассуждение не короче high — шум). Совпадает с их баг-трекером (issues #68/#121 «how to disable thinking», oh-my-pi #626). Это **вендорная сторона** — payload мы шлём корректно (см. [[aiSdkMigrationWip]]).

**Решение (v0.19.x):** новое поле `reasoningCapabilities.stripThinkTagsFromContent: [open, close]` + `stripThinkTagsWrapper` (extractGrammar.ts) — STRIP-ONLY: вырезает дубль `<think>…</think>` из тела (и прячет незакрытый хвост при стриминге), **`fullReasoning` не трогает** → нативный `reasoning-delta` остаётся источником для фолда/экспорта. У MiniMax профиль использует `stripThinkTagsFromContent` (НЕ `openSourceThinkTags`) + `output.nameOfFieldInDelta: 'reasoning_content'`. `openSourceThinkTags` оставлен для моделей БЕЗ нативного канала (ollama/deepseek-R1 через aggregator).

**Применение:** для любой модели, которая шлёт нативный reasoning И дублирует его inline-тегами — использовать `stripThinkTagsFromContent`, а НЕ `openSourceThinkTags` (последний перезаписывает/теряет нативный reasoning). Если у MiniMax однажды заработает off/effort — это починка на их сервере, наших правок не требует (payload уже уходит). Слайдер/тумблер у minimax оставлены намеренно (на случай серверного фикса).

---

## [квирки] Auto-feed каталога из runtime-доказательств (O.13, 2026-07-06)

**Контекст:** авто-даунгрейд native→XML (`_autoDetected` override, TTL + re-probe, гейт только на `numeric-tool-name` — уроки #008) чинит модель в пределах сессии, но модель, проходящая этот танец КАЖДУЮ сессию, всякий раз сжигает несколько ходов на сбои до срабатывания порога. Сырые счётчики `safetyNet*` для авто-предложения квирка не годятся: они стреляют только в XML-режиме (внутри `extractXMLToolsWrapper`), т.е. описывают модель, уже переключённую в XML, а не native-модель, которой нужен квирк.

**Суть:**
- **Сигнатура для долговременного фикса = повторные авто-даунгрейды в РАЗНЫХ сессиях** (не событий, а сессий: одна может быть случайностью). Pure-логика — `common/modelQuirksAutoFeed.ts` (стейт per `provider:model`: downgradeCount / sessionCount / suggested; JSON round-trip, тесты).
- **Сервис** `browser/vibeQuirkAutoFeedService.ts`: `recordAutoDowngrade()` дергается из блока авто-даунгрейда `chatThreadService`; стейт — `IStorageService` APPLICATION-scope (переживает сессии); при пороге (`vibeide.modelQuirks.autoSuggestSessions`, дефолт 2; выключатель `vibeide.modelQuirks.autoSuggest`) — уведомление, **один раз на модель навсегда** (`suggested`-флаг).
- **«Закрепить XML-режим»** = `setOverridesOfModel(provider, model, { specialToolFormat: null })` **без** `_autoDetected` → долговременный override: нет TTL, re-probe его не трогает (re-probe работает только по `downgradedModelsThisSession`). НЕ писать в `vibeide.modelQuirks`-настройку: она читается один раз на старте (нужен перезапуск), override действует сразу.
- **«Скопировать правило для каталога»** = готовый JSON-сниппет правила (`match`/`provider`/`forceToolCallFormat:'xml'`/`note` с доказательствами) для one-file PR в `resources/model-quirks.json` — data-driven путь пополнения апстрим-каталога.
- **Per-model счётчики нормализации** (бонус-задел Фазы 3 диагностики): `NormalizeAttribution` в `xmlToolNormalize.ts` — экспортные обёртки пинят атрибуцию на время одного СИНХРОННОГО прохода (single-threaded → race-free), `getNormalizeCountersByModel()` + IPC `getNormalizeCountersByModel` на LLM-канале.

**Применение:** источник правды о «системно сломанном» native FC — стор авто-фида, не счётчики слоёв. Прежде чем вносить предложенный квирк в каталог (PR), сверить с матрицей [[xmlToolFormatMatrix]] и открытыми расхождениями выше (урок: не форсить XML капризным-но-живым моделям без данных).
