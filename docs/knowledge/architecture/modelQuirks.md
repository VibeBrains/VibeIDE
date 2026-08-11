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
3. **Bundled** — `loadBundledCatalog()` ([`bundledCatalog.ts`](../../../src/vs/workbench/contrib/vibeide/common/modelQuirks/bundledCatalog.ts)): динамический `import(resources/model-quirks.json, { with: { type: 'json' } })`, esbuild инлайнит содержимое в `main.js` на сборке. Дрейф исключён **по конструкции** — JSON единственный источник, отдельного шага синхронизации нет. (Дубль-константа `BUNDLED_CATALOG` из v0.13.7 заменена именно поэтому; описание «TS-константа-зеркало» устарело — правку каталога в TS дублировать НЕ надо.)
4. **Empty** — provider defaults.

Без exe-adjacent активным становится **более свежий по `date`** из {CDN-кэш, bundled}.

> ⚠️ **Правка `rules` ОБЯЗАНА бампать top-level `date`.** Сравнение — `cdnDate >= bundledDate` ([`modelQuirksService.ts:274`](../../../src/vs/workbench/contrib/vibeide/electron-main/modelQuirks/modelQuirksService.ts#L274)), то есть **при равенстве выигрывает CDN-кэш**. Забыли бамп — пользователь со старым кэшем обновляет IDE, новый bundled проигрывает по `>=`, и новое правило молчит до ближайшего CDN-refresh (сутки). Прецедент: добавление `kimi-k3` 2026-07-23 при `date: "2026-06-10"`. `fetchFromCDN` уважает exe-pin (не свапает активный `_catalog`, только обновляет кэш + пересчитывает staleness). Top-level `date` (ISO `YYYY-MM-DD`) — критерий свежести. CDN-down → остаёмся на кэше/bundled/exe (работа не встаёт).

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

---

## [квирки] Непроверенные правила: kimi-k3 и политика пометки (2026-07-23)

**Контекст:** правило добавляется по вендорной документации, когда живого ключа на руках нет. Соблазн — записать вторичный источник как факт; тогда через месяц правило неотличимо от проверенных, и его никто не пересматривает. Прецедент — `kimi-k3`.

**Суть:**
- **Почему правило вообще нужно, даже неподтверждённое.** Матчинг идёт по подстроке, и `kimi-k3` **не содержит** `kimi-k2` — то есть k2-семейство её не покрывает, и без явного правила модель проваливается на широкий пресет `kimi` (T=1.0/topP=0.95) **без** `mirrorReasoningContent`. Выбор стоит не между «квирк» и «чисто», а между «зеркалим» и «не зеркалим».
- **Асимметрия цены ошибки.** Лишнее зеркалирование стоит дублированного reasoning-поля на ход и безвредно, если не нужно. Недостающее — нестабильность генерации в tool-цикле. При отсутствии данных выбирается дешёвая по последствиям сторона, и это записывается как *precautionary*, а не как наблюдение.
- **Что известно фактически:** вторичные источники (apidog, 2026-07) сообщают о режиме preserved-thinking-history; техотчёта Moonshot нет; поведение не воспроизводилось. Проверено только то, что у K3 единственный уровень `reasoning_effort: "max"` — и это уже стоило нам дефекта в рецепте (`.vibe-defaults/providers/moonshot-kimi.jsonc` слал несуществующий `"high"`; **значение не нормализуется** — `vibeDynamicProvidersService` кладёт список в слайдер как есть, и выбранное уезжает в API дословно).
- **Политика пометки:** `note` непроверенного правила начинается со слова `UNVERIFIED` + основание («по аналогии с проверенным семейством X»), а не с описания поведения модели в изъявительном наклонении. Так грепом `UNVERIFIED` по каталогу в любой момент виден список правил, ждущих живой проверки.

**Статус правила `kimi-k3` на 2026-07-26: `UNVERIFIED` снят.** `note` переписан на первоисточник — вендор прямо предупреждает, что без возврата всей истории thinking «generation quality may become highly unstable». Проба B из смоука ниже перестала быть валидацией гипотезы; сам смоук остаётся полезным, но уже не блокирует ничего.

**Урок методики (третий подтверждённый случай за неделю):** вторичные источники обгоняют вендора и описывают анонсированное как существующее. Оба тезиса про K3 из пересверки 24.07 разошлись с первоисточником в разные стороны — mirror подтвердился сильнее ожидаемого, «три уровня» оказались обещанием. Правило простое: **пересказ вендорской доки — не вендорская дока**; до первоисточника такие находки живут как `UNVERIFIED` и в код не уезжают.

**Применение:** появился ключ к модели с `UNVERIFIED`-правилом — прогнать смоук и либо переписать `note` в наблюдение, либо снять поле. Смоук для K3 воспроизводится ~40 строками на `fetch` (ключ только из окружения, в лог не печатать) и состоит из двух проб:
- **A — имя уровня усилия:** два одинаковых запроса с `reasoning_effort: "max"` и `"high"`. Ошибка или неотличимое от `max` поведение подтверждает правку рецепта `["high"] → ["max"]`.
- **B — preserved-thinking-history:** двухходовой tool-цикл. Первый ход должен вернуть `tool_call` и `reasoning_content`; второй прогоняется дважды — без зеркалирования reasoning в историю и с ним. Деградация первого варианта (HTTP 400 / пустой `content` / потеря цикла) при чистом втором подтверждает `mirrorReasoningContent`; одинаково чистые оба — поле снимается, `note` смягчается.

После прогона — **бампнуть top-level `date`** (см. предупреждение выше).

**Пересверка с первоисточником (2026-07-24):** повторное веб-исследование по первичным источникам (`platform.kimi.ai`, techtimes 2026-07-18) сдвинуло два тезиса выше — оба **до живого смоука** остаются к проверке, но статус доверия изменился:

- **`mirrorReasoningContent` — теперь подтверждён первоисточником, а не аналогией.** `platform.kimi.ai` прямо предписывает в multi-turn/tool-call возвращать полное assistant-сообщение **включая `reasoning_content`**. То есть правило `kimi-k3` перестаёт быть «по аналогии с семейством» — можно повышать `note` с `UNVERIFIED` до наблюдения по доке (проба B — уже не обязательная валидация гипотезы, а перестраховка). При правке `note` — сослаться на первоисточник, убрать формулировку «precautionary/по аналогии».
- **`reasoning_effort` — РАСХОЖДЕНИЕ: три уровня `low`/`high`/`max`… → ОПРОВЕРГНУТО 2026-07-26.** Вендорский блог ([kimi.com/blog/kimi-k3](https://www.kimi.com/blog/kimi-k3)) дословно: «K3 will use max thinking effort by default, **with low- and high-effort modes to be introduced in subsequent updates**». То есть уровень на старте один, а low/high — обещание на будущее; наш `["max"]` от 23.07 верен, проба A из смоука отменяется. Осторожность «не переписывать как факт» окупилась: правило не тронули, и код не пришлось откатывать.
- **Семплинг:** вендор фиксирует не только `temperature=1.0`/`top_p=0.95` (у нас в квирке), но и `n=1`, `presence_penalty=0`, `frequency_penalty=0` — API требует эти три **опускать**. Проверить, что adapter не шлёт их для kimi.

---

## [квирк] Gemini: `temperature`/`top_p`/`top_k` депрекейтнуты вендором (2026-07-25)

**Контекст:** релиз `gemini-3.6-flash` / `gemini-3.5-flash-lite` (21.07.2026). В каталоге у нас правило `{ "match": "gemini", "temperature": 1.0, "topP": 0.95, "topK": 64 }` с пометкой «via aggregator (NOT native @ai-sdk/google path)».

**Суть:** Google объявил три классических sampling-параметра устаревшими — «deprecated and ignored. In future model generations, supplying these parameters returns an HTTP 400 error» ([changelog](https://ai.google.dev/gemini-api/docs/changelog), [latest-model](https://ai.google.dev/gemini-api/docs/latest-model)). Взамен глубина управляется строковым `thinking_level`, а не числовым `thinkingBudget`. Уровни по моделям ([docs/thinking](https://ai.google.dev/gemini-api/docs/thinking), сверено 25.07): 3.6 Flash и 3.5 Flash-Lite — `minimal`/`low`/`medium`/`high` (дефолт `medium` и `minimal`), **Pro — `low`/`medium`/`high`, дефолт `high`** (первая редакция этой записи говорила «low/high» — уровней три). Выключить размышление нельзя ни у одной 3.x.

Нашего **нативного** пути депрекейт не касается: `sendGeminiChat` кладёт в запрос только `systemInstruction`, `thinkingConfig` и `tools` — sampling туда не попадает вовсе. Правило работало только на агрегаторном пути, поэтому было безвредно сегодня (параметры молча игнорируются) и стало бы 400-й на следующем поколении.

**Сделано 2026-07-25:** правило `match: "gemini"` заменено на два — `gemini-2` и `gemini-1.5`; 3.x не матчится ничем. Профили `gemini-3-*` получили `effort_slider` вместо `reasoningCapabilities: false`, а `sendGeminiChat` — ветку `effort_slider_value` → `thinkingConfig: { thinkingLevel }` (enum SDK `@google/genai`, неизвестное значение → `undefined`, а не мусор в запросе). До этого слайдер до Gemini 3 не доходил вовсе и модель всегда шла на вендорском дефолте.

**Применение:** **широкий `match` по имени семейства живёт дольше, чем поведение, ради которого он написан** — вендор меняет контракт внутри семейства, а подстрока продолжает матчиться. Правило, завязанное на поколение, и матчить надо по поколению. Второе: список правил продублирован в `modelQuirksService.test.ts` (намеренно, «kept in sync with the JSON catalog») — правя каталог, править и его, иначе тест зелёный на устаревшей копии.

**Не проверено:** поведение конкретного агрегатора (OpenRouter и пр.) на `gemini-3.6-flash` с sampling-параметрами живьём не гонялось — вывод сделан из вендорской доки и чтения нашего кода. `thinking_level` на живом ключе Gemini тоже не гонялся: маппинг проверен типами SDK и юнит-тестами резолва, не сетевым ответом.

---

## [квирки] Модельная четвёрка дайджестов 30.07–01.08 — разбор 2026-08-05

Четыре темы очереди исследований, объединённые по подсистеме (`providers.json` + каталог квирков). Только подтверждённое первоисточниками.

### Kimi K3 — обещанные уровни effort ВЫШЛИ, правило пора обновить

Наша запись 23.07 говорила: «effort — единственный уровень `max`, вендор обещает low/high в последующих обновлениях; вторичные источники, заявляющие три уровня, опережают вендора». **Осторожность была верной, но теперь устарела.** Официальная платформа ([platform.kimi.ai](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)) прямо заявляет: «Reasoning effort supports `low`, `high`, and `max` (default `max`)».

→ **PR в quirks:** добавить `effort.values = ["low","high","max"]` в правило `kimi-k3`, дефолт `max`. Заодно снять из `note` оговорку про «вторичные источники опережают вендора» — она сделала своё дело.

Остальное по K3 подтверждено и менять не нужно: thinking **выключить нельзя** («always has thinking mode enabled»); `reasoning_content` и `content` приходят **раздельными дельтами** в стриме; `tool_choice: "required"` поддерживается.

**Кажущееся противоречие, которое НЕ противоречие:** платформенная дока пишет «Parse only that field, not `reasoning_content`» — это про разбор **structured output**, то есть какое поле читать в ответе. Наш `mirrorReasoningContent` про другое — про **возврат истории размышлений в следующий запрос**, и он подтверждён вендорским блогом (preserved thinking history mode). Та же дока это подкрепляет: «return the complete assistant message unchanged». Правило остаётся.

### DeepSeek V4 Flash 0731

- Цена $0.14 / $0.28 за 1M (in/out); **попадание в кэш — $0.0028/M, то есть −98%** ([artificialanalysis](https://artificialanalysis.ai/models/deepseek-v4-flash), [benchlm](https://benchlm.ai/deepseek/api-pricing)).
- **Reasoning effort: `high` и `xhigh`**, где `xhigh` = максимальное усилие. Обратите внимание: набор НЕ совпадает с K3 (`low/high/max`) — единый словарь эффортов на семейства не натягивается.
- Контекст 1M, MoE 284B/13B активных, **text-only** (vision нет).
- Кэширование контекста включено по умолчанию, работает best-effort по совпадающим префиксам.

→ **PR в quirks + пресет:** правило под `deepseek-v4-flash` с корректным `effort`; в пресете `deepseek-v4.jsonc` обновить цены и добавить строку про кэш-скидку. Трудоёмкость — `конфиг` + `PR в quirks`.

### NVIDIA Nemotron 3 Nano Omni — единственная тема, где нужен не пресет, а проверка

Omni-модель 31B/3B активных (Mamba2-Transformer hybrid MoE), понимает video/audio/image/text, 256K контекст, self-host ([vLLM blog](https://vllm.ai/blog/nemotron-omni), [HF](https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16)).

**Главное для нас — как её поднимают:** vLLM 0.20.0+ с аудио-экстрой (`pip install 'vllm[audio]==0.20.0'`), и tool calling требует явных флагов запуска: `--enable-auto-tool-choice --tool-call-parser qwen3_coder`. **То есть формат tool-calling у неё — qwen3-совместимый, а не «родной nemotron».** Это ровно тот класс расхождений, ради которого существует наш каталог квирков: если модель поднята без этих флагов, вызовы инструментов просто не распарсятся, и симптом будет неотличим от «модель не умеет тулы».

→ **Не пресет:** локальные vLLM-эндпоинты пользователь и так добавляет через `providers.json` как OpenAI-совместимые. Полезное здесь — **строка в документации провайдеров** про необходимые флаги vLLM и правило-заготовка в квирках на случай, если парсер даст сбой. Трудоёмкость — `конфиг`. Живой проверки не было (нет железа под 31B) — помечено как непроверенное.

### Ценовая война: цифры для пресетов

Китайские лаборатории снижали цены **шесть раз за первое полугодие 2026**, три снижения объявлены постоянными ([apidog](https://apidog.com/blog/chinese-llm-price-war-2026/), [dev.to](https://dev.to/hassann/the-2026-chinese-llm-price-war-top-5-frontier-api-costs-compared-e1g)). Выход за 1M токенов: **DeepSeek V4 Pro $0.87**, **Qwen3 Max $3.90**, **GLM-5 $3.20**; кэш-хит у Kimi K2.6 — $0.07.

→ **Конфиг:** обновить цены в пресетах. Ценность не в самих числах (они снова изменятся), а в том, что наша панель расхода считает деньги по этим цифрам — устаревшая цена даёт неверную оценку трат, а это уже вводит в заблуждение.

**Общий вывод по четвёрке:** ни одна тема не требует кода — только каталог и пресеты. Единственное, что стоит сделать не откладывая, — **три уровня effort у K3**: правило сейчас зашивает один, и пользователь не может выбрать более дешёвый режим у модели, где thinking не выключается в принципе.

---

## Muse Glimmer 30B: квирк закрывает не ту проблему, которая заметна (2026-08-11)

Локальная 30B от Meta ([карточка](https://huggingface.co/meta-models/Muse-Glimmer-30B), Apache 2.0)
даёт полезный урок о границах каталога квирков.

**Что каталог может.** Рекомендованный вендором сэмплинг — `temperature 1.0`, `top_p 0.95`,
`top_k 64` — обычное правило, добавлено. Матчится по `glimmer`, **не** по `muse`: облачная
Muse Spark — другая модель другого семейства, и общий префикс распространил бы локальные
настройки на неё. Проверено прогоном: обе формы имени (`muse-glimmer:30b-q4_K_M-dflash` и
`meta-models/Muse-Glimmer-30B`) ловятся, `muse-spark-1.2` не задет.

**Чего каталог НЕ может, и это важнее.** Glimmer отдаёт вызовы инструментов XML-подобной
разметкой ATEM, а не JSON, и размышление шлёт отдельным каналом. Из IDE симптом выглядит как
«модель не умеет инструменты»: вызовы приходят обычным текстом. **Квирком это не лечится** —
разбор делает сервер, и запускать его надо с `--tool-call-parser muse_glimmer` **вместе с**
`--reasoning-parser muse_glimmer` (второй принудительно ставит `skip_special_tokens=False`,
без него маркеры срезаются до разбора и оба канала схлопываются в `content`).

Это второй случай того же класса после Nemotron 3, где вызовы не парсились без
`--enable-auto-tool-choice`. Вывод общий: **симптом «модель не умеет инструменты» надо сначала
проверять на стороне сервера, а не искать квирк.** Место для такого знания — комментарий в
пресете провайдера, а не правило каталога.

**Третий пробел — закрыт 2026-08-11 полем `reasoningEffortInSystemPrompt`.** Сила размышления у
Glimmer задаётся строкой `Reasoning strength: low|medium|high|xhigh` в **системном промпте**, а
не полем `reasoning_effort`; остальные наши поля (`forceEmptyReasoning`, `forceToolCallFormat`,
`mirrorReasoningContent`, `forcedToolChoiceUnsupported`, сэмплинг) правят тело запроса и такого
не умели, поэтому слайдер усилия на Glimmer молчал. Теперь правило несёт шаблон строки, в него
подставляется значение слайдера, и строка дописывается к системному промпту.

Три решения, которые в этом поле стоят дороже самого поля:

- **Нет значения — нет строки.** Слайдер выключен или модель без effort-слайдера ⇒ промпт не
  трогаем. Подставить «умолчание» нельзя: для модели выдуманное слово неотличимо от осознанного
  выбора пользователя, и мы получили бы тихую подмену настройки.
- **Строка кладётся ДО веток кэширования**, внутрь блока, который помечается точкой кэша
  (`aiSdkAdapter.ts`, рядом с `systemForCall`). Она стабильна между ходами; допиши её после —
  и каждый ход рассекал бы кэшируемый префикс, то есть экономия кэша ушла бы молча.
- **Поле независимо от `includeInPayload`.** Модель вправе хотеть и то и другое, а модель,
  которая поля не знает, просто его игнорирует — гасить payload ради строки незачем.

Подстановка и склейка вынесены в чистую `withReasoningEffortInSystemPrompt` (`common/`), чтобы
проверяться без окружения. **Живьём не проверено:** 30B не помещается в память машины разработки.

**Не проверено живьём:** 30B не помещается в память машины разработки (Q4 ≈ 17–20 ГБ при 16 ГБ
на борту — ровно тот случай, который теперь ловит наш собственный расчёт «влезет ли модель»).
