# Прайс моделей: где брать цену за токен и ловушка единиц

← [Knowledge Index](../README.md)

Как посчитать ≈$ за прогон (модель, promptTokens, completionTokens); почему каталожный `cost` нельзя использовать как есть. Итог разведки 2026-07-11 (аудит Vibe Agents).

---

## [архитектура] Основной API — `getModelCapabilities().cost` (USD за 1M токенов)

**Контекст:** для субагентов понадобилось показывать ≈$ в отчёте/уведомлениях (2026-07-11).

**Суть:** единственный рабочий источник прайса — чистая функция `getModelCapabilities(providerName, modelName, overridesOfModel, catalogInfo?)` из `common/modelCapabilities.ts` (common → свободно импортируется из browser; примеры вызова — `chatThreadService.ts`, `convertToLLMMessageService.ts`; `overridesOfModel` — из `IVibeideSettingsService.state`). В результате поле `cost: { input, output, cache_read?, cache_write? }` — **USD за 1 МИЛЛИОН токенов** (подтверждение единиц: `modelRouter.ts` и `routingCapabilityRegistry.ts` считают его как `costPerM`; sonnet = 3/15). Расчёт: `usd = prompt/1e6*cost.input + completion/1e6*cost.output`. **`{input:0, output:0}` = «прайс неизвестен» (дефолт нераспознанной модели), НЕ «$0»** — не показывать как ноль. `'auto'`-selection отсечь заранее (`isValidProviderModelSelection`). Готовый хелпер для субагентов: `common/subagentCostEstimate.ts` (`subagentCostUsd` + `formatUsd`).

**Применение:** любое отображение стоимости прогона; НЕ использовать `IVibeTokenCostForecastService.getPricing` (захардкоженная таблица из 7 устаревших семейств, ключ без провайдера — слабый API).

---

## [баг] Каталожный `cost` — за ОДИН токен, статическая таблица — за 1M: расхождение 1e6

**Контекст:** та же разведка; влияет не только на субагентов.

**Суть:** парсеры удалённого каталога (`remoteCatalogService.ts`) кладут в `RemoteModelInfo.cost` цены **за один токен** (LiteLLM `input_cost_per_token`, OpenRouter `pricing.prompt`) без нормализации, а статическая таблица `modelCapabilities.ts` — **за 1M**. `catalogFields()` мержит каталожный cost поверх статического → у каталожных моделей `caps.cost` в единицах per-token, и **`modelRouter.costPerM` на них врёт в 1e6 раз** (пороги cost-роутинга < 1/5/15 всегда «дёшево»). Поэтому для расчёта $ вызывать `getModelCapabilities` **БЕЗ `catalogInfo`** (гарантированно per-1M) — так делает `subagentCostEstimate.ts`. Полный фикс (нормализация при парсинге каталога) — техдолг в roadmap VA.6.

**Применение:** при любом использовании `caps.cost` спросить себя, мог ли прийти каталожный override; при фиксе роутинга по цене — начать с нормализации в `remoteCatalogService`.
