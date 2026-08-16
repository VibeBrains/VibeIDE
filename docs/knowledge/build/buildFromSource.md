# Домашняя сборка из исходников (`home-build`)

← [Knowledge Index](../README.md)

Скрипты `scripts/home-build*` — самосборка портативного VibeIDE под текущую машину, одной командой, для любого пользователя. Отдельно от релиз-пайплайна ([linux](linuxToolchain.md)/[macos](macosToolchain.md)/[windows](windowsToolchain.md)).

---

## [сборка] Что это и чем отличается от dev-запуска и от релиза

Три разных сценария «собрать», не путать:

| Сценарий | Команда | Итог |
|---|---|---|
| **Dev-запуск** | `./run-dev.sh --compile` / `.\run-dev.bat --compile` | Запускает IDE из `out/` для разработки. Не даёт переносимого артефакта. |
| **Домашняя сборка** | `./scripts/home-build.sh` / `scripts\home-build.cmd` | Портативная папка приложения + архив. Для «собрать себе и пользоваться». |
| **Релиз** | `./scripts/release-<os>.sh` / `release-windows.ps1` | Бамп версии, подпись, манифест, GitHub Release. Для мейнтейнера. |

Домашняя сборка — это релиз **без релизной обвязки**: нет бампа версии и правки `product.json`, git-коммитов/тегов, донат-фразы, release-readiness guard'ов, манифеста/сумм, подписи (на macOS остаётся только ad-hoc — иначе Apple Silicon не запустит `.app`), публикации, двухфазности.

---

## [сборка] Self-contained bootstrap + гейт намерений

Ключевое отличие от релиз-скриптов: home-build **сам поднимает окружение**, ничего не требуя заранее (кроме git и, на Windows, C++ тулчейна VS). Порядок:

1. **Гейт намерений** — печатает, что именно установит/сделает, и (в интерактивном шелле) спрашивает `[y/N]`. Флаг `--yes`/`-y` (или `HB_ASSUME_YES=1`) пропускает вопрос; неинтерактивный запуск **без** `--yes` намеренно прерывается (не ставить fnm/Node молча в CI).
2. **fnm** — если нет: macOS c Homebrew → `brew install fnm`; иначе Linux/macOS → официальный `curl … | bash -s -- --skip-shell` (без правки профиля пользователя); Windows → `winget install Schniz.fnm`. Свежий бинарь добавляется в `PATH` текущего процесса.
3. **Node** — версия из `.nvmrc` (с 1.15.1 — `24.18.0`, до неё была `22.22.1`): `fnm install`, затем каталог версии префиксуется в `PATH` (на Windows `fnm exec --using npm` ломается — резолвим путь и добавляем явно, см. [windowsToolchain.md](windowsToolchain.md)).
4. **Зависимости** — `npm ci`, если `node_modules/gulp` отсутствует (иначе пропуск, чтобы не тратить время на переустановку).

---

## [сборка] Компиляция и упаковка

После bootstrap:

- **Precompile** (то, что gulp не делает сам): `extract-vibeide-locale-strings` (non-fatal), `npm run gen:vibe-defaults`, `npm run buildreact`. Отдельный `compile-build` **не** нужен — gulp-таргет `vscode-<plat>-<arch>` компилирует TypeScript сам.
- **Упаковка:** `gulp vscode-linux-<arch>` / `vscode-darwin-<arch>` / `vscode-win32-<arch>` → папка `../VibeIDE-<plat>-<arch>` (на macOS внутри `VibeIDE.app`).
- **macOS:** патч версии в `Info.plist` из `product.json` (без бампа) **до** `codesign --force --deep --sign -` (ad-hoc обязателен — иначе не запустится).
- **Архив:** Linux → `tar.gz`; macOS → `zip` через `ditto` (сохраняет подпись); Windows → `Compress-Archive`. Всё в `.build/home/` (gitignore).

Архитектура — авто по хосту (`uname -m` / `PROCESSOR_ARCHITECTURE`), переопределяется `--arch x64|arm64`.

---

## [архитектура] Раскладка скриптов

```
scripts/home-build.sh          # dispatcher (Linux/macOS): uname → per-OS
scripts/home-build.cmd         # entry для Windows → home-build-windows.ps1
scripts/home-build-linux.sh    # per-OS: bootstrap + gulp vscode-linux-*   + tar.gz
scripts/home-build-macos.sh    # per-OS: bootstrap + gulp vscode-darwin-*  + ad-hoc sign + zip
scripts/home-build-windows.ps1 # per-OS: bootstrap + gulp vscode-win32-*   + zip
scripts/lib/home-build-common.sh  # общие bash-хелперы (гейт, bootstrap, precompile) — sourced linux/macos
```

Linux и macOS шарят `lib/home-build-common.sh` (DRY: гейт намерений, bootstrap fnm/Node/deps, precompile). Windows-скрипт самостоятелен — bash-библиотеку не переиспользовать, логика продублирована на PowerShell намеренно.

**Применение:** «дай собрать себе VibeIDE из исходников без возни»; онбординг контрибьютора на чистой машине; диагностика «что делает home-build и куда кладёт артефакт».
