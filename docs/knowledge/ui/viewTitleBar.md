# View title bar — правила рендеринга

← [Knowledge Index](../README.md)

ViewPaneContainer — ловушки с дублями иконок, аффордансы Collapse All / `…`, вторичный сайдбар single-row.

---

## [архитектура] View title bar — правила рендеринга иконок (ViewPaneContainer)

**Контекст:** при первом порте Vibe Projects (форк `alefragnani/vscode-project-manager`) в title bar появилось 6 иконок вместо 3 — все три экшена дублировались. Также не появлялись авто-аффордансы Collapse All / `…` More Options.

**Суть:**
- При `mergeViewWithContainerWhenSingleView: true` и единственном view — оба меню `MenuId.ViewContainerTitle` и `MenuId.ViewTitle` рендерятся одновременно. Регистрировать экшены **только в `MenuId.ViewTitle`**, иначе будет дубль.
- Кнопка `…` **More Options** появляется автоматически, если в `MenuId.ViewTitle` есть хотя бы один пункт **вне** группы `navigation` (любая `1_*`, `2_*` etc). Без overflow-пунктов — `…` не рендерится.
- Кнопка **Collapse All** (стандартный аффорданс TreeView) рендерится **только** для `WorkbenchAsyncDataTree`/`AbstractTree`. Для `WorkbenchList` (плоский список) — нужен явный `Action2` с `icon: Codicon.collapseAll`. То же касается `Refresh` — у `WorkbenchList` его нет автоматически.
- Пример иконного набора как в оригинале PM: `save → edit → list-tree|list-flat (toggle через RawContextKey) → search → tag → collapse-all → …`. Тоггл list/tags реализуется парой Action2 с `when: ContextKeyExpr.equals('vibeProjects.viewAsList', true|false)`.

**Контекст-ключ для toggle экшенов:** `RawContextKey<boolean>('name', defaultValue)` сам по себе НЕ создаёт ключ в `IContextKeyService`. Нужен эагерный `bindTo()` в `IWorkbenchContribution` на фазе `BlockRestore` — иначе `when:` выражения вычисляются против неустановленного ключа до первого клика, и иконка может не показаться при старте. Паттерн: [src/vs/workbench/contrib/vibeide/browser/vibeProjects.contribution.ts:53-60](../../../src/vs/workbench/contrib/vibeide/browser/vibeProjects.contribution.ts#L53-L60).

**Активити-бар order:** Explorer = 0, Search = 1. Чтобы вставить контейнер «вторым» — `order: 0.5` (TS-тип `number`, дробные допустимы). Целое значение в этом диапазоне будет конфликтовать с встроенными.

**Применение:**
- При добавлении любого view container → проверять, не нужен ли overflow-пункт ради `…`.
- Не дублировать экшены в `ViewContainerTitle` + `ViewTitle` — выбирать один (обычно `ViewTitle`).
- Если view предполагает группировку — использовать `WorkbenchAsyncDataTree` с самого начала, чтобы получить collapse-all/expand-all бесплатно.
- Все exhaustive-paneled view-контейнеры VibeIDE должны следовать этим правилам.

---

## [vscode] Вторичный сайдбар: один ряд заголовка для `workbench.view.vibeide`

**Контекст:** запрос собрать `title-actions` и `AuxiliaryBarTitle` в одну линию; убрать дубликат шестерёнки (2026-05).

**Суть:** в **`AuxiliaryBarPart.collectCompositeActions`** для контейнера **`workbench.view.vibeide`** первичный тулбар = **действия панелей** из `PaneComposite.getActions()`, затем **`Separator`**, затем primary из **`MenuId.AuxiliaryBarTitle`**; узел **`.global-actions`** скрывается (`hide` + класс заголовка). **`getToolbarWidth`** для этого контейнера не учитывает ширину global toolbar — иначе composite bar недооценивает ширину.

**`CompositePart.collectCompositeActions`** → `protected`, **`globalActionsMenuId` / `globalToolBar`** в **`AbstractPaneCompositePart`** → `protected`. При наличии **`vibe.settingsAction`** фильтруются **`workbench.action.openSettings`** / **`openSettings2`**. Это только строка заголовка **auxiliary bar**, не главный title bar окна с layout-controls.

**Применение:** расширить merge на другой view container — дублировать с id или ввести общий флаг descriptor; синк апстрима — конфликт в `paneCompositePart.ts`/`compositePart.ts`/`AuxiliaryBarPart`.
