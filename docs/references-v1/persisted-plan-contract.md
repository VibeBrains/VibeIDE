# Persisted agent plan — контракт файла (VibeIDE)

Нормативная сводка для **`.vibe/plans/*.plan.md`**. Исполнение в коде: шаблон **`vibeide.plans.newInWorkspace`** (`vibeCommands.ts`), артефакты агента **`chatThreadService._persistApprovedPlanArtifact`**, возобновление **`VibePersistedPlanResumeContribution`**.

## YAML frontmatter (обязательные поля)

| Поле | Тип | Описание |
|------|-----|----------|
| `planId` | string (uuid) | Стабильный идентификатор плана. |
| `vibeVersion` | string | Версия формата `.vibe/` артефакта. |
| `planRevision` | int | Монотонный счётчик правок плана (политика drift/fork — backlog). |
| `status` | enum | `draft` \| `ready` \| `running` \| `paused` \| `done` \| `failed`. |
| `createdAt` | ISO8601 string | Время создания. |
| `workspaceRootUri` | string | URI корня воркспейса; при несовпадении с активным корнем Execute запрещён (multi-root правило в roadmap). |

Опционально (комментарии в шаблоне ручного плана):

- `activeModel` — только **`providerId` / `modelName`**, не сырые API keys; привязка к профилю на стороне роутера.

## Машиночитаемые шаги

Внутри одного файла плана агент может сохранять JSON-блок шагов (см. типы в `chatThreadServiceTypes` / разбор в `VibePersistedPlanResumeContribution`). Схема массива шагов: **`references/v1/plan-steps.schema.json`** (черновик).

Опционально для шагов с MCP: **`references/v1/plan-mcp-allowlist.md`** (`mcpServersAllow` / `mcpToolsAllow`).

## Git merge и конфликты одного плана

Когда **две ветки** правят один и тот же `.vibe/plans/*.plan.md` или вынесенный `.steps.json`:

1. **Стандартный git-merge** — конфликтные маркеры в Markdown/YAML/JSON; пользователь обязан разрешить вручную или выбрать одну сторону (`git checkout --ours|--theirs`).
2. **`planRevision`** — после merge выставить монотонное значение (например `max(left,right)+1`) или **fork**: новый `planId`, скопированный файл, обновлённый `workspaceRootUri`; старый план пометить `failed`/`archived` по политике команды.
3. **До разрешения конфликта** не запускать **Execute / resume** для затронутого `planId` (ручной `status: paused` или отказ от артефакта).
4. Альтернатива merge: **не объединять** планы — один билдер выигрывает, второй получает новый файл под новым `planId`.

## Одновременное редактирование MD и проекции шагов

Пока нет Custom Editor: канон остаётся **файл на диске**. Любая UI-проекция (будущий todo-list) должна соблюдать **single-writer**: при активном execution lease правка MD через вторую поверхность — только read-only или с явным merge. Минимальный контроль — file watcher + предупреждение при расхождении машиночитаемого блока и текста шагов.

## `activeModel` и секреты

В frontmatter допускаются только **`providerId` / `modelName` (или `modelId`)**, привязка к профилю роутера. **Сырые API keys, endpoints с токенами и PEM** в план не записываются; BYOK остаётся в зашифрованном хранилище настроек.

## Политики

- **Экспорт между корнями multi-root:** копирование = новый `planId` и явное сопоставление `workspaceRootUri`.
- **Секреты:** перед коммитом планов в git рекомендуется прогон secret detection (roadmap § F).

## Advisory territorial locks vs `permissions.json`

Жёсткий deny из constraints/permissions **всегда выше** advisory `.vibe/agent-locks.json`. UX «почему заблокировано» должен показывать **одну** иерархию причин (roadmap § B.2 / § E).

## Семантика после ошибки шага (MVP)

Если шаг K завершился с **ошибкой инструмента** или **LLM error**:

1. **По умолчанию** план остаётся в **`running`**, шаг помечается **`paused`** с уведомлением; пользователь выбирает **Retry**, **Skip step**, **Fork plan** (новый `planId`) или **Abort** — см. UX чата / plan dashboard.
2. **Авто-retry** запрещён без явной политики (нет скрытых циклов восстановления).
3. После **Abort** — `status: failed` в frontmatter (когда редактор/рантайм синхронизирует файл) и снятие execution lease по текущей логике `reject`/`complete`.

Полная унификация веток **retry/skip/fork** в UI — roadmap § F (реализация в `chatThreadService` дорабатывается).

## Связанные команды

- `VibeIDE: New plan in workspace (.vibe/plans)`
- `VibeIDE: Open .vibe/plans folder in Explorer`
- Resume: уведомление при `status: running` после Reload Window.
