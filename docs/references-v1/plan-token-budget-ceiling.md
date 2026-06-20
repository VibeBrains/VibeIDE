# План — опциональный потолок токенов / стоимости

**Цель:** ограничить расход на один `planId` поверх глобального `VibeTokenBudgetService` и очереди задач.

**Поля (backlog в frontmatter / JSON):**

- `budgetMaxUsd` — мягкий потолок в USD (оценка по `VibeTokenCostForecastService`).
- `budgetMaxTokens` — жёстче: суммарные input+output токены, относящиеся к сообщениям с этим `persistedPlanId`.

**Поведение:** при превышении — `plan_failed` в audit, шаг **`paused`**, уведомление с вариантами поднять лимит или Abort.

**Связь:** roadmap § F «Квота стоимости на уровне плана»; enforcement в рантайме — не реализовано в MVP.
