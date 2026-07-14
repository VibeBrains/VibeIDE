# Compile, sync upstream, dev runner

← [Knowledge Index](../README.md)

`tsgo exit 2`, синхронизация форка без общего предка, `run-dev` / `vibe-dev`.

---

## [vscode] `npm run compile` / tsgo exit 2 (VibeIDE)

**Контекст:** падение gulp `compile` с `Error: tsgo exited with code 2` после успешных строк по расширениям (2026-05-04).

**Суть:** задача `compile` параллелит сборку расширений и клиента (`src/tsconfig.json`). Ошибка может быть только в основном workbench, без явного дампа в консоли — диагностика: `npx tsgo --project src/tsconfig.json --noEmit`.

Частые причины в форке:
- не собран React (`npm run buildreact`),
- у `.js` бандлов в `react/out/**/index.js` нет типов — держать рядом hand-written `index.d.ts`,
- апстрим VS Code: нет `WorkbenchPhase.Restored` (использовать `AfterRestored`), уведомления закрываются через `INotificationHandle.close()`, нет `ConfigurationScope.WORKSPACE` (для workspace settings — `RESOURCE`), нет `asRelativePath` на `IWorkspaceContextService` — `relativePath` из `base/common/resources.js`, превью вкладки — `ITextEditorOptions.transient`, не `preview`.

**Применение:** локальная проверка перед полным `npm run compile`.

---

## [vscode] Синхронизация форка без общего предка + CortexIDE React на Windows

**Контекст:** переход дерева на microsoft/vscode **1.118.1** при отсутствии общего предка с upstream.

**Суть:** рабочий путь — `git merge refs/tags/1.118.1 --allow-unrelated-histories` и выравнивание `src/` + оверлей Vibe/Cortexide; при fetch с LFS объектами Copilot — **`GIT_LFS_SKIP_SMUDGE=1`**. **`git checkout <tag> -- path` не удаляет** устаревшие файлы в каталоге — для крупных перестроек (`contrib/chat`, `vscode-dts`, `inlineCompletions`) безопаснее **`rm -rf … && git checkout <tag> -- …`**. Лишние **`vscode.proposed.*`** не из тега дают рассинхрон с `extHost` (например обязательный `registerRelatedFilesProvider` в типах без реализации). В корне держать **`gulpfile.mjs`**, не **`gulpfile.js`**; **`build/`** без наследуемых **`.js`** дубликатов при **`build/package.json` → `"type":"module"`** и **`gulpfile.ts`**. После 1.118.x **все `IRequestService.request` требуют `callSite`**.

**`npm run buildreact`:** **`tailwindcss@3`**; **`browser/react/build.js`** — дополнять **`PATH`** через **`node_modules/.bin`**; для tsup — перечисленные peer-пакеты; **`overrides.postcss`**. React-хелперы: **`@ts-nocheck`** + exclude в **`src/tsconfig.json`**.

**Применение:** следующий крупный sync и локальная сборка React на Windows.

---

## [agent] Итерационный workflow: `.\run-dev.bat --compile` (НЕ watch)

**Контекст:** при правках в `src/` агент чинит баг → нужно проверить в живом приложении. Полный installer build через `release-windows.ps1` занимает 8-10 мин, что слишком долго для итераций.

**Суть:**
- **Правильный цикл:** `.\run-dev.bat --compile` — флаг сам делает `npm run compile` (~1-3 мин, инкрементальный gulp compile; при падении компиляции запуск отменяется) → запуск Electron-окна с обновлёнными `out/`. (Эквивалент прежнего `npm run compile && .\run-dev.bat`.) Без флага `--compile` — запуск уже собранного `out/` без перекомпиляции.
- **`npm run watch` — НЕ использовать.** Эмпирически (фидбэк пользователя 2026-05-16) watcher не всегда подхватывает изменения; правки в коде иногда не отражаются в работающем процессе. Корневая причина не диагностирована; до выяснения — workflow через явный `compile` + перезапуск `run-dev`.
- **Полный `release-windows.ps1` — ТОЛЬКО для релизов.** Не использовать для проверки фиксов; пользователь явно об этом просил, чтобы не «гонять билды зря».

**Применение:** дефолтный цикл проверки после правок в `src/vs/workbench/contrib/vibeide/**`. Если меняются файлы в `extensions/` — `npm run gulp compile-extensions`. Если React (`browser/react/src/**`) — `npm run buildreact && npm run compile`.

---

## [vscode] Запуск dev VibeIDE (Windows): `run-dev`, `vibe-dev`, резерв в `bin/`

**Контекст:** единая точка входа для разработчика; при **merge upstream VS Code** содержимое **`scripts/`** может быть перезаписано чужими **`code.bat`** / одноимёнными файлами — кастомный пайплайн VibeIDE нужно не потерять.

**Суть:**
- **Обычный запуск из корня репозитория:** `run-dev.bat` → вызывает **`scripts\vibe-dev.bat`** (рабочий каталог — корень репо после `cd`).
- **`run-dev.bat --clear`** (ещё **`-clear`**, **`/clear`**) — перед запуском удаляет **`%APPDATA%\vibeide-dev-dev`** и **`%LOCALAPPDATA%\vibeide-dev-dev`** (это реальный dev user-data: **`main.ts`** задаёт **`VibeIDE Dev`** → **`getUserDataPath`** → папка **`vibeide-dev-dev`**), плюс legacy **`vibeide-dev`** в тех же корнях, **`%USERPROFILE%\.vibeide-shared`**, **`%USERPROFILE%\.vibeide`**. Сбрасывается онбординг / приветствие с выбором провайдера (**`isOnboardingComplete`** и зашифрованное состояние в user-data). Флаги очистки до Electron не пробрасываются. Остальные аргументы — как у **`scripts\code.bat`**.
- **Инкрементальный путь:** если **`out/`** уже содержит результат **`npm run compile`** (gulp-бандл **`workbench.desktop.main.js`**, хук VibeIDE, NLS) — **`transpile-client` по умолчанию не вызывается**, чтобы не подменять бандл разрозненным ESM (иначе в Electron падает **`import(...workbench.desktop.main.js)`** и массово **MIME `text/css`** для `*.css`). Принудительный быстрый транспайл: **`set VIBE_USE_TRANSPILE_CLIENT=1`**. Иначе **`npm run compile`**. Переменные: **`VIBE_SKIP_REACT`**, **`VIBE_SKIP_NLS`** и др. (см. REM в **`scripts\vibe-dev.bat`**).
- **Резервная копия логики запуска:** **`bin\run-dev.bat`** и **`bin\vibe-dev.bat`** — та же семантика; **`bin\vibe-dev.bat`** после **`cd`** использует **`REPO_ROOT`** → **`scripts\code.bat`** и **`scripts\vibe-dev-clear-nls-clp.mjs`**. **Зачем:** после синка с апстримом, если **`scripts\vibe-dev.bat`** затёрт или потерян, восстановить поведение можно из **`bin/`**, затем вернуть файл в **`scripts/`**. Держать **`bin`** и **`scripts`** по логике синхронно при изменениях.
- **Пути в batch:** после **`cd /d "%~dp0.."`** задаётся **`set "REPO_ROOT=%CD%"`**; вызовы **`node …\vibe-dev-clear-nls-clp.mjs`** и **`code.bat`** используют **`!REPO_ROOT!\scripts\…`** (с delayed expansion). **`%~dp0` внутри блоков `(...)`** у **`cmd.exe`** может разрешаться неверно → ошибки вида «Cannot find module …\vibe-dev-clear-nls-clp.mjs» в корне репо и **`code.bat`** не из **`scripts\`**.

**Применение:** onboarding, документация для агента, восстановление после sync VS Code.

---

## [vscode] MCP migration + `settings.json` с UTF-8 BOM (code-oss-dev)

**Контекст:** в DevTools консоли OSS — **`MCP migration: Failed to parse ... settings.json: Unexpected token 'я╗┐'`** (символы — это **BOM** EF BB BF в UTF-8).

**Суть:** файл **`%APPDATA%\\code-oss-dev\\User\\settings.json`** (или путь из лога `vscode-userdata:...`) сохранён как **UTF-8 with BOM**; встроенный **`JSON.parse`** падает на первом символе. Исправление: пересохранить **UTF-8 без BOM** или убрать первые три байта `EF BB BF`.

**Применение:** после любого редактирования настроек редактором, который по умолчанию пишет BOM (часть Windows-редакторов / «Save with encoding»). См. также [runtimeQuirks/pathAndUri.md](../runtimeQuirks/pathAndUri.md).

---

## [архитектура] Lockfile в `extensions/*` при форке VS Code

**Контекст:** ревью `docs/idea.md` и git status с множеством неотслеживаемых `extensions/*/package-lock.json`.

**Суть:** в дереве VS Code часто смешивают корневой lockfile и установку зависимостей отдельных расширений; при кастомных скриптах и `npm install` в подпапках появляются локальные lock-файлы — риск шума в PR, рассинхрона с upstream и путаницы для контрибьюторов без явной политики (что коммитить, что в `.gitignore`, как CI проверяет детерминизм).

**Применение:** зафиксировать стратегию в roadmap (**секция G**) и в CONTRIBUTING перед массовым `git add` lock-файлов.

---

## [build] Недетерминированный `vibeDefaultsManifest.generated.ts` между Windows и macOS (CRLF)

**Контекст:** в рабочей копии на Mac фантомно «модифицирован» `vibeDefaultsManifest.generated.ts` — дифф на 65 КБ, но по сути только `\r\n` → `\n` во встроенных строках (2026-07-13).

**Суть:** `scripts/gen-vibe-defaults.mjs` встраивает содержимое файлов `.vibe-defaults/**` строковыми литералами в TS-манифест (`JSON.stringify` → внутри `.ts` появляются экранированные `\r\n`, это НЕ байты-терминаторы, поэтому git `text=auto`/eol-нормализация их не трогает). Источники под `.vibe-defaults` при `* text=auto` выкладываются на Windows как **CRLF**, на macOS как **LF**. Генератор читал байты рабочего дерева как есть → манифест, собранный на Windows, содержал `\r\n`, собранный на Mac — `\n`. Каждая регенерация на «другой» ОС переворачивала весь файл → вечный шум-дифф.

**Фикс (детерминизм источника, а не заглушка):**
- `gen-vibe-defaults.mjs`: `contents = (await fs.readFile(...)).replace(/\r\n/g, '\n')` — встраиваем всегда LF.
- `.gitattributes`: `.vibe-defaults/** text eol=lf` — пиннит рабочее дерево источников к LF на всех ОС.

**Грабль:** `git show HEAD:file` применяет smudge-фильтры текущих `.gitattributes` — для точной проверки сырого блоба использовать `git cat-file -p HEAD:file`. Проверка «чисто ли LF»: `grep -c '\r\n' <манифест>` (0 = ок).

**Применение:** любой генератор, встраивающий байты файлов в исходник, обязан нормализовать переносы строк — иначе артефакт недетерминирован между платформами.
