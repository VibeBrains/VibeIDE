# Windows toolchain и нативные модули

← [Knowledge Index](../README.md)

VS C++ Build Tools, MSB8040 Spectre, native modules, ripgrep, `@vscode/vsce-sign`.

---

## [баг] npm install — требует Visual Studio C++ toolchain на Windows

**Контекст:** первая попытка `npm install` в VibeIDE repo на Windows.

**Суть:** `preinstall.js` проверяет наличие VS2022/VS2019 с C++ workload. Ошибка: `missing any VC++ toolset`. Нужно установить **Visual Studio Build Tools 2022** с workload **"Desktop development with C++"** (не просто "core features"). Команда: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet"`. После установки `npm install` работает нормально.

**Применение:** при настройке dev окружения на Windows.

---

## [vscode] Windows: `node-gyp` / MSB8040 Spectre-mitigated libraries

**Контекст:** локальный **`npm ci`** на Windows, сборка **`@vscode/deviceid`** (и др. нативные модули) падает с **MSB8040** (2026-05).

**Суть:** в **Visual Studio Installer → Modify → Individual components** нужно установить **MSVC v143 (или используемый toolset) — Spectre-mitigated libs** для нужной архитектуры. Без этого MSBuild отклоняет проект. Отдельно: **`EBUSY`** при очистке **`node_modules`** — закрыть процессы, держащие `.node` (запущенный Electron из репо, антивирус), затем повторить установку.

**Применение:** onboarding Windows dev и диагностика «сломался `npm ci` после обновления VS Build Tools».

---

## [vscode] Windows: нет .node / rg.exe после install (Electron native + ripgrep)

**Контекст:** `./run-dev.bat` с **`Could not locate the bindings file`** (`policy-watcher`, **`spdlog`**, **`windows-mutex`**, …), **`Cannot find ../build/Release/vscode-sqlite3.node`**, **`native-keymap`**, **`deviceid`/windows.node**, **`native-is-elevated`/iselevated**, **`@vscode/windows-registry`/winregistry**; **`spawn ... ripgrep\\bin\\rg.exe ENOENT`**. Частый корень — **`npm install --ignore-scripts`**, оборванный postinstall или ошибка node-gyp.

**Суть:** сборка должна быть для **Electron** (корневой `.npmrc`: `disturl=https://electronjs.org/headers`, `runtime=electron`, `target=…`). **MSB8040** — в нескольких `binding.gyp` / `deps/sqlite3.gyp` задано `SpectreMitigation`; без Spectre-библиотек в VS Build Tools сборка падает. В VibeIDE **`patch-package`** снимает это требование для: `@vscode/policy-watcher`, **`native-keymap`**, **`native-is-elevated`**, **`@vscode/windows-registry`**, **`@vscode/spdlog`**, **`@vscode/sqlite3`** (в т.ч. **`deps/sqlite3.gyp`**), **`@vscode/windows-mutex`**, **`@vscode/deviceid`** — см. **`patches/*.patch`**.

**Ручное:** из корня `npm rebuild` перечисленных пакетов; **`rg.exe`**: `node node_modules/@vscode/ripgrep/lib/postinstall.js --force` (ранний выход, если есть пустая `bin/`). Postinstall **`scripts/postinstall-windows-native-modules.mjs`**: проверка артефактов → **`npm.cmd rebuild`** недостающих → починка ripgrep.

**Применение:** первый локальный OSS на Windows, CI/клон без lifecycle scripts.

**Устарело:** узкая запись только про policy-watcher + `postinstall-rebuild-policy-watcher-win.mjs` — заменена набором патчей Spectre (см. **`patches/`**) и **`postinstall-windows-native-modules.mjs`**.

---

## [vscode] Проверка подписи расширений и `@vscode/vsce-sign`

**Контекст:** диалог «не удаётся проверить подпись» / «Проверка подписи не выполнена» при установке из Marketplace (2026-05).

**Суть:** `ExtensionSignatureVerificationService` делает `import('@vscode/vsce-sign')` и запускает бинарник `node_modules/@vscode/vsce-sign/bin/vsce-sign(.exe)` (распаковка из ASAR учтена в пакете). Если модуль не установлен или postinstall не скопировал exe — `verify` возвращает `undefined` → ошибка «Проверка подписи не выполнена». В корневом `package.json` нужна зависимость **`@vscode/vsce-sign`**; установка — **`npm install` без `--no-optional`** (нужен optional `@vscode/vsce-sign-win32-x64` и т.д.). Проверка: есть ли **`node_modules/@vscode/vsce-sign/bin/vsce-sign.exe`** (Windows). На Windows постинсталл **`scripts/postinstall-windows-native-modules.mjs`** при отсутствии exe запускает **`npm rebuild @vscode/vsce-sign`**.

**Применение:** после клона/CI без optional или с `--ignore-scripts` — переставить зависимости; релизная сборка должна включать тот же пакет в production `node_modules`.

---

## [сборка] Версия Node пинится `.nvmrc` — неверный мажор молча роняет `package-win32-x64`

**Контекст:** сборка VibeIDE на новой Windows-машине; `npm run gulp vscode-win32-x64` (и `release-windows.ps1`) молча падает на этапе **`package-win32-x64`** — `The following tasks did not complete: vscode-win32-x64` / `Did you forget to signal async completion?`, **без стека** даже с `--stack-trace` (2026-06).

**Суть:** TS-компиляция (esbuild/tsgo) проходит на **любой** ноде, поэтому ошибка обманывает — билд доходит до упаковки и только там умирает. Корень: **`gulp-atom-electron`** в `package-win32-x64` ломается на неверной **мажорной** версии Node и глотает ошибку стрима. Требуемая версия пинится в **`.nvmrc`** (на 1.2.2 — **`22.22.1`**); сборка на Node 24 даёт именно этот тихий фейл. Поднимать TS-компиляцию мало — упаковке нужна правильная нода.

**Управление версиями — через `fnm`** (не nvm-windows: тот завязан на симлинк `C:\Program Files\nodejs` и требует сноса standalone). `winget install Schniz.fnm`; `fnm install 22.22.1` (+ при желании `fnm install 24.16.0` — вернуть 24 под fnm).

Грабли Windows:
- **`fnm exec --using=<v> npm …` падает** `program not found` — fnm спавнит `npm` как exe напрямую, а это `npm.cmd` (PATHEXT не резолвится). Внутри `cmd`/pwsh `npm.cmd` работает штатно — гонять npm/gulp через шелл, не через `fnm exec` напрямую.
- **Standalone Node (MSI `OpenJS.NodeJS.*`) перебивает fnm в PATH** → `node -v` остаётся старым даже после `fnm use`. Снести standalone, тогда fnm — единственный источник. Uninstall MSI требует **elevation** (winget без админа → код **1603**); удалять из «Установка и удаление программ» или из админ-терминала.
- **Для скриптовой сборки надёжнее всего префиксовать PATH каталогом установки**, а не полагаться на `fnm env`-симлинк (в неинтерактивном шелле капризничает):
  `$node = Split-Path (fnm exec --using=22.22.1 node -e "process.stdout.write(process.execPath)"); $env:Path = "$node;$env:Path"` → дальше `node`/`npm.cmd`/gulp резолвятся в нужную версию (путь вида `…\AppData\Roaming\fnm\node-versions\v22.22.1\installation`).
- **Авто-переключение по `.nvmrc`:** в профиль PowerShell добавить `fnm env --use-on-cd | Out-String | Invoke-Expression` — при входе в проект нужная версия подхватывается сама (важно после апдейта базы VS Code, меняющего `.nvmrc`).

**Применение:** onboarding сборки на чистой Windows-машине; диагностика «`vscode-win32-x64 did not complete`» без стека (первым делом сверить `node -v` с `.nvmrc`); апдейт upstream VS Code, бампающий требуемый Node.

---

## [баг] Свежий `git init` без upstream → `release-windows.ps1` не пушит (голый `git push`)

**Контекст:** на чистой машине репозиторий подняли через `git init` + `git remote add origin` + ручные `git push origin main` (без `-u`). При Фазе 1 релиза скрипт забампил `product.json`, закоммитил, но `git push` упал: `fatal: The current branch main has no upstream branch` (2026-06).

**Суть:** `release-windows.ps1` делает **голый `git push`** (без `origin main`). Ручные `git push origin main` пушат, но НЕ ставят upstream-трекинг. Без upstream голый `git push` падает. Падение **не фатально** для скрипта (сборка продолжается), но bump-коммит остаётся НЕ запушенным — легко упустить.

**Применение:** сразу после `git init` на новой машине — `git push -u origin main` (или `git config --global push.autoSetupRemote true`). Тогда голый `git push` скрипта работает, и Фаза 2 (`git push origin vX.Y.Z` для тега — он явный, но upstream полезен в целом) проходит чисто. Если поймал «no upstream» в логе релиза — `git push -u origin main` вручную, артефакты при этом уже собираются.
