# Vibe Projects pane — нативная панель + декорации

← [Knowledge Index](../README.md)

Записи про Vibe Projects pane, ResourceLabel-декорации, Unicode glyphs, фазы порта `alefragnani/vscode-project-manager`.

---

## [архитектура] Vibe Projects pane — нативная VibeIDE-панель, НЕ alefragnani Project Manager

**Контекст:** сессия 2026-05-09 — пользователь попросил подсветить активный проект «при интеграции PM». Визуально панель «VIBE PROJECTS: FAVORITES» один-в-один похожа на alefragnani PM (тот же layout, те же иконки toolbar'а, префиксы тегов вида `VC: VibeIDE`). Это привело к тому, что я полтора часа пытался встроить декорацию в `IDecorationsService` против URI-схемы `projectManager-view`, которой в этой панели нет вообще.

**Суть:**
- Панель «Vibe Projects» — **встроенная VibeIDE-панель**, реализованная в [vibeProjectsViewPane.ts](../../../src/vs/workbench/contrib/vibeide/browser/vibeProjectsViewPane.ts), [vibeProjectsService.ts](../../../src/vs/workbench/contrib/vibeide/browser/vibeProjectsService.ts). View id `workbench.view.vibeProjects.favorites`, viewlet id `workbench.view.vibeProjects` ([vibeProjectsConstants.ts](../../../src/vs/workbench/contrib/vibeide/browser/vibeProjectsConstants.ts)).
- Панель использует кастомный `IListRenderer<IVibeProjectsEntry>` поверх `WorkbenchList`. `renderElement` пишет `data.primary.textContent = entry.label` — чистый `<span>`, **без ResourceLabel**.
- `vscode-project-manager` (alefragnani) тоже бандлится в `extensions/project-manager/`, но это отдельная подсистема. PM использует `Uri.from({scheme: "projectManager-view", path})` и стандартный TreeView — для него декорация через `IDecorationsService` сработала бы.

**Применение:**
- Перед любой задачей «подсветить/декорировать что-то в проектной панели» сначала проверить grep на `vibeProjects` vs `project-manager` — это две разные подсистемы.
- Декорировать узлы Vibe Projects pane через `IDecorationsService` / `vscode.window.registerFileDecorationProvider` **бесполезно**: ResourceLabel не используется, query до провайдера не доходит. Подтверждается диагностикой `console.log` внутри `provideDecorations` — вызовов 0.
- Любые визуальные изменения строк панели — через модификацию `VibeProjectsListRenderer.renderElement` напрямую (CSS-классы, inline DOM), либо через расширение интерфейса `IVibeProjectsEntry` дополнительными флагами.
- Решение для подсветки активного workspace (реализовано 2026-05-09): getter-closure от `IWorkspaceContextService` в renderer + CSS-класс `active` на `.vibe-projects-slot-row` + правило `color: var(--vscode-charts-green)` в [media/vibeide.css](../../../src/vs/workbench/contrib/vibeide/browser/media/vibeide.css).

---

## [техника] Декорации в трее не срабатывают? Проверь ResourceLabel, не IDecorationsService

**Контекст:** workbench-side `IDecorationsProvider` зарегистрирован, нет ошибок, `console.log` в конструкторе провайдера ловит регистрацию — но `provideDecorations` ни разу не вызывается для целевых URI. Время на угадывание этого впустую: ~час.

**Суть:** `IDecorationsService` дёргается только из `ResourceLabel.render()` ([labels.ts:687-690](../../../src/vs/workbench/browser/labels.ts#L687-L690)) при условии `options.fileDecorations && resource && options.updateDecoration`. Стандартный `TreeView` ([treeView.ts:1433](../../../src/vs/workbench/browser/parts/views/treeView.ts#L1433)) проходит через ResourceLabel, **только если `node.resourceUri` задан**. Кастомный `IListRenderer` (как в Vibe Projects pane) и `TreeItem` без `resourceUri` идут другим путём — в обход декораций.

**Применение:** при не-сработавшей декорации — диагностический `console.log` в `provideDecorations`. Если **0 вызовов** для целевой URI-схемы:
1. Грепнуть рендер-код панели на `ResourceLabel` / `setResource` / `resourceLabel`. Если их нет — это кастомный renderer, декорации не помогут.
2. Если ResourceLabel есть — проверить, что TreeItem действительно проставляет `resourceUri` (`node.resourceUri ? URI.revive(node.resourceUri) : null` в treeView.ts).
3. Если оба условия выполнены — проверить настройку `explorer.decorations.colors`/`badges` (обе должны быть `true`).

---

## [проект] Vibe Projects — порт `alefragnani/vscode-project-manager`, фазы

**Контекст:** при первичной интеграции порт был неполный — 1 view "Bookmarks", 3 экшена, дубль иконок. Сравнение с оригинальным `package.json` v13.1.1 показало, что переносить нужно ~7 views, ~10 экшенов в title bar, submenu сортировки, контекст-меню элементов.

**Суть:** ребрендинг 1-в-1, под префиксом `vibeide.vibeProjects.*`, view name "Favorites" (как в оригинале). Источник истины по контрактам — `https://github.com/alefragnani/vscode-project-manager/blob/master/package.json`.

**Фазы:**
- **Phase 1 (DONE, 2026-05-08):** title bar = 7 иконок (save, edit, list-toggle, search, tag, collapse-all, `…`); RawContextKey `vibeProjects.viewAsList`; overflow с `Open Settings`. Stub'ы: filterByTag → "No tags yet", collapseAll → "Tag groups collapsing arrives with the tags release". Файлы: `vibeProjects.contribution.ts`, `vibeProjectsConstants.ts`. Activity Bar order = 0.5 (вторым после Explorer).
- **Phase 2 (TODO):** sort modes (Saved/Name/Path/Recent) + view modes (list/tags). Расширить `IVibeProjectsEntry`: `tags: string[]`, `addedAt: number`, `lastOpenedAt?: number`. Persisted user settings `vibeide.vibeProjects.sortBy`, `vibeide.vibeProjects.viewAsTags`. Submenu "View and Sort As" в overflow. Перевести `WorkbenchList` → `WorkbenchAsyncDataTree` для group-by-tag и автоматического collapse-all.
- **Phase 3 (TODO):** контекстное меню элементов (Open / Open in New Window / Reveal in Finder|Explorer / Rename / Delete / Edit Tags / Toggle Enabled / Add to Workspace / Add to Favorites). Inline `link-external` на hover строки.
- **Phase 4 (TODO):** auto-discovery views — Git, SVN, Mercurial, Any, VSCode. Сканер по конфигам `vibeide.vibeProjects.{git,svn,hg,any,vscode}.baseFolders`. Регистрация 5 views с гейтами по ContextKey `vibeProjects.canShowTreeView*`. Refresh-action на каждом.
- **Phase 5 (TODO):** keybinding (оригинал `Shift+Alt+P` → listProjects), view "Help & Feedback", команда "What's New".

**Применение:** при работе над vibeProjects читать оригинальный `package.json` оригинала (по URL выше) для контрактов команд, иконок и групп меню. ID команд под нашим префиксом, но семантика и группировка `view/title` / `view/item/context` — 1-в-1.

---

## [техника] Unicode-глифы FontAwesome — escape sequences `\uXXXX` в исходниках, не литералы

**Контекст:** при правке `vibeProjects.contribution.ts` через Edit-инструмент попытка вставить escape-последовательность `` приводила к записи **литерала U+F07C** (один Unicode-символ), а не 6-символьной escape-последовательности. Это работает функционально (TS компилирует), но ломает паттерн поиска по grep и читаемость в редакторах без шрифта FA.

**Суть:** в исходниках `.ts` всегда **escape-последовательность** `''` (6 ASCII-символов), не литеральный символ. Регистрация иконки: `registerVibeideFaSolidIcon('id', '', label)`. Глиф U+F07C = `fa-solid fa-folder-open`; U+F802 = `fa-solid fa-folder-tree`.

**Применение:**
- При правке через скрипт (Python) использовать `chr(0x5c) + 'uf07c'` для конструирования backslash в heredoc — обычное `'\\uf07c'` в bash heredoc может быть проинтерпретировано как литерал U+F07C, а не 6-байтная последовательность.
- Проверять формат: `python -c "import sys; print(open(p, 'rb').read().count(b'\\\\uf07c'))"` — должно совпадать с числом registered иконок.
