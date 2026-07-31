# VERIFY-GATE: реальный гейт сборки/тестов при завершении хода агента

← [Knowledge Index](../README.md)

---

## [архитектура] Из soft-промпта в проверяемый гейт на `vibe_complete`

**Контекст:** «не объявляй готовым на красных тестах» долго было только инструкцией в описании инструмента `vibe_complete` + текстовым нуджем автопилота — модель могла проигнорировать. Единственный авто-прогон (`vibeRunTestsAfterApplyService`) — Phase-1 fire-and-forget: **exit-код не захватывает** (`passed:true` захардкожен). Кодовой блокировки не было. Реализовано 2026-07-19 (ветка `next`); повод — разбор спеки Forge (мобильная дев-станция), где «VERIFY-GATE: не done, пока не зелёно» — инвариант.

**Суть:**

- **Точка гейта — ветка `vibe_complete`** в [chatThreadService.ts](../../../src/vs/workbench/contrib/vibeide/browser/chatThreadService.ts) (там, где ход детерминированно завершается). До финализации плана: если `vibeide.agent.verifyGate.mode !== 'off'` И ход реально менял файлы — прогнать verify-команду и решить по её результату.
- **Захват exit-кода** — через `ITerminalToolService.runCommand` (тот же путь, что агентский `run_command`): `resPromise → { result, resolveReason }`, где `resolveReason.exitCode` — реальный код (в отличие от fire-and-forget тест-сервиса). `type:'done' && exitCode===0` → зелёно; `timeout` → красно (verify не завершился). Живёт в сервисе `vibeVerifyGateService.ts`.
- **Чистая политика решения** — `decideVerifyGate()` в [verifyGatePolicy.ts](../../../src/vs/workbench/contrib/vibeide/common/verifyGatePolicy.ts) (юнит-тест `test/common/verifyGatePolicy.test.ts`): `off`/инертно/зелёно → `complete`; `warn` + красно → `warn-complete` (заметка, но ход закрыт); `enforce` + красно → `bounce` (вернуть модель на доработку) пока `attemptsUsed < maxAttempts`, иначе `stop` (остановить прогон, отдать пользователю).
- **`bounce`** повторяет паттерн автопилот-нуджа: синтетическое `user`-сообщение с выводом ошибки + `shouldSendAnotherMessage = true` + `continue` цикла. **`stop`** — заметка ассистента + `_finalizePlanIfComplete` + стоп (анти-бесконечный-цикл).
- **Edit-guard (`didMutateThisRun`):** verify гоняется только если в прогоне исполнялся мутирующий инструмент (`edit_file`/`rewrite_file`/`create_file_or_folder`/`delete_file_or_folder` — набор `MUTATING_TOOL_NAMES`). Чистое чтение/поиск/вопрос сборку не триггерит. Отмечается `markIfMutating()` на каждом из 4 сайтов `_runToolCall`.

**Применение:**

- Включение: `vibeide.agent.verifyGate.mode = enforce` + `verifyGate.command = "npm run verify"`. Пусто в `command` → гейт инертен (проверять нечем). Дефолт `off` — не тормозит быстрые правки.
- Настройки: `verifyGate.maxAttempts` (1–10, дефолт 3 — потолок возвратов), `verifyGate.timeoutMs` (дефолт 300000 — verify тяжелее post-apply тестов).
- Не путать с `runTestsAfterApply.*` — у того другая роль (быстрый фидбэк после КАЖДОГО apply), он остался как есть; verify-gate — полная проверка перед ЗАКРЫТИЕМ задачи.

**Антипаттерны:**

- **Не** блокировать завершение при сломанном запуске самой команды: launch-ошибка (плохой shell, нет терминала) → `runVerify` возвращает `null` (инертно), а не «красно» — иначе битая конфигурация запирает агента навсегда. Красный = команда отработала с ненулевым кодом или таймаут, а не «не смогла стартовать».
- **Не** гонять verify на каждом ходе — только на `vibe_complete` и только после реальных правок (edit-guard). Иначе каждый read-ход агента тянет сборку.
- **Не** оставлять `enforce` без `maxAttempts`-потолка: неустранимая красная verify без него — бесконечный цикл bounce.

**Связано:** [[providerDiagnostics]] (тоже гоняет проверки в агент-цикле), [[chatInterruptAndInject]] (паттерн синтетической инъекции + `continue`), [[autoDowngradePipeline]] (другой анти-цикл счётчик в том же loop).
