# Context Report — команда «что ушло бы модели»

← [Knowledge Index](../README.md)

---

## [архитектура] Команда `vibeide.context.status` — отчёт о составе контекста

**Контекст:** аналог `/context` из Claude Code. По запросу автора (2026-06-12): для выбранной модели открыть временный markdown-документ (паттерн `vibeide.projectRules.showSources`) со шкалой заполнения контекстного окна + разбивкой по категориям — «что ест контекст». Статусбар-индикатор «🟢 CTX %» уже был завязан на id `vibeide.context.status`, который раньше лишь писал строку в лог; теперь клик открывает полноценный отчёт.

**Суть:**

- **Данные считает** `ConvertToLLMMessageService.buildContextBreakdown(modelSelection)` — read-only, ничего не отправляет. Живёт там же, где реальная сборка промпта (`prepareLLMChatMessages`), и читает ТЕ ЖЕ геттеры (single source of truth, без дрейфа):
  - **Каркас системного промпта** = `_generateChatMessagesSystemMessage('agent', …)` минус инструменты.
  - **Инструменты** = `systemToolsXMLPrompt('agent', mcpTools)` (экспортирован из `prompts.ts`). У моделей с нативным function-calling (`specialToolFormat` задан) схемы уходят через SDK, не в текст — строка помечается «через SDK», `toolsViaSdk=true`.
  - **Глобальные AI-инструкции / `<project_rules>` / Playbook / `<session_goals>` / `<referenced_files>`** — из `globalSettings.aiInstructions`, `_getVibeRulesFileContents()`, `VIBE_DOTVIBE_AGENT_PLAYBOOK`, `_getVibeGoalsFileContent()`, `projectRulesService.getLinkedReferences()`.
- **Оценка токенов** — `Math.ceil(len/4)` (тот же примитив, что у бюджет-гарда). Реальное число выше у плотных токенизаторов → показывается **калибровочный коэффициент** (`_tokenCalibrationByModel`, clamp по `vibeide.context.tokenCalibrationMaxFactor`).
- **Шкала и факт** берутся из `IVibeContextGuardService.getStatus()` (`currentTokens`/`maxTokens`, калиброванные). Заполняется только ПОСЛЕ хотя бы одного запроса в треде; на холодном треде факт = «нет данных», шкала рисуется от системной оценки.
- **История сообщений** не считается напрямую (импорт `chatThreadService` закрыл бы цикл `chatThreadService → convertToLLMMessageService`). Выводится как остаток: `факт / коэффициент − системная часть`. В остаток попадают история, префиксы хода (skill/rule-врезки, языковая директива) и обрамляющие конверты.
- **Рендер** — `vibeContextReportContribution.ts`: сетка `8×24` (`⛁`/`⛶`, без цвета — это редактор, не терминал) + markdown-таблица с долями и ASCII-барами. Открывается в `untitled://vibeide-context-report-*.md`.

**Применение:**

- Палитра команд → «VibeIDE: Отчёт об использовании контекста», либо клик по статусбар-индикатору CTX.
- Диагностика «почему модель захлёбывается контекстом» / «что весит больше всего» — особенно правила проекта, playbook, tool-схема.
- При добавлении новой секции в системный промпт — добавить соответствующий сегмент в `buildContextBreakdown`, иначе он молча уедет в остаток «история».

**Антипаттерны:**

- НЕ оживлять для этого мёртвый `IVibeDebugPromptService` (`recordSnapshot` нигде не вызывается) — это hot-path. Отчёт считает состав по требованию, по живым геттерам.
- НЕ импортировать `chatThreadService` в `convertToLLMMessageService` ради точного счёта сообщений — циклический граф модулей, бандлер откажется собирать.

**Связано:** [[llmAndContext]], [[toolCalling]], [[servicesAccessor]] (capture-before-await в `run()`), [[xmlToolNormalization]].
