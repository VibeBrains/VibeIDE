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

- **Загаженный своп / нехватка памяти → тихие падения компиляции.** Перед Фазой 1 на слабой машине (напр. Mac mini 16 ГБ) — **перезагрузка мака**, чтобы сбросить своп; полная сборка VS Code прожорлива.
- **husky pre-commit ломает бамп-коммит** внутри скрипта. Если хук мешает — бампить `product.json` руками с `git commit --no-verify`, затем запускать сборку.
- **Долгая фоновая сборка** переживает закрытие крышки/терминала: `nohup … & disown` + `caffeinate` (не даёт маку уснуть посреди сборки).
- **Перенос репо с Windows** (чужие `node_modules` по ОС/арх) — `run-dev.sh` детектит это и переустанавливает зависимости; для чистой сборки убедиться, что нативные модули собраны под macOS.

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
