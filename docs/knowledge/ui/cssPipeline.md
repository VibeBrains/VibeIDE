# CSS pipeline VibeIDE

← [Knowledge Index](../README.md)

`vibeide.css`, React `styles.css`, build flow, dev CSS MIME.

---

## [архитектура] vibeide.css (стили contrib, ранее cortexide.css)

**Контекст:** унаследованный слой добавлял отдельный CSS с хардкодом и ломал темы; файл переименован вместе с модулем на **`vibeide.css`**.

**Суть:**
- Стили лежат в `src/vs/workbench/contrib/vibeide/browser/media/vibeide.css`.
- Переменные маппятся на `--vscode-*`, чтобы работать с любой темой.
- Импорт в `vibeide.contribution.ts` (и скомпилированный `.js` в `out/`).

**Применение:** при правке стилей React-панели VibeIDE — только `vibeide.css`.

---

## [vscode] VibeIDE React: `styles.css` — первый подозреваемый при поломке Tailwind/UI

**Контекст:** пользователь вернул импорт после эксперимента; зафиксирован порядок отладки.

**Суть:** `src/vs/workbench/contrib/vibeide/browser/react/src/styles.css` — **кастомный** входной CSS для React-панелей: `@tailwind` + кастомные классы Void. **Бекап оригинала** (до synthwave-оформления): тот же путь, файл **`styles.backup.css`** — копия исходного вида; при откате оформления можно сверяться с ним или восстановить из него. **Текущий** `styles.css` дополнительно **адаптирован под synthwave** (палитра cyan / magenta / purple, свечения на focus/hover/скролл/индикаторах загрузки и т.д.) поверх базовых правил; логика префиксации не менялась.

Side-effect импорт из `Sidebar.tsx`, `VoidTooltip.tsx`, `VoidCommandBar.tsx`, `VoidSelectionHelper.tsx`. Сборка: `npm run buildreact` → `scope-tailwind` (префикс `void-`, область `void-scope`) пишет в `src2/styles.css`, `tsup` с `injectStyle` вшивает CSS в `out/*.js`. Если «пропали» утилиты Tailwind/`void-*` или сломался layout этих виджетов — сначала проверить наличие этих импортов, успешность `buildreact` и актуальность `src/styles.css` / сгенерированного `src2/styles.css`.

**Ловушка scope-tailwind:** собственный блок `.void-scope { … }` в исходнике становится `.void-scope .void-scope` в бандле (нужна вложенность); селекторы вида `.void-scope.void-dark …` превращаются в цепочку «предок `.void-scope` → потомок `.void-scope.void-dark`», что не совпадает с корнем сайдбара (`@@void-scope` и класс `dark` на одном узле). Кастомные оверлеи безопаснее писать без дублирования `.void-scope` в селекторе или литералами hex/`color-mix` на уже префиксируемых классах (`.void-focus-ring` и т.д.).

**Применение:** любые регрессии вёрстки сайдбара чата, command bar, selection helper, void-tooltip.

---

## [vscode] Dev workbench: CSS MIME / «Expected JavaScript-or-Wasm module» для `*.css`

**Контекст:** в консоли Electron при загрузке `workbench.desktop.main.js` — массовые ошибки MIME `text/css` для `actions.css`, `statusbarpart.css` и т.д.; цепочка падает на динамическом `import()` (2026-05).

**Суть:** в dev под **ESM** стили подключаются как `import './foo.css'`. Браузер должен получить не «модуль CSS», а **import map** из **`setupCSSImportMaps`** в `workbench.ts`: для каждого пути из **`configuration.cssModules`** регистрируется blob-«обёртка», которая делает **`link rel=stylesheet`**. Список **`cssModules`** в main собирает **`CSSDevelopmentService.getCssModules()`** (rg по `out/vs/**/*.css`, при пустом выводе — обход **`fs`**). **`CSSDevelopmentService.isEnabled`** = **`!isBuilt`** *или* эвристика по заголовку **`statusbarPart.js`** (есть ли **`import '…\.css'`**), чтобы запуск **без `VSCODE_DEV`** из клона всё равно получал **cssModules**. В import map дублируются ключи с альтернативным регистром буквы диска **`vscode-file://vscode-app/d:` ↔ `D:`**. Если **`rg.exe`** из **`@vscode/ripgrep` отсутствует** — срабатывает FS-scan. Blob-код загрузки использует **`JSON.stringify(cssUrl)`** для безопасных путей. Не смешивать с **`npm run transpile-client`** без нужды (см. `scripts/vibe-dev.bat`). Vite hot reload выставляет **`globalThis._VSCODE_DISABLE_CSS_IMPORT_MAP`** — тогда CSS отдаёт Vite, не disk `out/`.

**Применение:** диагностика «сломался workbench после клона на Windows»; лог main: **`[CSS_DEV]`**.

---

## [react] Циклические иконки-индикаторы: inline-SVG, не Unicode-символы

**Контекст:** делали индикатор «думания» модели как перебор символов точка → плюс → снежинка (вместо спиннера). Через CSS-only анимацию с `position: absolute` + `opacity` keyframes — все три глифа рендерились одновременно (правила не подхватились). После переключения на React state + `setInterval` ([SidebarChat.tsx](../../../src/vs/workbench/contrib/vibeide/browser/react/src/sidebar-tsx/SidebarChat.tsx) `IconLoading` + `LOADING_GLYPH_FRAMES`) глифы сменялись, но ни `·` (U+00B7), ни `∙` (U+2219 BULLET OPERATOR), ни даже принудительный `font-family: monospace` + `width: 1ch` не давали выравнивания точки по центру `+` — Segoe UI, Cascadia Code и эмодзи-фолбэк имеют расходящиеся метрики advance-width / x-height / math-operator-center.

**Суть:** для индикаторов из нескольких связанных пиктограмм (где важен общий pivot — точка в центре плюса, плюс внутри звезды и т.п.) **рисовать все кадры инлайн-SVG в одной системе координат** (`viewBox="0 0 24 24"`), не доверяя шрифтовым символам. Контейнер — `display: inline-flex; width: 1em; height: 1em; line-height: 1; vertical-align: middle`, SVG — `width="1em" height="1em"`. Цвет наследовать через `currentColor` (темизация автоматическая, в т.ч. под `text-vibe-warning`/`text-vibe-fg-2` и пр.). Кадр-state крутится через `useState` + `useEffect` с `setInterval`; cleanup интервала в return — обязателен. `prefers-reduced-motion: reduce` проверять через `window.matchMedia` и не запускать интервал — оставаться на первом кадре. Эмодзи (`❄` U+2744) для последнего кадра — отдельный геморрой с цветным эмодзи-рендером и пропорциональной шириной; SVG-снежинка из 4 линий через тот же центр (плюс + диагональный X) выглядит чище и наследует цвет.

**Применение:** любые индикаторы загрузки/прогресса/статуса с цикличной сменой пиктограмм, особенно когда нужно визуальное «прорастание одного символа из другого». Также — общее правило: если пытаешься выровнять Unicode-глифы между собой и метрики не сходятся за 2+ итерации, переключайся на SVG, не множи костыли в шрифтах.
