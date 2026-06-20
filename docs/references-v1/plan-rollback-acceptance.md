# Persisted plans — rollback «до шага N» (acceptance draft)

**Статус:** зафиксированы критерии приёмки для roadmap § E; реализация UI/команд — backlog.

## Acceptance

1. Одна команда палитры **или** явное действие из Plan UI: «Откатиться к состоянию до шага *k*» для **активного** `planId`.
2. Откат использует существующий контур **checkpoint / snapshot** (`VibePartialRollbackService` / `.vibe/snapshots/`), если в шаге задан `checkpointId` или эквивалентный ref (roadmap § A.2).
3. После отката файл плана обновляется: шаги `> k` → `pending` или `skipped` по политике; `planRevision` увеличивается.
4. Запись в audit без секретов (`plan_rollback` или reuse существующих событий).

## Out of scope (пока)

- Автоматический выбор снапшота без поля в шаге.
- Откат без именованного checkpoint (полный git reset не используется по умолчанию).
