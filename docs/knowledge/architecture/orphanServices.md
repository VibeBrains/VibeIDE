# L.1 «Orphan» сервисы — официальные позиции

← [Knowledge Index](../README.md)

**Контекст:** в `src/vs/workbench/contrib/vibeide/common/` присутствуют сервисы, на которые в роадмапе нет прямой ссылки (раздел L.1). Это создаёт риск drift'а — кто-то добавит дублирующий сервис, не зная о существующем. Ниже зафиксированы ответы на все семь пунктов L.1, чтобы будущие правки знали, в каком слое сидит логика.

---

## `vibePersonaService.ts` — отдельная система от `VibeCustomModesService`

- **Что делает:** хранит **личностные пресеты** агента (тон, glossary, формат ответов) — то, *как* агент общается. `VibeCustomModesService` хранит **операционные режимы** (Manual/Supervised/Auto + per-mode constraints) — то, *что* агент имеет право делать.
- **Почему две системы, а не одна:** persona не должна снимать constraints. Mode стоит выше персоны в стеке. См. [vibeDotfolder/settingsStack.md](../vibeDotfolder/settingsStack.md).
- **Применение:** при добавлении кастомизации стиля ответа — в persona; при изменении прав/safety — в Mode.

---

## `gitAutoStashService.ts` — auto-stash перед агентским edit

- **Когда стэшит:** перед любой групповой агентской правкой (Apply All / multi-file edit), если `isDirty()` хотя бы по одному файлу.
- **Когда восстанавливает:** при rollback (через `VibePartialRollbackService` или checkpoint restore) — после восстановления файлов делает `git stash pop`.
- **Взаимодействие с checkpoint:** stash дополняет checkpoint, не заменяет его. Checkpoint фиксирует *снимок workspace*, stash — *незакоммиченные изменения пользователя*. Roll-back последовательность: checkpoint → stash pop.
- **Применение:** не вызывать вручную из новых сервисов; полагаться, что Apply-pipeline вызывает его сам.

---

## `editRiskScoringService.ts` vs `VibeDiffPreviewService.calculateConfidence`

- **Дополняет, не дублирует.** `editRiskScoring` — это **input** для confidence: оценивает вероятность регрессии по структуре diff'а (затронуто N файлов, M критических паттернов, изменён ли публичный API). `calculateConfidence` потребляет risk score плюс LLM-judge advisory и эвристические бейджи (auth/password/delete) → даёт финальный 🟢🟡🔴.
- **Правило:** `risk_score > 0.8` форсирует 🔴 независимо от judge (см. [chatUx/modesAndPolicies.md](../chatUx/modesAndPolicies.md) → confidence vs LLM-judge).
- **Применение:** новые heuristics на риск пишутся в `editRiskScoring`; aggregation остаётся в `VibeDiffPreviewService`.

---

## `nlShellParserService.ts` — natural language → shell command

- **Safety contract:** парсер НЕ запускает команду самостоятельно. Возвращает `{ command, args, safety_analysis }`. Запуск всегда через тот же confirm-pipeline что и Project Commands (`confirm: true` по умолчанию).
- **Двусмысленные команды:** возвращает `{ status: 'ambiguous', candidates: [...] }`; UI показывает Quick Pick, не угадывает.
- **Защита от injection:** перед парсингом NL-input проходит через `VibePromptGuardService` (zero-width / Bidi); shell-метасимволы в результирующих args требуют `shell: true` явно.
- **Применение:** входная точка — chat NL-mode, не прямой импорт из других сервисов.

---

## `performanceGuardrailsService.ts` — отдельно от Performance SLA

- **Performance SLA** (docs/v1/performance-sla.md) — это **acceptance** для релиза: median latency, p95/p99 на бенчмарках. `performanceGuardrails` — **runtime watchdog**: ловит нарушения порогов *в проде у пользователя*.
- **Какие пороги:** chunk gap > N мс (стрим завис), main-thread block > 100 мс, memory delta > X МБ за сессию.
- **Что делает при превышении:** не блокирует операцию; пишет JSONL в `.vibe/perf-guardrails-events.jsonl` через `IVibePerfGuardrailsService.recordTrip()` (Queue-serialised, 5MB rolling cap, fail-soft).
- **Как просмотреть:** `vibe doctor --perf` агрегирует `.jsonl` за 24h-окно через `aggregatePerfGuardrails` → markdown dashboard.
- **Применение:** новые watchdog-правила добавлять сюда, не в SLA doc. Сервис никогда не throw — даже на write error producer не падает.
- **Files:** `common/perfGuardrailsAggregator.ts` (pure), `browser/vibePerfGuardrailsService.ts` (runtime + persistence), `scripts/lib/perf-guardrails-aggregator.cjs` (CLI mirror).

---

## `memoriesService.ts` vs `vibeMemoryDecayService.ts` vs `sessionMemoryPerThread.ts`

- **Три слоя памяти, явно разграничены.**
  - `memoriesService.ts` — **explicit user memories** (то, что пользователь сам сохранил через UI; ручной CRUD). Проектный аналог `~/.claude/memory`.
  - `vibeMemoryDecayService.ts` — **Project Brain** (долгосрочная, персистится в `.vibe/context.md`, привязана к workspace). Auto-summarize ключевых решений сессии.
  - `sessionMemoryPerThread.ts` (новый, K.3 / 934) — **per-thread short-term** (только в IDE storage, decay 7 дней или при closeThread; *никогда* не пишется в `.vibe/`).
- **Drift guard:** не путать слои. Если факт *должен переехать на другую машину через git* → Project Brain. Если *только в текущей сессии* → session memory. Если *пользователь явно сказал «запомни»* → memoriesService.
- **Dispatcher landed:** `browser/vibeMemoryDispatcherService.ts` (`IVibeMemoryDispatcherService.dispatch(input)`) — авто-routing через pure `routeMemoryWrite` helper. Caller передаёт scope hints (`userExplicit`, `workspaceScoped`, `threadOnly`, `ttlHintMs?`, `threadId?`), router решает слой, forwarding идёт в существующие service'ы без модификации их API. Missing threadId на short-term route → `skipped: 'missing-threadId-for-short-term'` без throw.
- **Audit drift:** `auditMemoryLayers` (pure) умеет flag'ать duplicate-across-layers / long-term-without-workspace / short-term-with-workspace. Hookup в `vibe doctor --memory` — backlog.

---

## `telemetryService.ts` — локальный аудит-канал, не облачная телеметрия

- **Что делает:** in-IDE счётчики событий (запуск команды, переключение mode, проседание стрима) для последующего export через `vibe doctor`.
- **Что НЕ делает:** не отправляет события на сервер. Cloud telemetry в VibeIDE отсутствует по дизайну (см. Фаза 1 — «телеметрия отключена / локальная»).
- **Почему не удалён:** local audit-канал нужен для GDPR self-export (Compliance секция N.2) и для оффлайн debugging.
- **Применение:** добавлять локальные метрики сюда; *никогда* не подключать сетевой sink без явной отдельной фичи и user opt-in.
