# Portable Windows + Electron + Linux CI

← [Knowledge Index](../README.md)

Portable ZIP-сборка без инсталлятора, Electron mirror при ECONNRESET, Linux CI X11 пакеты.

---

## [vscode] Portable Windows-билд без инсталлятора (`gulp`)

**Контекст:** первая «папочная» сборка для архива ZIP и запуска на другом ПК; ребрендинг имени каталога артефакта (2026).

**Суть:**
1. **Зависимости Copilot:** перед упаковкой выполнить **`npm install`** в **`extensions/copilot`** (builtin Copilot нужен **`@github/copilot`** в дереве источников). Полный билд клиента → **`npm run gulp vscode-win32-x64`**; только этап папки (если уже есть **`out-vscode`**) → **`npm run gulp vscode-win32-x64-ci`**.
2. **Где лежит папка:** не внутри git root — **`{dirname(repo)}/VibeIDE-win32-<arch>/`** (например **`VibeIDE-win32-x64`**). Имя задаётся в **`build/gulpfile.vscode.ts`** (`destinationFolderName`), те же префиксы **`VibeIDE-`** для **`linux`** / **`darwin`** в этом форке; смежные скрипты (**`gulpfile.vscode.win32.ts`**, **`gulpfile.vscode.linux.ts`**, **`build/azure-pipelines/**`**) синхронизированы. Старую соседнюю **`VSCode-win32-x64`** после апдейта можно удалить вручную. Запуск **`VibeIDE.exe`**.
3. **`vibeide-neon`** с **`contributes.commands`** при **`engines.vscode >= 1.74`** без **`main`** падает **vsce** при сборке — нужны **`activationEvents`** и **`main`**.

**Применение:** дистрибутив без MSI/Inno Setup; перенос ZIP на другой Windows x64 машину; поиск пути артефакта после upstream-merge (**`VSCode-${platform}-${arch}`** → **`VibeIDE-…`**).

---

## [сборка] Windows portable (ZIP без установщика)

**Контекст:** запрос переносимой сборки без Inno Setup (2026-05-05).

**Суть:** полная упаковка клиента — `npm run gulp vscode-win32-x64-min` или `vscode-win32-arm64-min`. Выходной каталог **`../VibeIDE-win32-<arch>`** относительно **корня репозитория** (родитель клона, см. `packageTask` в `build/gulpfile.vscode.ts`). ZIP как в CI: `build/azure-pipelines/win32/codesign.ts` — `7z a` по содержимому этой папки. Портативные профиль/extensions: рядом с приложением создать **`data`**, либо `VSCODE_PORTABLE` — см. `configurePortable` в `src/bootstrap-node.ts`. Инструкция для агента и оператора — скилл **`.vibe/skills/build-win-portable/SKILL.md`** (`/skill:build-win-portable`).

**Применение:** раздача «разархивировал и запустил»; не искать артефакт внутри клона.

---

## [провайдер] Electron preLaunch: ECONNRESET к GitHub release-assets

**Контекст:** `npm run electron` / `preLaunch.ts` качает zip с GitHub; на части каналов (DPI, нестабильный uplink) падает **`read ECONNRESET`** на `release-assets.githubusercontent.com` (2026-05).

**Суть:** **`build/lib/preLaunch.ts`** повторяет **`npm run electron`** до **`VSCODE_ELECTRON_DOWNLOAD_RETRIES`** (по умолчанию **5**) с нарастающей задержкой. Дополнительно можно направить **`@electron/get`** на зеркало: в **`scripts\\vibe-dev.bat`** задать **`VIBE_ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/`** (экспортируется в **`ELECTRON_MIRROR`**). Артефакты совпадают с **`build/checksums/electron.txt`**, если зеркало синхронизировано с релизом **`target`** из **`.npmrc`**.

**Применение:** при повторных обрывах загрузки Electron на Windows/macOS/Linux — ретраи или mirror; для PAT при вызовах API GitHub по-прежнему **`GITHUB_TOKEN`**.

---

## [vscode] Linux CI / `npm ci`: `native-keymap` и пакеты X11

**Контекст:** падение GitHub Actions на **`npm ci`**: `node-gyp` в **`native-keymap`**, `pkg-config` не находит **`x11`** и **`xkbfile`** (2026-05).

**Суть:** до установки зависимостей на **Ubuntu** нужны dev-пакеты: **`libx11-dev`**, **`libxkbfile-dev`** (плюс обычно **`build-essential`**, **`pkg-config`**, для Kerberos — **`libkrb5-dev`**). В upstream **`pr.yml`** (compile) это уже есть; в VibeIDE дополнительно выровняны **`perf-sla.yml`**, **`release.yml`**, **`pr-linux-test.yml`**, **`copilot-setup-steps.yml`**, **`monaco-editor.yml`**.

**Применение:** новый workflow с полным **`npm ci`** (не **`--ignore-scripts`**) на `ubuntu-*` — копировать тот же набор apt или ссылку на шаг из **`pr.yml`**.
