# macOS toolchain и сборка релиза

← [Knowledge Index](../README.md)

Пайплайн `scripts/release-macos.sh`: `.app` → `.dmg` + `.zip` для arm64, двухфазный флоу, подпись (ad-hoc / Developer ID). Notarization — см. [distribution-signing-runbook](../../references-v1/distribution-signing-runbook.md) (раздел «macOS: Notarization»).

---

## [сборка] Формат: DMG + ZIP, пока только arm64

Под macOS собирается **`.dmg`** (образ для установки drag-to-Applications) и **`.zip`** (portable). Оба — из одного `VibeIDE.app`. Universal Binary (arm64 + x64 через `lipo`) отложён — `scripts/build-macos-universal.sh` пока skeleton; текущий пайплайн собирает **только arm64** (`release-macos.sh` падает на не-arm64 хосте намеренно).

Реальный gulp-таргет: `vscode-darwin-arm64` → пакует `../VibeIDE-darwin-arm64/VibeIDE.app`. DMG собирается через `hdiutil` (zero-dep), ZIP — через `ditto` (сохраняет подпись/xattrs). Скрипт `build/darwin/create-dmg.ts` не используется — ему нужен Python ≥3.10, которого на build-машине нет; `hdiutil` его заменяет.

---

## [сборка] Двухфазный флоу — как у Windows/Linux

```bash
# Фаза 1 — бамп + компиляция + упаковка, без публикации:
./scripts/release-macos.sh -v vX.Y.Z --skip-publish
# Фаза 2 — публикация ТОГО ЖЕ билда без перекомпиляции:
./scripts/release-macos.sh --skip-compile
```

- Штамп версии в `out-build/.vibe-build-version` (Фаза 1) сверяется на Фазе 2 → нельзя опубликовать чужую версию на старом коде. Freshness + release-readiness guard'ы те же, что у win/linux.
- **`--package-only --skip-publish`** — возобновить Фазу 1 после падения на этапе упаковки: переиспользует заштампованный `out-build` (штамп должен совпасть), гоняет только gulp package + подпись + DMG/ZIP + smoke.
- **Кросс-платформенный релиз одной версии:** запуск **без `-v`** собирает текущую версию `product.json` без бампа; если релиз тега уже создан Windows — мак-артефакты **доливаются** в него (`gh release upload`), а не создаётся новый.

Требования: `fnm` (Node из `.nvmrc`), `gh` (`brew install gh`), Xcode Command Line Tools.

---

## [сборка] Подпись: ad-hoc по умолчанию, Developer ID опционально

Apple Silicon **отказывается запускать бинарь с невалидной подписью**, а gulp-постобработка ломает исходную ad-hoc подпись Electron — поэтому `.app` **всегда переподписывается**:

- **Без `VIBE_MAC_SIGNING_IDENTITY`** — ad-hoc (`codesign --sign -`). Gatekeeper при первом запуске требует **«Open Anyway»** (System Settings → Privacy & Security). Это надо упоминать в release notes мак-релизов.
- **С `VIBE_MAC_SIGNING_IDENTITY`** — Developer ID + hardened runtime (`codesign --options runtime --timestamp`). Notarization — отдельный ручной шаг (`scripts/notarize-macos.sh`), env-переменные (`APPLE_ID`/`APPLE_TEAM_ID`/`APPLE_APP_PASSWORD`/`VIBE_MAC_NOTARIZE`) — в [distribution-signing-runbook](../../references-v1/distribution-signing-runbook.md).

Подпись накладывается **до** сборки DMG/ZIP; патч версии в `Info.plist` (`CFBundleShortVersionString`/`CFBundleVersion` → `vibeVersion`) делается тоже до `codesign`, иначе подпись инвалидируется. Runtime-версия (`package.json`/`vscode.version`) намеренно остаётся `1.118.x` для совместимости расширений — Finder/Get Info при этом показывает продуктовую версию через пропатченный plist.

---

## [баг] Грабли мак-сборки (эмпирика)

- **Загаженный своп / нехватка памяти → `compile-build-with-mangling` убивается ядром (`Killed: 9`) на пике манглера.** Манглер держит всю TS-программу + rename-edits (пик до ~8 ГБ) — на 16 ГБ RAM с забитым свопом (3+ ГБ) OS-OOM его сносит. **Порядок действий (2026-07-16, уточнение):** (1) убедиться, что нет конкурирующих прожор — особенно **зависших dev-IDE от смоук-тестов** (`pgrep -fl "code.sh|Electron|watcherMain"`) и остатков убитой сборки (`pgrep -fl gulp`); убить их; (2) **повторить сборку — часто проскакивает со 2-й попытки** (git-часть уже сделана, повтор безопасен: скрипт при `-v`==product.json свой бамп не коммитит). (3) Если не помогает — **перезагрузка мака** обнуляет своп (пик свопа сборки ~2 ГБ). `sudo purge` требует пароль → в неинтерактиве недоступен. **Не верить exit-коду фоновой задачи — при `Killed` она рапортует 0; читать лог** (маркер успеха `Test build complete`, штамп `out-build/.vibe-build-version`).
- **husky pre-commit ломает бамп-коммит** внутри скрипта — воспроизведено на v1.9.0. Скрипт с `-v vX.Y.Z` правит `product.json`, затем `git commit` → pre-commit hygiene падает («`product.json: Contains 'extensionsGallery'`» — поле в репо намеренно, hygiene-правило апстрима на него ругается всегда), **скрипт умирает exit 1, оставив бамп staged**. Восстановление: `git commit --no-verify -m "chore: bump version to X.Y.Z"` руками, затем перезапустить сборку **без `-v`** (`--skip-publish`) — при совпадении версии в `product.json` скрипт свой бамп-коммит не делает и просто собирает. Профилактика: бампить `product.json` руками `--no-verify` ДО первого запуска скрипта.
- **Долгая фоновая сборка** переживает закрытие крышки/терминала: `nohup … & disown` + `caffeinate` (не даёт маку уснуть посреди сборки).
- **Перенос репо с Windows** (чужие `node_modules` по ОС/арх) — `run-dev.sh` детектит это и переустанавливает зависимости; для чистой сборки убедиться, что нативные модули собраны под macOS.

---

## [баг] Грабли релизного флоу (git + ноты) — не только мак

- **`origin/main` мог уйти вперёд, пока фичи копились в `next`** (догоняющая платформа пушит релиз-доки в main). На v1.9.0 локальный `main` был позади origin/main на 2 docs-коммита (Windows-догон 1.8.0), а ff-мерж `next`→`main` лёг на устаревший main → `git push` отбит non-fast-forward. **Лечение: `git fetch` перед мержем, затем `git merge origin/main` (мерж-коммит), НЕ `git rebase`.** Феч-коммиты `next` общие с origin/next; rebase переписал бы их хеши на main → истории платформ разъедутся (ровно то, от чего предостерегает правило веток в CLAUDE.md). Мерж-коммит сохраняет общие хеши. После релиза — синк обратно `main`→`next` (ff), чтобы `next` продолжался от выпущенного состояния.
- **Фаза 2 создаёт релиз с `--generate-notes`** (авто-список коммитов GitHub), а НЕ с курируемым форматом проекта. **Сразу после публикации заменить тело:** собрать ноты в файл (формат CLAUDE.md: секции с эмодзи + блок поддержки последним + QR на **VibeBrains**) и `gh release edit vX.Y.Z --notes-file <файл>`. НЕ править тело PowerShell-раундтрипом `gh view --jq .body | Set-Content` — на винде вывод режется на массив строк и markdown схлопывается в одну строку. Донат-фраза — по алгоритму `AGENTS.md`; если пул «Активные» в `docs/release-donation-phrases.md` пуст (был на v1.9.0) — сгенерировать тематическую, использовать, записать в «Историю использования», в «Активные»/«Отложенные» самовольно не добавлять.

---

## [баг] Форкнутый node-воркер может молча выпасть из бандла → VERIFY-GATE целостности

**Контекст:** голосовой ввод в выпущенном macOS 1.9.0 не работал — микрофон ОС горит, но запись не включается. Диагноз (лог `.app`): `[vibeVoice worker] ERR_MODULE_NOT_FOUND: .../vibeide/node/voice/vibeVoiceWorkerMain.js`. В `.app` у `vibeide` был только слой `browser`; весь `node`-слой отсутствовал, при этом соседи по списку `workbenchDesktop` (`ptyHostMain`, `watcherMain`, `agentHostMain`, …) на месте — выпал только voice.

**Суть:** форкнутый воркер (UtilityProcess / `bootstrap-fork`, entryPoint `vs/workbench/contrib/vibeide/node/voice/vibeVoiceWorkerMain`) — это **отдельная bundle-точка**, перечисленная в `build/buildfile.ts` → `workbenchDesktop`. Ключевой урок: **наличие `.js` в `out-build` ≠ наличие в `.app`**. Полная компиляция всегда `rimraf out-build` + пересборка (`build/gulpfile.compile.ts`), но `.app` пакуется отдельным шагом `gulp vscode-darwin`, и если он отработал по **неполному/устаревшему `out-build`** (напр. сборка через `--skip-compile`/`--package-only`, или частичная сборка), новый воркер тихо не попадает в пакет — рантайм падает `ERR_MODULE_NOT_FOUND`, а UI **не показывает ошибки** (аудио просто копится и дропается: `engine warm-up is slow — dropping oldest queued audio`). macOS-скрипт это усугублял: для `--skip-publish` он явно разрешает stale `out-build` («package may contain stale code»), тогда как Windows-скрипт в той же ветке падает.

**Применение:** оба релиз-скрипта после сборки пакета (`release-macos.sh` после `gulp vscode-darwin`, `release-windows.ps1` после `gulp vscode-win32`) содержат **VERIFY-GATE**: массив `REQUIRED_WORKERS` / `$requiredWorkers` (сейчас `vibeVoiceWorkerMain.js`) проверяется в собранном `.app`/`resources\app\out` ДО подписи/публикации; отсутствие → `die`/`throw` с требованием пересобрать полной Фазой 1. **Добавляешь новый форкнутый node-воркер — впиши его в оба списка**, иначе тот же класс бага повторится молча. Проверять именно распакованный пакет, а не `out-build`.

---

## [сборка] Первый прогон

```bash
brew install fnm gh          # Node-пиннинг + GitHub CLI
xcode-select --install       # Command Line Tools (если ещё нет)

# пробная сборка без публикации:
./scripts/release-macos.sh -v vX.Y.Z --skip-publish
# → артефакты в .build/darwin-arm64/VibeIDE-<ver>-darwin-arm64.{dmg,zip}
```

Открыть DMG, перетащить в Applications, запустить (при ad-hoc — «Open Anyway») — это acceptance-smoke перед реальной публикацией. Сам скрипт делает CLI-smoke (`bin/vibeide --version`) автоматически.

**Применение:** onboarding мак-сборки; диагностика «падает на не-arm64» / «Gatekeeper блокирует запуск»; кросс-платформенный релиз одной версии вслед за Windows.
