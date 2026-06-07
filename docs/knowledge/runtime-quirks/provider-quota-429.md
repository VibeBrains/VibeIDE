# Квотные 429 провайдеров — не путать с rate-limit

← [Knowledge Index](../README.md)

---

## [квирк] 2026-06-07 — openCode Go: monthly limit приходит как 429 с retry-after ≈ 5 дней

**Контекст:** при исчерпании месячной квоты openCode Go (`/zen/go/...`) возвращает HTTP 429 c
телом `{"error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached. Resets in
5 days…"}}` и заголовком `retry-after: 453966` (секунды ≈ 5,25 суток). AI SDK классифицирует
ЛЮБОЙ 429 как retryable → с нашим `maxRetries: 5` сжигал ~65 секунд на 6 заведомо обречённых
попыток, после чего пользователь получал совет «подождите немного» от rate-limit-семейства
переводчика ошибок.

**Суть:** 429 — это ДВА разных класса: короткий burst-троттлинг (retry-after секунды; ретрай
уместен) и исчерпанная квота за период (retry-after часы/дни; ретрай бессмыслен). Различитель —
величина `retry-after`.

**Применение:**
- `aiSdkAdapter.ts` → `customFetch`: 429 с `retry-after > 300с` перештамповывается в 402
  (non-retryable для AI SDK) с сохранением тела — ошибка всплывает мгновенно
  (`MAX_RETRYABLE_RETRY_AFTER_SECONDS`).
- `providerErrorTranslator.ts`: семейство «квота за период» стоит ПЕРЕД rate-limit — текст
  «Rate limit exceeded: Monthly usage limit reached» иначе матчился бы на rate-limit с ложным
  советом подождать.

**Антипаттерны:** поднимать `maxRetries` «чтобы пробить» 429 — для квотных он только
оттягивает ошибку; классифицировать 429 по тексту сообщения вместо `retry-after` (формат
текста у каждого агрегатора свой).

**Связано:** [../roadmap/token-economy.md](../roadmap/token-economy.md) — экономика токенов,
`vibeide.chat.emptyResponseCircuitBreakerThreshold` — смежные предохранители.

---

## [квирк] 2026-06-07 — Zen: зависания больших запросов (под наблюдением)

**Контекст:** запросы 40–90k токенов на claude-sonnet-4-6 через Zen anthropic-маршрут
(`/zen/v1/messages`) периодически висли без единого байта до hard-stall (120с);
gap-вотчдог иногда спасал ретраем (~80с). При этом deepseek через Zen и та же задача
через OpenRouter (payload до 30k) работали без зависаний.

**Суть (рабочая гипотеза, НЕ подтверждена):** виснет связка «Zen + anthropic-протокол +
большой payload», а не Zen целиком. Перепроверить, когда восстановятся лимиты: один и тот
же раздутый запрос на Zen-sonnet vs Zen-deepseek.

**Применение:** митигации уже в коде — hard-stall авто-ретрай (`vibeide.chat.hardStallAutoRetry`,
1 повтор), gap-вотчдог, и главное — токен-бюджетная компакция (`compactToolResultsAtTokens`),
которая не даёт запросам дорастать до зависающих размеров.
