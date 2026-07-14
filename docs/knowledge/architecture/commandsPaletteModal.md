# «VibeIDE Команды» — resizable-окно списка команд

← [Knowledge Index](../README.md)

---

## [архитектура] Окно-браузер команд: почему отдельно от `VibeModalService`

**Контекст:** 2026-06-12, по запросу автора. Пункт «VibeIDE Команды» в выпадающем меню иконки **brain** (`VibeideTitleBarMenu`, командный центр) открывает кастомное модальное окно 800×600 с ресайзом за нижний-правый угол и списком ВСЕХ команд VibeIDE (клик → запуск). Существующий `IVibeModalService` для этого не подошёл.

**Суть:**

- **Почему не `VibeModalService`:** он — FIFO-очередь модалок со **строковым** `body` (plain/markdown), фиксированными размерами (`size-{small,medium,large}` через CSS-класс) и без интерактивных списков. Окно команд требует resizable-геометрию + кликабельный список → отдельный компонент.
- **Слои:**
  - `common/vibeCommandsPaletteService.ts` — крошечный бридж-сервис `IVibeCommandsPaletteService` (`open/close/toggle/isOpen/onDidChangeOpen`). Singleton, чистый common.
  - `browser/vibeCommandsPaletteContribution.ts` — `Action2` `vibeide.commands.showPalette` (вызывает `open()`) + **ленивый** портал-маунт React-дерева на первое открытие (зеркало `vibeModalRootContribution` — нулевая цена, если окно не открывали).
  - `react/src/commands-palette-tsx/VibeCommandsPalette.tsx` — окно: рендерит `null` пока закрыто (подписка на `onDidChangeOpen`), геометрия в `useState`, ресайз — pointer-capture на grip'е.
  - Пункт меню — `vibeideCommandCenterMenu.ts`, группа `d_commands` (после `c_workspace` → последним в brain-меню, после «Поиск по кодовой базе»).
- **Список команд:** `MenuRegistry.getMenuItems(MenuId.CommandPalette)` → фильтр `command.id.startsWith('vibe')` (категория задана не у всех — id-префикс надёжнее), dedup по id, keybinding через `IKeybindingService.lookupKeybinding(id)?.getLabel()`. Перечитывается при каждом открытии (поздно-регистрируемые команды не теряются). Запуск — `ICommandService.executeCommand(id)`.
- **Сборка React:** новый компонент = новая точка входа в `react/tsup.config.js` (`./src2/commands-palette-tsx/index.tsx`) + **`out/commands-palette-tsx/index.d.ts` вручную** (в tsup `dts` выключен — `.d.ts` ведутся руками). После — `npm run buildreact` (scope-tailwind → src2 → tsup → out).
- **className-футган:** inline-литералы className в `.tsx` префиксуются scope-tailwind, поэтому все классы окна заданы с маркером **`@@`** (`@@vibeide-cmdpalette-*`) — он стрипается, класс уезжает в out «как есть» и матчит `vibeModal.css` (там имена без `@@`). Стили — на токенах `--vscode-*`, чтобы быть нативными во всех темах. Альтернатива (как в `VibeModalContainer`) — собирать className переменной, тогда scope-tailwind его не видит.

**Применение:**
- Новая команда в окне появляется автоматически, если её id начинается на `vibe` и она в Command Palette (`f1: true`). Ничего дополнительно регистрировать не нужно.
- Меняешь React-компонент окна → не забудь `npm run buildreact` (иначе `out/` старый) и, при новой точке входа, ручной `.d.ts` + запись в `tsup.config.js`.
- Аналогичный resizable-overlay в будущем — копируй этот паттерн (бридж-сервис + ленивый портал), НЕ нагружай `VibeModalService`.

**Связано:** [[contextReport]], [[commandTitleCategory]] (тот же brain-/command-center контекст), [[russianFirst]].
