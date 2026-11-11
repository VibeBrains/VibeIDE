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

## [foot-gun] Без сети `npm run electron` опустошал `.build/electron` и падал (исправлено)

**Контекст:** 14.10.2026 `.build/electron/VibeIDE.app` оказался пустой оболочкой (`Contents/Resources/VibeIDE.icns` и больше ничего),
а `scripts/test.sh` и навык `launch` не нашли исполняемый файл. GitHub с этой машины не отвечал (`ConnectTimeoutError` на `github.com:443`).

**Что было:** `build/lib/electron.ts` (`npm run electron`) в `main` сначала стирал `.build/electron`, потом разрешал адрес ассета на GitHub
и качал zip. Обрыв на любом шаге оставлял заготовку без Electron. `preLaunch.ts` вызывал `npm run electron` безусловно, а проверка
«нужная версия уже стоит» (`isExpectedElectronInstalled`) стояла после цикла, который либо возвращал управление, либо завершал процесс, —
недостижимый код. Тот же стирающий вызов делали `scripts/test.sh`, `scripts/node-electron.sh` и `scripts/test.bat`.
Отдельно: ошибка скачивания шла не отказом промиса, а событием `error` на внутреннем потоке `@vscode/gulp-electron`, которое `pipe` дальше
не передаёт, — процесс падал необработанным исключением, и никакая очистка выполниться не успевала.

**Как теперь:**
- **Версия уже стоит — качать нечего.** `build/lib/electronInstall.ts` (чистые функции без сторонних импортов, поэтому `preLaunch.ts` берёт
  его до `npm ci`): `isExpectedElectronInstalled` сверяет файл `version` с версией из `.npmrc` (`target`) **и** проверяет, что исполняемый
  файл на месте (macOS — `<nameLong>.app/Contents/MacOS/<nameShort>`, Windows — `<nameShort>.exe`, Linux — `applicationName`: так их зовут
  `test.sh`, `test.bat`, `code.sh`). Папка с одним из двух — остаток обрыва, а не установка. Проверка стоит и в `electron.ts`, и в
  `preLaunch.ts`, поэтому покрыты все вызывающие: `preLaunch` (`code.sh`, `code-cli.sh`, `code-server.sh`, `code-agent-host.sh`, их `.bat`),
  `test.sh`, `node-electron.sh`, `test.bat`. Пропуск не работает, если архитектура в аргументе отличается от архитектуры процесса.
  Принудительно — `node build/lib/electron.ts --force` (нужно, когда поменялись запечённые в установку имена продукта, значки или типы документов).
- **Качается во временную папку.** `installDirectoryAtomically` пишет в `.build/electron.partial`, и только законченная и непустая папка
  подменяет `.build/electron` (старая на время подмены стоит как `.build/electron.old` и возвращается, если подмена не удалась). Обрыв
  оставляет прежнюю установку нетронутой, а при первой установке — вообще без `.build/electron`. Папка-заготовка убирается.
- **Ошибка понятная.** Одно сообщение: что не удалось скачать (с причиной вложенной ошибки, а не голое `fetch failed`), осталась ли прежняя
  установка, и что делать (сеть или `VIBE_ELECTRON_MIRROR`). `rejectOnUncaught` превращает ускользнувшее исключение потока в отказ промиса
  на время скачивания.

**Проверено (14.10.2026):** с установкой и мёртвым зеркалом `npm run electron` печатает «already holds Electron 42.8.0» и выходит за секунду,
`preLaunch.ts` проходит; `--force` с мёртвым зеркалом (отказ соединения, пять повторов `gulp-electron`) — код 1, сообщение, `.build/electron`
цела, `.partial` нет; то же без установки — `.build/electron` не создана; `--force` при сети — установка заменена настоящей
(`VibeIDE Helper*.app` вместо `Electron Helper*.app` в ручной оболочке). Тесты — `build/lib/test/electronInstall.test.ts`
(`node --test`, 6 штук): версия и исполняемый файл, неудачное скачивание не трогает старое, пустое скачивание — отказ, удачное заменяет.
**Не проверено:** Windows и Linux (имена исполняемых файлов взяты из скриптов запуска), обрыв посреди распаковки настоящего zip, два
одновременных запуска (имена `.partial`/`.old` общие, как были общими у прежнего стирания).

**Если папка всё же пуста** (старый клон, ручное вмешательство): `node build/lib/electron.ts --force` при сети; без сети — собрать оболочку
из кэша `@electron/get`: `~/Library/Caches/electron/<хеш>/electron-v<версия>-darwin-arm64.zip` (`ditto -x -k <zip> .build/electron`,
затем `Electron.app` → `VibeIDE.app`, `Contents/MacOS/Electron` → `Contents/MacOS/VibeIDE`, `CFBundleExecutable` через `PlistBuddy`, значок
`VibeIDE.icns` вернуть на место; `version` приезжает в zip). Запуск — `code.sh` с `VSCODE_SKIP_PRELAUNCH=1`.

---

## [vscode] Linux CI / `npm ci`: `native-keymap` и пакеты X11

**Контекст:** падение GitHub Actions на **`npm ci`**: `node-gyp` в **`native-keymap`**, `pkg-config` не находит **`x11`** и **`xkbfile`** (2026-05).

**Суть:** до установки зависимостей на **Ubuntu** нужны dev-пакеты: **`libx11-dev`**, **`libxkbfile-dev`** (плюс обычно **`build-essential`**, **`pkg-config`**, для Kerberos — **`libkrb5-dev`**). В upstream **`pr.yml`** (compile) это уже есть; в VibeIDE дополнительно выровняны **`perf-sla.yml`**, **`release.yml`**, **`pr-linux-test.yml`**, **`copilot-setup-steps.yml`**, **`monaco-editor.yml`**.

**Применение:** новый workflow с полным **`npm ci`** (не **`--ignore-scripts`**) на `ubuntu-*` — копировать тот же набор apt или ссылку на шаг из **`pr.yml`**.

---

## [окружение] Машина с доступом к API GitHub, но без доступа к CDN ассетов

**Контекст:** 11.11.2026, Windows-догон релиза 1.30.0. Фаза 1 падала трижды подряд, каждый раз на новом месте, и все три падения оказались одной причиной.

**Суть:** с этой машины **доступны** `api.github.com` (поэтому `gh release view`, `gh release upload` и сам пуш работают) и `marketplace.visualstudio.com`, но **недоступны по таймауту соединения**:

- `objects.githubusercontent.com` — туда редиректит `github.com/electron/electron/releases/download/...`;
- `release-assets.githubusercontent.com` — туда редиректит скачивание ассета нашего же релиза, в том числе через `gh release download`;
- `openvsx.eclipsecontent.org` — туда редиректит `open-vsx.org`, а это `extensionsGallery.serviceUrl` в нашем `product.json`.

Отсюда три разных симптома одной болезни: `TypeError: fetch failed` на `bundle-marketplace-extensions-build`, он же на `package-win32-x64`, и обрыв Фазы 2b на `Invoke-WebRequest`.

**Диагностика:** сообщение `fetch failed` не называет хост, и гадать по названию gulp-задачи бесполезно. Надёжный способ — запустить задачу с прологом, подменяющим `globalThis.fetch` на логирующую обёртку: `node --import file:///<путь>/traceFetch.mjs node_modules\gulp\bin\gulp.js <задача>`. Первый же прогон назвал `SHASUMS256.txt` и точный хост.

**Почему кэш не спасает:** `@electron/get` намеренно качает `SHASUMS256.txt` с `cacheMode: Bypass` («load them fresh every time»), поэтому положить файл сумм в `~/AppData/Local/electron/Cache/<хеш>/` бесполезно — архив берётся из кэша, а суммы всё равно идут в сеть, и падение происходит на них. Каталог кэша общий для архива и сумм: `Cache.getCacheDirectory` хэширует URL без имени файла.

**Чем лечится сейчас:**

- Electron — `VIBE_ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/` (экспортируется в `ELECTRON_MIRROR` в `build/lib/electron.ts`). Суммы зеркала совпали с запиненными в `build/checksums/electron.txt`.
- Встроенное расширение — скачать `.vsix` с `marketplace.visualstudio.com`, **сверить sha256 с записью в `product.json`** и распаковать содержимое `extension/` в `.build/builtInExtensions/<имя>/`, дописав `__metadata` из той же записи. Сверка обязательна: она и есть то, что делает ручную подкладку равноценной обычной загрузке.
- winget — `scripts/winget-release.ps1 -InstallerPath <путь к собранному exe>`: считает SHA256 с локального файла, предварительно сверив его размер с размером опубликованного ассета (размер читается через API, он доступен). Не совпал размер — отказ.

**Что остаётся дефектом:** суммы Electron вообще не должны ходить в сеть — `build/checksums/electron.txt` уже лежит в репозитории и содержит нужную строку. Правильный фикс — отдавать `SHASUMS256.txt` из него через существующий хук-резолвер `repo` у `@vscode/gulp-electron` (тот самый, которым работает `electronArtifactFeed`). Тогда зеркало перестанет быть нужным, а проверка останется настоящей.

**Применение:** любое `fetch failed` в сборке на этой машине — сперва трассировка `fetch`, потом сверка хоста с этим списком, а не поиск ошибки в коде задачи.

---

## [foot-gun] `vibe-release-lint` на Windows не запускал детектор нейрослопа

**Контекст:** 11.11.2026, правка нот релиза 1.30.0.

**Суть:** `scripts/vibe-release-lint.js:155` зовёт `spawnSync('npx', [...])` без `shell: true`. На Windows `npx` существует как `npx.cmd` и `npx.ps1`, но не как `.exe`, поэтому `spawnSync` всегда возвращает `ENOENT`, а линт печатает «The neural-slop check could not run» и **падает с кодом 1**. Проверки формата и блока поддержки при этом проходят, так что отличить «нет замечаний» от «детектор не стартовал» можно только по этой строке.

**Обход до фикса:** гнать детектор напрямую — `Get-Content <ноты> -Raw | npx tsx scripts/vibe-text-slop.ts --overrides scripts/slopHouseStyle.json -`.

**Применение:** обязательный гейт нот (`CLAUDE.md`) на Windows до сих пор не работал — считать ноты проверенными только после прямого прогона детектора или после фикса `shell: true`.
