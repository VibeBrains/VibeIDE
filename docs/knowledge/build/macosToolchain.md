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

- **Манглер на 16 ГБ мака НЕ СОБИРАЕТСЯ ВООБЩЕ начиная с 1.10.0 — порог перейдён, подбирать heap бесполезно.** Манглер держит всю TS-программу + rename-edits и работает **в worker-потоке** (heap-лимит наследуется воркером). На кодовой базе 1.10.0 (10858 классов / 14519 экспортов) **измерено 2026-07-31, каждый потолок падает по-своему**:

  | `--max-old-space-size` | Исход |
  |---|---|
  | 8192 / 6144 | `Killed: 9` (SIGKILL, exit 137) — OS-OOM: пик RSS **8.36 ГБ** при доступных 5.2 ГБ |
  | 5120 | `Abort trap: 6` (exit 134) через **40 мин**: `FATAL ERROR: Ineffective mark-compacts near heap limit` — V8 сдался сам |
  | 4096 | `ERR_WORKER_OUT_OF_MEMORY` — воркеру мало его собственного лимита |

  **Окна между «мало воркеру» и «много машине» не существует.** Перезагрузка (чистый своп, 7.2 ГБ доступно, load 1) НЕ помогает — она лечила симптом старой версии, а не причину. **Решение (принято владельцем 2026-07-31): `VIBE_BUILD_MANGLE=0` — дефолт macOS**, скрипт берёт апстримную задачу `compile-build-without-mangling` (VS Code использует её для PR-сборок). Минификация esbuild остаётся, отключается только сокращение имён → бандл на единицы процентов крупнее, поведение идентично. **Эффект резкий:** компиляция+бандл прошли за ~2 минуты вместо 40, пик gulp **0.36 ГБ** вместо 8+. Включить обратно на машине с большей RAM — `VIBE_BUILD_MANGLE=1`.
  - Перед сборкой всё равно убить конкурирующие прожоры — **зависшие dev-IDE от смоук-тестов** (`pgrep -fl "code.sh|Electron|watcherMain"`), остатки убитой сборки (`pgrep -fl gulp`), сирот playwright (`pgrep -f chrome-headless-shell`).
  - Повтор после падения безопасен: при `-v`==`product.json` скрипт свой бамп-коммит не делает.
  - **Не верить exit-коду фоновой задачи — при `Killed` она рапортует 0; читать лог** (маркер успеха `Test build complete`, штамп `out-build/.vibe-build-version`).
- **husky pre-commit ломает бамп-коммит** внутри скрипта — воспроизведено на v1.9.0. Скрипт с `-v vX.Y.Z` правит `product.json`, затем `git commit` → pre-commit hygiene падает («`product.json: Contains 'extensionsGallery'`» — поле в репо намеренно, hygiene-правило апстрима на него ругается всегда), **скрипт умирает exit 1, оставив бамп staged**. Восстановление: `git commit --no-verify -m "chore: bump version to X.Y.Z"` руками, затем перезапустить сборку **без `-v`** (`--skip-publish`) — при совпадении версии в `product.json` скрипт свой бамп-коммит не делает и просто собирает. Профилактика: бампить `product.json` руками `--no-verify` ДО первого запуска скрипта.
- **Долгая фоновая сборка** переживает закрытие крышки/терминала: `nohup … & disown` + `caffeinate` (не даёт маку уснуть посреди сборки).
- **Перенос репо с Windows** (чужие `node_modules` по ОС/арх) — `run-dev.sh` детектит это и переустанавливает зависимости; для чистой сборки убедиться, что нативные модули собраны под macOS.

---

## [баг] Грабли релизного флоу (git + ноты) — не только мак

- **`origin/main` мог уйти вперёд, пока фичи копились в `next`** (догоняющая платформа пушит релиз-доки в main). На v1.9.0 локальный `main` был позади origin/main на 2 docs-коммита (Windows-догон 1.8.0), а ff-мерж `next`→`main` лёг на устаревший main → `git push` отбит non-fast-forward. **Лечение: `git fetch` перед мержем, затем `git merge origin/main` (мерж-коммит), НЕ `git rebase`.** Феч-коммиты `next` общие с origin/next; rebase переписал бы их хеши на main → истории платформ разъедутся (ровно то, от чего предостерегает правило веток в CLAUDE.md). Мерж-коммит сохраняет общие хеши. После релиза — синк обратно `main`→`next` (ff), чтобы `next` продолжался от выпущенного состояния.
- **Фаза 2 создаёт релиз с `--generate-notes`** (авто-список коммитов GitHub), а НЕ с курируемым форматом проекта. **Сразу после публикации заменить тело:** собрать ноты в файл (формат CLAUDE.md: секции с эмодзи + блок поддержки последним + QR на **VibeBrains**) и `gh release edit vX.Y.Z --notes-file <файл>`. НЕ править тело PowerShell-раундтрипом `gh view --jq .body | Set-Content` — на винде вывод режется на массив строк и markdown схлопывается в одну строку. Донат-фраза — по алгоритму `AGENTS.md`; если пул «Активные» в `docs/release-donation-phrases.md` пуст (был на v1.9.0) — сгенерировать тематическую, использовать, записать в «Историю использования», в «Активные»/«Отложенные» самовольно не добавлять.

---

## [баг] Форкнутый node-воркер: ДВА списка entry points, авторитетный — `build/next/index.ts` (esbuild)

**Контекст:** голосовой ввод в выпущенном macOS 1.9.0 не работал — микрофон ОС горит, но запись не включается. Диагноз (лог `.app`): `[vibeVoice worker] ERR_MODULE_NOT_FOUND: .../vibeide/node/voice/vibeVoiceWorkerMain.js`. В `.app` у `vibeide` был только слой `browser`; весь `node`-слой отсутствовал, при этом соседи-воркеры (`ptyHostMain`, `watcherMain`, `agentHostMain`, `telemetryApp`, …) на месте — выпал только voice.

**Суть (настоящая причина):** форкнутый воркер (UtilityProcess / `bootstrap-fork`) — **отдельная bundle-точка**, и таких списков **ДВА, они не синхронизируются автоматически**:
- **`build/buildfile.ts`** → `workbenchDesktop` — СТАРЫЙ путь (`optimize` / `build/lib/optimize.ts`).
- **`build/next/index.ts`** → `desktopEntryPoints` (строки 98-106) — НОВЫЙ esbuild-путь.

Какой авторитетен, решает флаг **`build/buildConfig.ts` → `useEsbuildTranspile`**. Сейчас он `true` → пакует esbuild через `build/next/index.ts`, а `buildfile.ts` — **мёртвый путь** (его регистрация ни на что не влияет). Voice worker был вписан ТОЛЬКО в `buildfile.ts` (мёртвый), в `desktopEntryPoints` его забыли — esbuild просто не бандлит модуль, которого нет в списке: **без warn, без skip, без ошибки**. Соседи были в обоих списках → попадали. Рантайм затем падает `ERR_MODULE_NOT_FOUND`, а UI молчит (аудио копится и дропается: `engine warm-up is slow — dropping oldest queued audio`). Урок: **наличие `.js` в `out-build` ≠ наличие в `.app`** — упаковку определяет список entry points, а не факт компиляции.

**Применение:** добавляешь новый форкнутый node-воркер — **впиши его в `build/next/index.ts` → `desktopEntryPoints`** (это то, что реально пакует `.app` при `useEsbuildTranspile=true`); в `buildfile.ts` — тоже, для legacy-пути. `serverEntryPoints` в `build/next/index.ts` — только для reh/server, desktop-воркеры туда не нужны. Страховка от повторения — **VERIFY-GATE** в обоих релиз-скриптах (`release-macos.sh` после `gulp vscode-darwin`, `release-windows.ps1` после `gulp vscode-win32`): массив `REQUIRED_WORKERS` / `$requiredWorkers` проверяется в собранном `.app`/`resources\app\out` ДО подписи/публикации; отсутствие → `die`/`throw`. Именно этот гейт поймал баг на первой пересборке 1.9.1 (воркер всё ещё отсутствовал) и доказал, что причина не в out-build. Проверять распакованный пакет, а не `out-build`. Переупаковка без перекомпиляции — `--package-only` (обходит дорогой манглер; `build/next/index.ts` грузится через tsx, компиляция `build/` не нужна).

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
