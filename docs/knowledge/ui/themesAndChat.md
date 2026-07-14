# Темы и оформление чата

← [Knowledge Index](../README.md)

Vibe Neon, theme tokens, theming чат-композера, fullscreen modes, secondary sidebar border.

---

## [темы] Встроенный Vibe Neon vs Marketplace-темы

**Контекст:** нужна «родная» неон-тема и при этом совместимость с установкой других цветовых тем из Marketplace/Open VSX.

**Суть:** builtin-расширение **`vibeide.vibeide-neon`**; **settings id** — **`vibe-neon`** / **`vibe-neon-noglow`**. **Продуктовый дефолт** (новый профиль, нет сохранённого значения): **`themeConfiguration.ts`** — для desktop **`workbench.colorTheme`** и **`workbench.preferredDarkColorTheme`** default = **`ThemeSettingDefaults.VIBEIDE_DEFAULT_THEME`** (`vibe-neon`); дублируется **`contributes.configurationDefaults`** в **`extensions/vibeide-neon/package.json`**. Константа **`ThemeSettingDefaults.COLOR_THEME_DARK`** в **`workbenchThemeService.ts`** — тот же id (`vibe-neon`): на неё опираются fallback темы, welcome checkbox'ы и миграции **`Experimental Dark` → default dark**.

Ранее **`registerDefaultConfigurations`** в **`src/vs/sessions/contrib/configuration/browser/configuration.contribution.ts`** задавал **`workbench.colorTheme: ThemeSettingDefaults.COLOR_THEME_DARK`** глобально — при **`COLOR_THEME_DARK === 'Dark 2026'`** это перебивало дефолт схемы; для VibeIDE держать **`COLOR_THEME_DARK`** и sessions-default согласованными с **`vibe-neon`**. Любое **явно сохранённое** User/Workspace/Folder/synced значение **`workbench.colorTheme`** по-прежнему **выше** дефолта реестра (это не «хук», а обычная модель VS Code).

**Типичный сюжет:** после смены продукта на дефолт `vibe-neon` интерфейс остаётся на **Dark 2026** — смотреть **`%APPDATA%\<product-data-folder>\User\settings.json`** (для **`npm run electron` / vibe-dev** часто **`vibeide-dev-dev`**, путь вида **`…\Roaming\vibeide-dev-dev\User\settings.json`**) и ключ **`workbench.colorTheme`**; убрать ключ или выставить **`vibe-neon`**.

Инжект CSS: **`vibeNeonThemeContribution`**. Слепки: **`upstream/vendor-neon-theme/snapshot-*`**. Контейнер композера чата (**`VibeChatArea`** / **`SidebarChat.tsx`**) — см. актуальный теминг рамки/разделителя в записи ниже.

**Применение:** при обновлении вендор-снимка править **`snapshot-*`**, затем мерж в **`themes/vibe-neon.json`** и два файла в **`media/`** (см. `SOURCE.md`). После правок React-чата (`SidebarChat.tsx` и др.) обязательно **`npm run buildreact`** — рантайм грузит **`react/out/`**, а не исходники `src/`.

---

## [техника] Theme-токены в кастомном DOM — через `var(--vscode-<token>)`, без `IThemeService`

**Контекст:** при подсветке активного проекта зелёным потребовался цвет из палитры темы, а не хардкод. Регистрировать собственный `ColorIdentifier` через `registerColor` для одного use-case — overkill; подписываться на `IThemeService.onDidColorThemeChange` ради `getColor(...).toString()` — overkill ещё больший.

**Суть:** все зарегистрированные через `registerColor(id, ...)` цвета VS Code автоматически экспонирует как CSS custom properties вида `--vscode-<id-with-dots-replaced-by-dashes>`. Для `charts.green` это `--vscode-charts-green`. При смене темы переменные обновляются движком VS Code — JS-код не должен ничего перерендеривать.

**Применение:**
- В любой кастомной DOM-разметке использовать `color: var(--vscode-charts-green)` вместо `new ThemeColor('charts.green')` (последнее работает только в `IDecorationData`/`ThemeIcon`/etc., где workbench сам строит CSS-класс).
- Имя переменной: точки в id заменяются на дефисы. `editor.foreground` → `--vscode-editor-foreground`. `terminal.ansiGreen` → `--vscode-terminal-ansiGreen` (camelCase сохраняется).
- Список зарегистрированных id: [src/vs/platform/theme/common/colors/](../../../src/vs/platform/theme/common/colors/) — там по файлам chartsColors / editorColors / listColors / etc.

---

## [vscode] Чат-панель: теминг и быстрое восстановление после merge VS Code / scope-tailwind

**Контекст:** границы композера чата становились «белыми» при переходе на токены темы — отладка показала поломку на этапе префиксификации CSS. После синка upstream та же ошибка возможна снова.

**Суть:**
1. **Рамка как у верхнего поиска** — это Command Center: `titlebarpart.css`, `border: 1px solid var(--vscode-commandCenter-border)`. В CSS чата использовать ту же лестницу: `commandCenter-border` → `commandCenter-inactiveBorder` → `input-border` → `widget-border`; активные состояния — `commandCenter-activeBorder`, затем `focusBorder`.
2. **Не использовать Tailwind arbitrary** `border-[color:var(--vscode-…)]` в дереве **`contrib/vibeide/browser/react/src/`**: **`scope-tailwind`** подменяет **`var(` → `vibe-var(`**, CSS невалиден, цвет границы сбрасывается (**часто визуально белый `currentColor`**).
3. **Рабочий паттерн:** правила с настоящими `var(--vscode-*…)` в **`react/src/styles.css`** — классы **`chat-composer-shell`**, **`chat-composer-shell--drag`**, **`chat-composer-toolbar-rule`**; в **`SidebarChat.tsx`** на корне композера — **`@@chat-composer-shell`** (и модификатор drag), чтобы имена попадали под **`.vibe-scope`** без двойного `vibe-` префикса.
4. **Neon:** явные ключи **`commandCenter.*`** / **`input.border`** в **`extensions/vibeide-neon/themes/vibe-neon.json`** (noglow только `include` базы).
5. **Сборка:** после правок — **`node build.js`** из **`contrib/vibeide/browser/react/`** или **`npm run buildreact`** из корня (как принято).
6. **Кнопки-пилюли (`vibe-pill-button`):** общий стиль чата / настроек / онбординга — классы в **`styles.css`**, в TSX только с префиксом **`@@`** (`@@vibe-pill-button`, `@@vibe-pill-button--active`, `@@vibe-pill-button--primary`, `@@vibe-pill-button--secondary`). Токены: input.*, list.activeSelection*, **button.background/hoverBackground** (primary), **button.secondaryBackground** (secondary). **`VibeButtonBgDarken`** в **`inputs.tsx`** по умолчанию = secondary pill; **`variant="primary"`** для основного действия.

**Применение:** регрессия после обновления VS Code/Merge → в DevTools ищем **`vibe-var(`** на border; восстанавливаем блок в **`styles.css` + @@классы в TSX**, пересобираем бандл. Подробный чек файл/классов — см. текущее состояние **`SidebarChat.tsx` (`VibeChatArea`)** и **`styles.css`** в этом коммите.

---

## [архитектура] Chat fullscreen modes (`vibeide.chat.toggleMaximize` / `toggleZen`)

**Контекст:** добавлено в сессии 2026-05-08 для двух кнопок-иконок в правом верхнем углу chat-композера (`SidebarChat.tsx` → `inputChatArea`). Эквивалента в upstream VS Code нет — `toggleMaximizedAuxiliaryBar` максимизирует только auxbar, нам нужно поведение с editor-group и тонкой настройкой по табам/activity-bar.

**Суть:**
- Один state-machine `_chatFullscreenMode: 'off' | 'maximize' | 'zen'` в `vibeideChatPane.ts` на уровне модуля. Режимы взаимоисключающие; клик активного → `off`, клик другого режима → переключение.
- Капчура исходного состояния (`_saved`) случается ровно один раз — при первом переходе из `off`. Восстанавливается при возврате в `off`. Между `maximize` ↔ `zen` `_saved` НЕ перезаписывается.
- Что именно делает каждый режим:
  - **maximize:** скрывает sidebar / auxbar / panel + `editorGroupsService.toggleMaximizeGroup(activeGroup)`. Табы и activity-bar остаются.
  - **zen:** maximize + activity-bar скрыт + `workbench.editor.showTabs: 'none'` + body-класс `vibeide-chat-zen` (через `mainWindow.document.body.classList.toggle`).
- `showTabs` правится через `ConfigurationTarget.MEMORY` — изменение эфемерно, не пишется в settings.json.
- Body-класс `vibeide-chat-zen` — единственный канал для CSS-хуков, потому что в React нет готового хука для подписки на ContextKey. Любой CSS-хук под zen-режим вешается на `body.vibeide-chat-zen ...` в `vibeide.css`.
- Landing-page имеет дополнительный маркер `@@vibe-chat-landing`. CSS-правило `body.vibeide-chat-zen .vibe-chat-landing > *:not(:first-child) { display: none; }` оставляет видимым только инпут-блок (первый ребёнок), убирает контекст-чипсы / quick-actions / past-chats. То же правило центрирует инпут (`max-width: 600px; align-self: center; justify-content: center`).
- Кнопки в TSX используют **inline styles** (минуя scope-tailwind) — это намеренно после случая, когда Tailwind-классы вроде `top-1.5` не успевали попасть в собранный `styles.css` после правки.

**Применение:**
- Расширение функционала (новый режим `presentation`, ещё одна кнопка) — добавлять как ещё одно значение `ChatFullscreenMode`, обновлять обработку в `applyChatFullscreenMode`. Не плодить параллельные state-машины.
- CSS-хуки на zen — только через `body.vibeide-chat-zen ...`. Не пытаться передавать состояние в React (ContextKey-хуков для React в проекте нет — потребует новой инфраструктуры).
- Изменение `showTabs` в других местах кода — использовать `ConfigurationTarget.MEMORY` если нужна эфемерность; иначе пользователь увидит запись в settings.json.
- Команды `vibeide.chat.toggleMaximize` / `vibeide.chat.toggleZen` зарегистрированы как Action2 с `f1: true` — доступны из палитры под названиями «VibeIDE: Chat Maximize» / «VibeIDE: Chat Zen Mode».

**Antipatterns:**
- Не использовать встроенный `workbench.action.toggleMaximizedAuxiliaryBar` для чата — он максимизирует auxbar (HISTORY), а не editor-group с чатом.
- Не управлять видимостью `Parts.ACTIVITYBAR_PART` через стандартный `workbench.action.toggleActivityBarVisibility` — нам нужна именно эфемерная toggle с восстановлением, а команда пишет в config.

---

## [ux] Видимая граница вторичного сайдбара (чат) у редактора

**Контекст:** шов между редактором и панелью чата почти неразличим; тема задаёт `sideBar.border`, но он сливается с фоном (2026-05).

**Суть:** контейнер чата/вторичной панели — **`Parts.AUXILIARYBAR_PART`**, классы на элементе: **`part.auxiliarybar.basepanel`** + **`right`** или **`left`** в зависимости от **`workbench.sideBar.location`** (см. `workbench.ts`: при primary sidebar слева у auxiliary класс **`right`**). В **`AuxiliaryBarPart.updateStyles`** граница выставляется **инлайном** из **`SIDE_BAR_BORDER`**; если цвет слабый, линии нет.

В **`src/vs/workbench/contrib/vibeide/browser/media/vibeide.css`** добавлены правила **`.monaco-workbench .part.auxiliarybar.right`** (`border-left`) и **`.left`** (`border-right`) с **`!important`**, цвет: **`--vscode-sideBar-border` → `--vscode-panel-border` → `--vscode-widget-border` → `color-mix(..., --vscode-sideBar-foreground)`**, чтобы линия оставалась читаемой в любой теме.

**Применение:** менять толщину/цвет — править тот же блок в `vibeide.css`; после правок media — **`npm run compile`**, затем Reload Window. Отдельно: редкий **`npm run compile`** с **`ENOENT`** на **`out/vs/workbench/contrib/mcp/test/common`** при полном `compile` — не из-за CSS; повторить сборку; если повторяется — исключить гонку/АВ с папкой **`out/`**.
