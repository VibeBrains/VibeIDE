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

## [баг] `dispatchEvent('input')` синхронен → гонка `setState` в обработчике выбора

**Контекст:** автокомплит slash-команд чата (`SidebarChat.tsx`). Выбор пункта `/skill:` вставлял текст, но вложенный список навыков не открывался — помогал лишь ручной повторный ввод `:` (2026-07-24).

**Суть:** чтобы React подхватил программную вставку в `<textarea>`, обработчик выбора (`insertSelectedSkill`) ставит значение нативным сеттером и диспатчит `new Event('input', {bubbles:true})`. **`dispatchEvent` — синхронный**: `onChangeText` отрабатывает ПРЯМО внутри вызова, матчит `/skill:` и вызывает `setSkillMenuOpen(true)`. Управление возвращается в обработчик — и стоявший там безусловный `setSkillMenuOpen(false)` (для «закрыть меню после выбора») выполнялся ПОСЛЕ. Оба сеттера в одном React-батче → выигрывает последний (`false`) → меню закрывалось. Ручной ввод бага не имел, потому что там `insertSelectedSkill` не участвует.

**Правило:** обработчик, который диспатчит синтетический `input`, НЕ должен ещё раз трогать то же состояние после dispatch — обработчик `onChange` уже единый источник истины и выставит его синхронно. Держать состояние меню в одном месте (`onChangeText`: `/skill:` → open, иначе `else` → close), а не дублировать закрытие в точке выбора. Фикс — удаление безусловного `setSkillMenuOpen(false)` из `insertSelectedSkill`.

---

## [баг] Светлая тема: белым по белому — `#fff` инлайном и мёртвые `dark:`-варианты

**Симптом (обратная связь владельца 2026-08-09, скриншот):** на светлой теме текст, набранный в поле ввода чата, невидим — видно только выделение.

**Две независимые причины, обе — «цвет мимо темы»:**

1. **Хардкод в `util/inputs.tsx`.** Вариант оформления назывался `chatDark` и задавал `color: '#fff'` инлайном, `caretColor: '#fff'` и класс `text-white placeholder:text-white/40`. Инлайн-стиль сильнее любого CSS, поэтому корректные темозависимые правила в `styles.css` (`color: var(--vscode-input-foreground, …)`) до поля не доходили — они висят на классе `textarea.vibe-chat-like-control`, которого у чат-инпута нет. Усугублялось оверлей-трюком подсветки слэш-команд: сама `textarea` красится `color: transparent`, а видимый текст рисует оверлей — тем же белым. Имя варианта и было ловушкой: `chatDark` описывает не тему, а **отсутствие собственного фона**, поэтому переименован в `chatTransparent`, а цвет во всех ветках берётся из `inputForeground`.

2. **`dark:`-варианты tailwind не работают вообще.** `tailwind.config.js` объявляет `darkMode: 'selector'`, но класс `dark` на дерево не ставит никто — проверено грепом по всей React-части. Значит любой `dark:`-класс мёртв, и работает всегда светлая половина записи. У `VibeSwitch` это давало `bg-white` на выключенном тумблере — белый на белом; выглядело как «тумблер пропал». Переведён на `inputActiveOptionBackground` / `inputBackground` + рамка `checkboxBorder`.

**Правило:** в React-части VibeIDE цвет задаётся только токеном — `asCssVariable(<token>)` из `platform/theme/common/colorRegistry` в инлайн-стиле либо `var(--vscode-*)` в CSS. Литеральный цвет допустим **лишь** поверх собственной непрозрачной подложки, которая едет вместе с ним (белый текст на `bg-black/60` у оверлеев над картинками — законно, там фон свой). Пара «литерал + `dark:`-двойник» — не альтернатива: пока класс `dark` никто не ставит, это просто один литерал.

**Как ловить дешёвле:** греп `#fff|text-white|bg-white|rgba(255,255,255` по `react/src` даёт список за секунду; дальше вопрос к каждому попаданию один — «есть ли под этим цветом СВОЙ фон». Полный аудит 09.08 дал 43 попадания, из них дефектами оказались четыре, остальное — оверлеи со своей подложкой и цвета на собственном акцентном фоне.

**Проверено:** `compile-check-ts-native` 0 ошибок, `react-typecheck` clean, `valid-layers-check` exit 0. **На экране светлой темы правка НЕ проверялась** — dev-IDE не собиралась; статус «скомпилировано», не «работает».

---

## [баг] `setColorTheme(id)` берёт ВНУТРЕННИЙ id темы, а не тот, что лежит в настройке

**Контекст:** переключатель день/ночь (2026-08-09). Кнопка отрисована, команда зарегистрирована и видна в палитре, клики доходят, исключений нет, консоль чистая — и ничего не происходит.

**Суть:** у темы **два разных идентификатора**. `settingsId` — то, что пишется в `workbench.colorTheme` (`Light Modern`, `vibe-neon`). Внутренний `id` — производная от расширения и пути (`vscode-theme-defaults-themes-light_modern-json`). `IWorkbenchThemeService.setColorTheme(themeId: string)` резолвит через `colorThemeRegistry.findThemeById()`, то есть по **внутреннему** id, и на неизвестное значение возвращает `null` — без throw, без лога. Передача `settingsId` строкой выглядит правдоподобно, компилируется и молча не работает.

**Как делать правильно:** резолвить через `await themeService.getColorThemes()` по `settingsId` и передавать в `setColorTheme` **объект темы**, а не строку. Заодно снимается вопрос «какой из двух id имелся в виду».

**Побочная ловушка того же дня:** идентификаторы легко списать с палитры, но она показывает **label**. «Default Light Modern» — подпись; id — `Light Modern`. Верный источник — `contributes.themes[].id` в `package.json` расширения.

**Правило:** любой вызов, принимающий «id темы», сверять с тем, какой из двух идентификаторов он ждёт, и при первой же реализации логировать результат — `null` вместо исключения превращает опечатку в мёртвую кнопку без следов.

**Связано:** [[../agentCollaboration/agentGates.md]].

---

## [техника] Иконки и глифы в Command Center: сетка, порядок событий, вставка

**Контекст:** кнопка «Команды» (⌘) и «мозг» в титул-баре, 2026-08-09.

**Три вещи, каждая из которых стоила отдельного смоука:**

1. **Чужая гарнитура выдаёт себя весом.** Наши иконки были Font Awesome Solid — залитая гарнитура на своей сетке. Рядом с контурными codicon'ами это читается как другой набор, и никакой цвет не спасает. Четыре иконки панели активности переведены на codicon'ы; там, где codicon'а нет (⌘, мозг), глиф рисуется своим SVG с толщиной 1.15 и `stroke: currentColor` — цвет тогда задаёт токен темы. **Текстовый символ вместо иконки — не выход:** ⌘ как символ подчиняется метрике того системного шрифта, который его подставит, и уезжает по кеглю и базовой линии на каждой ОС.

2. **`IContextView` слушает документ, поэтому обработчик на самом элементе опаздывает.** Popup, открываемый по клику на кнопке, закрывался тем же нажатием: dismiss-on-outside-click висит на документе и в фазе перехвата срабатывает раньше слушателя, привязанного к кнопке. Рабочая форма (уже применённая в `vibeProjectCommandsPopupContribution`): слушать **документ** в capture, фильтровать по `closest()`, гасить `stopImmediatePropagation()`. Симптом характерный — открытие «через раз», в замере 1-1-0-0.

3. **Штатный клик у `ActionViewItem` продолжает выполнять действие.** Если взаимодействием владеет свой обработчик нажатия, `onClick` надо переопределить пустым — иначе поверх popup открывается вторая поверхность (в нашем случае палитра команд).

**Плюс выравнивание:** свой глиф вставлять **внутрь** служебного `action-label`, а не рядом. Пустой label остаётся в той же строке и выдавливает иконку вниз — замер показал центр 20.5 против 17.5 у соседей, на глаз это «просело».

**Проверка фактом:** сравнивать `getBoundingClientRect()` центров всех элементов ряда — расхождение видно числом до того, как его заметит глаз.
