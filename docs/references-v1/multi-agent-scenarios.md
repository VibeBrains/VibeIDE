# Multi-agent сценарии (зафиксировано для Phase 3b)

Документ закрывает roadmap-пункт «зафиксировать сценарии» без дублирования кода.

## 1. Несколько сессий агента в одном VibeIDE

Несколько чат-тредов с агентом в одном окне на одном workspace: общие файлы на диске, разделяемые checkpoints/snapshots. Требуется **сериализация** критичных операций (mutex на checkpoint / prune — roadmap B.1).

## 2. Внешний человек или агент + VibeIDE на одном клоне

Два процесса пишут в один репозиторий (например IDE + CI или две IDE): **git остаётся арбитром**; VibeIDE даёт advisory locks / очередь задач, но не заменяет merge.

## 3. Параллельная работа в git worktrees

Несколько рабочих деревьев (`VibeGitWorktreeService`, speculative exploration): осознанный параллелизм с изоляцией файлов; merge в основную ветку по политике пользователя.

Связанный код: `VibeMultiAgentService` (скелет), `VibeGitWorktreeService`, `VibeSpeculativeExplorationService`.

## 4. Иерархия «почему заблокировано» (черновик § E)

Единый порядок для UX и логов (ниже — сильнее):

1. Hard deny: `permissions.json` / `constraints.json` / workspace isolation.
2. Advisory territorial lock: `.vibe/agent-locks.json` (TTL, holder).
3. Мягкие предупреждения инструментов / judge / Trust Score.

Не дублировать одно и то же событие из двух подсистем — одно объяснение в UI.
