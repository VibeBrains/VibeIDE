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
