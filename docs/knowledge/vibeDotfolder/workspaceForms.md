# Форма Workspace и runtime корневых JSON

← [Knowledge Index](../README.md)

Панель **Настройки VibeIDE → Рабочая область** + рантайм `agent-locks.json` / `constraints.json` / `allowed-models.json` / `pinned.json`.

---

## [ux] Рабочая область в настройках: корень `.vibe/`, промпты, workflows

**Контекст:** панель **Настройки VibeIDE → Рабочая область** (`VibeWorkspaceForms.tsx`); оператору нужно править весь пакет `.vibe/` без поиска файлов в дереве.

**Суть:**
- **`IVibeWorkspaceFormsService`** (`vibeWorkspaceFormsService.ts`) — чтение/запись через `IFileService`, лимит **`MAX_VIBE_RULES_FORM_BYTES`**, конфликты по etag как у промптов.
- Вкладки: правила (`rules.md`), `AGENTS.md`, **цели** (`.vibe/goals.md`) — отдельная форма: `loadGoals` / `saveGoals`, пример **`VIBE_GOALS_FORM_EXAMPLE`**; **промпты**, **workflows** (`workflows/*.json`, перед сохранением **`JSON.parse`**), **навыки**.
- Ряд `.vibe/README…` и **Структура .vibe**: дерево всего **`listVibeTree`** + редактор по относительному пути (**`saveVibeRelativeFile`**). Ниже — отдельный **pill на каждый `*.json` в корне** `.vibe/` (список **`listVibeRootFiles`**, сохранение **`saveVibeRootFile`**); справка по рантайму — **`workspaceRootJsonDocMarkdown`**, копируемый пример — **`VIBE_*_JSON_EXAMPLE`** в **`vibeSettingsRu.ts`**. Из корневого перечисления исключены **`rules.md`** и **`goals.md`** (**`VIBE_WORKSPACE_ROOT_FILE_TAB_SKIP`**). Цели не инжектятся автоматически; **`.vibe/goals.md`** для инструментов агента **read-only** в **`checkWriteAllowed`** (жёстко), не через `constraints.json`.
- После успешного сохранения **`constraints.json`** или **`allowed-models.json`** с корневой вкладки вызывается **`IVibeConstraintsService.reload()`**.
- При **инициализации** `.vibe` (`vibeConfigInitService.ts`): **`prompts/example.md`**, **`workflows/example.json`**, **`skills/example/SKILL.md`** — шаблоны «как пользоваться».
- Рантайм slash **`/workflow:name`** по-прежнему **`VibeWorkflowService`**, который сканирует и `.json`, и `.yaml`; форма настроек редактирует **только `.json`** под `workflows/`.

**Применение:** новые типы файлов в корне `.vibe/` — расширить список или убрать из skip; новые подпапки с формой — по образцу `listPrompts` / `listWorkflows`.

---

## [vscode] Корневые JSON `.vibe/` (agent-locks, constraints, allowed-models, pinned): рантайм

**Контекст:** сохранено по запросу оператора после уточнения справки в форме Workspace (2026-05-05).

**Суть:**
- **`agent-locks.json`** — **`VibeAgentTerritorialLockService.evaluateWrite`**: массив **`locks`** (`holder`, **`paths`** glob относительно корня workspace folder, необяз **`until`** ISO). **`toolsService._checkAdvisoryTerritorialLocks`**: без автопропуска правок ⇒ **исключение**; при **`chatAgentAutopilot`** или **`autoApprove.edits`** ⇒ возможен проход с **аудитом** `advisory_territorial_lock`.
- **`constraints.json`** — **`checkWriteAllowed`**: **`deny_write`** + блок **`.vibe/goals.md`**; **`deny_read`** / **`checkReadAllowed`** не вызываются из **`read_file`**. **`max_lines_per_function`**, **`deny_age`** в типах, в **`checkWriteAllowed`** не проверяются.
- **`allowed-models.json`** — **`IVibeConstraintsService.reload`** + **`isModelAllowed`** (точное совпадение или substring). **Вызывающего кода из чата/отправки в репозитории нет** ⇒ whitelist пока не режет выбор модели в UI автоматически.
- **`pinned.json`** — init / health / unified-config Phase 2; **нет** общей автоподстановки в каждый запрос агента — справочный задел; использовать **`@`** / `rules.md`.

**Применение:** включить блокировку моделей или deny_read — добавить вызовы в **`chatThreadService`** / **`read_file`** и обновить эту секцию.
