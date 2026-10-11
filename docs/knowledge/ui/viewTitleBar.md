# View title bar — правила рендеринга

← [Knowledge Index](../README.md)

ViewPaneContainer — ловушки с дублями иконок, аффордансы Collapse All / `…`, заголовок вторичного сайдбара, крестики вкладок правой панели.

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

## [vscode] Вторичный сайдбар: заголовок чата и отбор дублей шестерёнки

**Контекст:** весной 2026 строки `title-actions` и `AuxiliaryBarTitle` собирались для `workbench.view.vibeide` в одну линию, в `AuxiliaryBarTitle` лежали крестик закрытия и кнопка «развернуть». Обе кнопки ушли (развернуть — в поле ввода чата, крестик — на вкладки, см. ниже), блок остался пустым.

**Суть:** слияние убрано: `AuxiliaryBarPart.collectCompositeActions` для контейнера **`workbench.view.vibeide`** больше ничего не сливает и не прячет `.global-actions` (пустой тулбар шириной 0, замерено на стенде). Осталось одно: при наличии **`vibe.settingsAction`** из действий панели убираются **`workbench.action.openSettings`** / **`openSettings2`**, иначе шестерёнка двоится. `getToolbarWidth` снова штатный.

**`CompositePart.collectCompositeActions`** → `protected`, **`globalActionsMenuId` / `globalToolBar`** в **`AbstractPaneCompositePart`** → `protected`. Это только строка заголовка **auxiliary bar**, не главный title bar окна с layout-controls.

**Применение:** новый пункт в `MenuId.AuxiliaryBarTitle` появится в `.global-actions` у всех контейнеров, включая чат, без особых случаев; синк апстрима — конфликт в `paneCompositePart.ts`/`compositePart.ts`/`AuxiliaryBarPart`.

---

## [vscode] Вкладки правой панели закрываются по одной, значок чата первым в заголовке окна

**Контекст:** крестик в правом углу шапки правой панели закрывал панель целиком, и по нему попадали мышью, закрывая стопку уведомлений, что всплывают над ним (11.10.2026). Решение владельца: крестик у каждой вкладки, он убирает вкладку; закрытие последней прячет панель; крестика в углу нет. Переключатель панели в заголовке окна получил штатные значки (был один пузырёк чата на все состояния), а чат получил свою кнопку первой в ряду: она всегда приводит к чату.

**Суть:**
- Режим включается параметром **`closableTabs`** у `IPaneCompositeBarOptions` (`auxiliaryBarPart.ts`), дальше он идёт колбэком `closeComposite` через `ICompositeBarOptions` в `CompositeActionViewItem`. По умолчанию выключен: основная панель и нижняя панель не меняются.
- **Вкладка** рисует крестик (`span.composite-close`) **поверх** правого края (`position: absolute`), место не занимает; виден только под курсором или при клавиатурном фокусе (`:hover`, `:focus-visible`), подпись под ним гаснет маской. Заливка вкладки полупрозрачная (`--modern-ui-tab-*-background` в `styleOverrides/tabs.css`), поэтому плашка одного цвета под крестиком не совпала бы в каждой теме. Крестика нет у вкладок-значков (`icon`): им не хватает места, остаются Delete, средняя кнопка и меню вкладки.
- **`CompositeBar.close`**: пока есть другая видимая вкладка, снимает закрепление (для активной незакреплённой — переключает на другую); если вкладка последняя, возвращает `false`, ничего не меняя, а `PaneCompositeBar.closeComposite` прячет часть целиком. Последняя вкладка остаётся закреплённой и возвращается вместе с панелью.
- **Клавиатура:** вкладки образуют один tab-stop (roving tabindex), поэтому отдельный крестик в порядок Tab не включён: Delete или Backspace на вкладке закрывает её, фокус уходит на соседнюю; плюс прежний пункт «Скрыть» в меню вкладки. Мышь: клик и жест-тап на крестике останавливаются там же, вкладка не активируется; средняя кнопка закрывает вкладку (как у вкладок редактора).
- **Значок чата** — действие `vibeide.sidebar.open` (то же, что ⇧⌘L), в `LayoutControlMenu` с `order: -1` (остальные 0, 1, 2) и в подменю раскладки. Перед показом оно возвращает контейнер чата в правую панель, если его перетащили, и закрепляет вкладку первой (`IPaneCompositePartService.pinPaneComposite(id, location, { first: true })` → `CompositeBar.pinFirst`), если её убрали; вкладка, что уже закреплена, остаётся на своём месте. Основное окно не подсвечивает включённые пункты этого тулбара (`highlightToggledItems` только у вспомогательных окон), поэтому «включено» нарисовано CSS-правилом по классу значка (`vibeide.css`).
- **Остаточный дефект, не наш:** `SidebarStartContribution` при каждом запуске открывает контейнер чата, поэтому убранная вкладка чата после перезапуска снова видна, пока активна (проверено на стенде). Закрепление при этом не меняется: вкладка пропадает, как только выбрана другая. По коду панель, скрытая закрытием последней вкладки, тоже показывается заново, живьём это не прогонялось. В roadmap заведено `- [ ]`.

**Файлы апстрима с правками VibeIDE (каждая помечена `VibeIDE:`) и что перепроверить при обновлении базы:**
- `browser/parts/compositeBar.ts` (+51 −1): `ICompositeBarOptions.closeComposite`, методы `close`, `pinFirst`, передача опции во view item. Проверить `unpin`/`resetActiveComposite`/`model.move`.
- `browser/parts/compositeBarActions.ts` (+101 −2): опция `closeComposite`, `registerCloseControls`, `hoverService` стал `protected`, импорты. Проверить `render` и `update` у `CompositeActionViewItem`.
- `browser/parts/paneCompositeBar.ts` (+23): `closableTabs`, `closeComposite`, `pinPaneComposite`.
- `browser/parts/paneCompositePart.ts` (+11), `paneCompositePartService.ts` (+6 −1), `services/panecomposite/browser/panecomposite.ts` (+17): `pinPaneComposite` в двух интерфейсах и `IPinPaneCompositeOptions`. Новый член интерфейса ломает все заглушки в тестах: их три в `workbenchTestServices.ts` и одна в `activitybarPart.test.ts`.
- `browser/parts/auxiliarybar/auxiliaryBarPart.ts` (+11 −59): `closableTabs: true`, слияние заголовка убрано.
- `browser/parts/auxiliarybar/auxiliaryBarActions.ts` (+7 −16): снят `MenuId.AuxiliaryBarTitle`-пункт с крестиком и два лишних импорта; четыре значка переключателя панели снова штатные (`layoutSidebarRight` и три других).
- `browser/parts/auxiliarybar/media/auxiliaryBarPart.css` (+43): стили крестика.
- Наш код: `contrib/vibeide/browser/sidebarActions.ts` (+55), `media/vibeide.css` (+7), тест `test/browser/parts/compositeBar.test.ts`.
- Запустить после синка: `scripts/test.sh --grep CompositeBar` (браузерные тесты, запускаются и без окна) и стенд: крестик под курсором, закрытие последней вкладки, значок чата в трёх состояниях.

**Применение:** другому view container в правой панели ничего делать не нужно, крестик есть у каждой вкладки. Включать `closableTabs` для других частей можно, но у основной панели вкладок нет (там панель активности со значками), у нижней панели есть свой крестик.
