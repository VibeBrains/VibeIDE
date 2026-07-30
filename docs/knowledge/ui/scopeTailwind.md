# scope-tailwind: ловушки и правила

← [Knowledge Index](../README.md)

Все записи про префиксификацию CSS-классов в React-сборке VibeIDE. **Источник большинства визуальных багов.**

---

## [foot-gun] CSS-классы в React-чате: `@@`-escape для scope-tailwind

**Контекст:** React-бандлы под `src/vs/workbench/contrib/vibeide/browser/react/src/` проходят через `scope-tailwind` (см. `react/build.js`), который **префиксует все классы строкой `vibe-`** и оборачивает CSS под `.vibe-scope`. Если в TSX написать `className='vibe-chat-neon-scope'`, на выходе получится `vibe-vibe-chat-neon-scope` — и CSS-селектор `.vibe-chat-neon-scope` (в `vibeide.css` или в неон-темах) **никогда не сматчится**. Эта ловушка отъела половину сессии 2026-05-08, когда выяснилось, что `text-shadow` на чате/истории не работал «никогда».

**Суть:** для стабильных «маркер-классов» (которые не Tailwind-утилиты, а якоря для CSS / сторонних селекторов) — писать `@@vibe-…` в TSX. Препроцессор отдирает `@@`, добавлять префикс не будет: на выходе DOM получит ровно `vibe-…`. Существующая конвенция в коде: `@@vibe-popup-panel`, `@@vibe-toolbar-pill`, `@@vibe-command-center-search`, `@@vibe-chat-neon-scope`, `@@vibe-chat-landing`, `@@vibe-pill-button`, `@@vibe-focus-ring`, `@@vibe-scope`.

**Применение:**
- Любой класс, на который ссылается CSS вне React-сборки (`vibeide.css`, `vibe-neon*.css`, body-class-маркеры) → писать `@@vibe-X` в TSX, селектор в CSS — `.vibe-X` без экранирования.
- Tailwind-утилиты (`flex`, `text-vibe-fg-2`, `rounded-md` и т.п.) — оставлять как есть, scope-tailwind их и должен прикрутить к `.vibe-scope`-чейну.
- Проверка после правки: `grep -o "vibe-[a-z-]*X" src/.../react/out/sidebar-tsx/index.js` должен дать `vibe-X` (одно `vibe-`), а не `vibe-vibe-X`.

**Antipatterns:**
- Якорный класс без `@@` → silently не матчится, баг проявляется только в браузере.
- `@@` на Tailwind-утилитах → утилитный CSS не подгрузится для них (никакого `position: relative` от `@@relative`).

**Образцовый кейс:** [[vibeModal]] — модалка рендерилась сломанной (прозрачная, мёртвые кнопки), пока инлайн-классы не пометили `@@`; там же разобрана тонкость «инлайн-литерал → `@@`, класс из переменной → без `@@`».

---

## [foot-gun] Новая React-поверхность без `@@vibe-scope` на корне рендерится полностью голой

**Контекст:** панель «Диспетчерская агентов» (`react/src/vibe-agents-tsx/`) на живом запуске 2026-07-30 вышла как немаркированный HTML: ни рамок, ни сетки, ни отступов — при том, что TS, `react-typecheck` и сборка зелёные, а разметка и классы в DOM корректные (`vibe-rounded-md`, `vibe-flex`, …).

**Суть:** `scope-tailwind` генерирует правила вида `.vibe-scope .vibe-rounded-md { … }` — **каждое** утилитное правило требует предка с классом `vibe-scope`. Существующие поверхности его ставят (`Sidebar.tsx:163`, `VibeCommandBar.tsx:32`, `VibeNotifySounds.tsx:325`), поэтому проблема невидима, пока не заводишь новое поддерево: у него предка с `vibe-scope` нет, и ни одно правило не матчится. Симптом ровно как «CSS не собрался», хотя правила в документе есть — проверяется `styleTags.some(s => s.textContent.includes('.vibe-scope .vibe-rounded-md'))`.

Корень нового поддерева: `` className={`@@vibe-scope ${isDark ? 'dark' : ''} …`} `` — `dark` нужен отдельно, у Tailwind здесь `darkMode: 'selector'`.

**Применение:** первый элемент любого нового `mountFnGenerator`-компонента несёт `@@vibe-scope`. Проверка после сборки — не «выглядит норм», а замер: `getComputedStyle(el).borderWidth !== '0px'` на элементе с `border`.

**Антипаттерн:** искать причину в `content` у `tailwind.config.js` или в отсутствующем `import '../styles.css'`. Ни то, ни другое: `content` покрывает `./src2/**/*.{jsx,tsx}` целиком, а CSS в документ инжектит бандл sidebar, который загружен всегда.

---

## [foot-gun] dev-IDE читает React-бандлы из корневого `out/`, а не из `react/out/`

**Контекст:** та же волна. После `npm run buildreact` и `location.reload()` окно продолжало показывать старую разметку — правка «не доезжала», хотя `src2/` и `react/out/index.js` уже содержали новый код.

**Суть:** два независимых препятствия, каждое достаточно, чтобы правка не появилась.

1. **Разные каталоги.** `buildreact` пишет в `src/vs/.../react/out/`, а запущенная dev-IDE грузит `out/vs/workbench/contrib/vibeide/browser/react/out/` — туда бандлы попадают только при `npm run compile`. Проверяется сравнением mtime двух файлов. Копировать надо **весь** каталог, а не свою панель: Tailwind-CSS инжектит бандл `sidebar-tsx`, и пока он старый, правил для новых классов в документе нет.
2. **Кэш модулей renderer'а.** Даже с обновлённым файлом `location.reload()` отдаёт прежний бандл — модуль остаётся в памяти процесса. Нужен полный перезапуск (`kill -9` по pid из `lsof -t -i :PORT`, затем `run-dev.sh` заново).

**Применение:** цикл правки React в живой dev-IDE — `npm run buildreact` → скопировать `react/out/.` в `out/.../react/out/` (или `npm run compile`) → **перезапустить процесс**, не перезагрузить страницу.

---

## [инструмент] CDP-ввод в VibeIDE: три места, где синтетическая клавиатура молчит

**Контекст:** смоук панели через собственный CDP-клиент (`ws` из node_modules репо, запуск из корня).

**Суть:**
- **`keyDown` не открывает палитру** — Electron слушает `rawKeyDown`; обычный `keyDown` без `text` до keybinding-сервиса не доходит, ошибки при этом нет.
- **Маска модификаторов CDP:** `Alt=1, Ctrl=2, Meta=4, Shift=8`. `2|4` — это Ctrl+Meta, а не Shift+Meta; палитра при этом не открывается и выглядит как «горячая клавиша не работает».
- **Префикс `>` в палитре обязателен.** Значение поля задаётся нативным сеттером (кириллицу `press` не набирает), и если записать чистый заголовок команды, палитра превращается в поиск файлов и честно отвечает «Соответствующие результаты не найдены» — команда при этом существует.

**Применение:** рабочая последовательность — `rawKeyDown` Meta+Shift+P с маской `4|8` → нативный сеттер `'>' + заголовок` + `input`-событие → `Enter`. Для второго шага (prompt цели) — тот же сеттер, но уже без `>`.

**Связано:** [[agentRunLedger]]

---

## [архитектура] scope-tailwind и классы только в константах

**Контекст:** Feature Options — карточки с бордером не появлялись в UI после `buildreact` (2026-05).

**Суть:** в пайплайне VibeIDE React (`node build.js` → `scope-tailwind`) префикс `vibe-` и снятие `@@` применяются к **литералам в JSX/atoms**, а не к значениям **строковых констант** вне атрибутов. Константа вроде `const c = '@@vibe-provider-settings-card rounded-lg …'` попадает в бандл **без** префиксификации → в DOM остаётся сырой `@@…` и непрефиксный `rounded-lg`, стили карточки не матчятся.

**Исправление:** классы писать в `className={...}` на элементе или в маленьком wrapper-компоненте с **статичными** строками в JSX (тернарник с двумя литералами ок).

**Применение:** любые новые «плашки» в `vibe-settings-tsx` и др.; не выносить tailwind+`@@` в общий string export.

**Рецидив 2026-07-25 (кружок контекста, `ChatContextMeter.tsx`) — цветовой хелпер:** класс-возвращающая функция `toneFor(pct) → { stroke: 'stroke-vibe-fg-3' | 'stroke-amber-500' … }` — это тот же «класс из константы», просто спрятанный за функцией. Симптом злее обычного: у `<circle>` из JSX-литерала класс стал `vibe-stroke-vibe-border-3` (префикс есть, стиль работает), а у соседнего `<circle>` с классом из хелпера остался `stroke-vibe-fg-3` — **правила под него не существует, и SVG молча рендерится с `stroke: none`**, то есть дуга просто невидима. Ни ошибки, ни предупреждения; TS/линт/сборка зелёные. Поймано только живым CDP-замером `getComputedStyle(circle).stroke`.

**Рабочий приём для «цвет зависит от значения»:** не гонять tailwind-классы через переменные, а брать **theme-токены** и класть инлайн-стилем — `stroke={toneColor}` / `style={{ backgroundColor: toneColor }}`, где `toneColor` = `var(--vscode-charts-red)` / `var(--vscode-charts-yellow)` / `var(--vscode-descriptionForeground)`. Префиксатор при этом вообще не участвует (см. запись про theme-токены в [[themesAndChat]]). Проверка после правки — не «выглядит норм», а `getComputedStyle(el).stroke !== 'none'`.

---

## [foot-gun] CSS-селектор для composite ID с точками

**Контекст:** ViewContainer регистрируется с id вида `workbench.view.vibeide`, и `compositePart.ts:240` ставит **этот литеральный id с точками** прямо в DOM (`compositeContainer.id = composite.getId()`). Парсер CSS трактует `#workbench.view.vibeide` как «элемент с `id="workbench"` И классами `.view` и `.vibeide`» — то есть НЕ матчит наш композит. В `vibeide.css` уже жил «фолбэк-селектор» под лого панели именно потому, что точечный селектор пустой; `text-shadow` для заголовка HISTORY и hide-rule для maximize-кнопки молча не работали по этой же причине.

**Суть:** для матчинга элемента по id с точками внутри — использовать **атрибут-селектор**: `[id="workbench.view.vibeide"]`. Это не требует backslash-экранирования, читается однозначно и устойчиво к будущим переименованиям view-id.

**Применение:**
- Любой workbench-DOM селектор по композиту/вью VibeIDE → `[id="workbench.view.vibeide"]` (или `:has(> .content > .composite[id="..."])` для скоупа на родителе).
- Альтернатива (хуже, но валидно): `#workbench\.view\.vibeide` с экранированием. Атрибут-селектор предпочтительнее — меньше шансов проглядеть отсутствующий backslash.
- Проверка: открыть DevTools, найти composite-контейнер, посмотреть атрибут `id` — точки видны → нужен `[id=...]`.

---

## [vscode] CSS бордера в попапах: ловушка специфичности с `.vibe-scope *` preflight

**Контекст:** правил бордер у всплывающего меню выбора режима чата (`ChatModeDropdown`, `VibeCustomDropdownBox`) — менял токены fallback-цепочки в `.vibe-popup-panel`, ничего не менялось визуально. Полдня ушло впустую, пока не докопался до настоящей причины.

**Суть проблемы (диагностика по шагам):**

1. **Поток сборки `vibeide.css`:** файл импортируется в `src/vs/workbench/contrib/vibeide/browser/vibeide.contribution.ts` через `import './media/vibeide.css'`. При сборке копируется в `out/vs/workbench/contrib/vibeide/browser/media/vibeide.css`. **VibeIDE при запуске читает из `out/`, не из `src/`**. Изменение только в `src/` без пересборки — невидимо. На время отладки можно зеркалировать правку в `out/.../vibeide.css` (Ctrl+R перезагружает CSS), но финальная правда — `src/`.

2. **scope-tailwind preflight перебивает кастомные классы.** Скомпилированный `src2/styles.css` содержит preflight:
   ```css
   .vibe-scope *, .vibe-scope ::before, .vibe-scope ::after {
       border-width: 0; border-style: solid; border-color: #e5e7eb;
   }
   ```
   Селектор `.vibe-scope *` имеет специфичность **0,1,1**. Любое правило `.my-class { border-color: ... }` (0,1,0) **проигрывает** ему — бордер становится светло-серый `#e5e7eb`, который на тёмном фоне выглядит как «белёсый».

3. **Tailwind-класс `border` (`.vibe-scope .vibe-border`) задаёт только `border-width: 1px`, без цвета.** Цвет берётся из preflight = `#e5e7eb`. Замена fallback-цепочки `var(--vscode-commandCenter-border, ...)` ничего не даст — её перебивает preflight.

4. **`@@`-префикс scope-tailwind:** `@@vibe-popup-panel` в JSX → в DOM рендерится как `vibe-popup-panel` (без `vibe-` префикса, потому что `@@` помечает «не скопировать»). CSS-селектор должен быть именно `.vibe-popup-panel`, не `.vibe-vibe-popup-panel`.

**Решение:**
- Селектор кастомного класса должен иметь специфичность **≥ 0,2,0**, чтобы перебить `.vibe-scope *` (0,1,1). Самый простой способ — явно дописать `.vibe-scope` родителем:
  ```css
  .vibe-scope .vibe-popup-panel {
      border-style: solid;
      border-width: 1px;
      border-color: var(--vscode-commandCenter-border, var(--vscode-input-border, ...));
  }
  ```
- Не полагаться на Tailwind-класс `border` для попапов — задать `border-width` и `border-style` явно в кастомном CSS, иначе зависишь от preflight-цвета.
- Эталон-паттерн: `.vibe-scope .chat-composer-shell` в `src/vs/workbench/contrib/vibeide/browser/react/src/styles.css` — двухклассовый селектор плюс `border` shorthand. Все «глобальные» кастомные классы (`.vibe-popup-panel`, `.vibe-chat-like-shell`, и т.д.) должны следовать тому же паттерну.

**Применение:** любая ситуация «поменял `border-color` через CSS-токены / переменные, ничего не изменилось» — первым делом проверить специфичность относительно `.vibe-scope *` preflight; вторым — что правка реально доехала до `out/.../vibeide.css`. Применимо ко всем кастомным классам в `vibeide.css`, не только к попапам.

---

## [vscode] Quick pick / command palette — без оверлеев в `vibeide.css`

**Контекст:** наследие Void/Cortex стилизовало `.quick-input-widget` (центровка строк, фиксированные высоты, blur/скругления).

**Суть:** этот блок **удалён** из **`vibeide.css`**; command palette снова опирается на **`src/vs/platform/quickinput/browser/media/quickInput.css`** и токены темы. Кастом внешнего вида — через **Vibe Neon / synthwave-токены**, а не отдельный глобальный оверлей workbench quick input.

**Применение:** если палитра «поехала» — не искать правила в `vibeide.css`; смотреть upstream `quickInput.css` и настройки темы.
