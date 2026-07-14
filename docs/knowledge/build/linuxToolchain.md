# Linux toolchain и сборка релиза

← [Knowledge Index](../README.md)

Пайплайн `scripts/release-linux.sh`: deb / rpm / AppImage / tar.gz для x64 + arm64, двухфазный флоу, кросс-сборка через Docker. Подпись артефактов — см. [distribution-signing-runbook](../../references-v1/distribution-signing-runbook.md) (раздел «Linux: ARM + GPG»).

---

## [сборка] Модель: 4 формата × 2 арки покрывают все дистрибутивы

Под Linux собирается **не N пакетов под N дистрибутивов**, а четыре универсальных типа артефакта на каждую архитектуру. Этого достаточно почти для всего:

| Формат | Кого закрывает |
|---|---|
| `.deb` | Debian, Ubuntu, Mint, Pop!_OS, elementary |
| `.rpm` | Fedora, RHEL, openSUSE, CentOS |
| `.AppImage` | любой дистрибутив, portable — «скачал и запустил», без установки |
| `.tar.gz` | portable-архив, дистрибутиво-независимый |

Архитектуры: `x64` и `arm64` (armhf/32-bit ARM для Electron-IDE мёртв — не собираем). Arch/Gentoo и прочее ставят из AppImage/tar.gz или через community-обёртку (AUR) вокруг того же tar.gz.

Реальные gulp-таргеты форка (`build/gulpfile.vscode.linux.ts` + `build/gulpfile.vscode.ts`): `vscode-linux-<arch>-min` (пакует приложение в `../VibeIDE-linux-<arch>`), затем `vscode-linux-<arch>-prepare-deb`/`build-deb` (через `dpkg-deb`), `-prepare-rpm`/`build-rpm` (через `rpmbuild`). AppImage gulp-таргета **нет** — его собирает сам `release-linux.sh` из упакованного дерева (`resources/linux/code.png` + генерируемые `.desktop`/`AppRun` по значениям `product.json`).

---

## [сборка] Где физически собирать — deb/rpm требуют Linux-тулчейн

`dpkg-deb`, `rpmbuild`, `fakeroot` существуют **только на Linux**. На macOS/Windows их нет, поэтому `release-linux.sh` имеет развилку по `uname`:

- **На Linux** — нативная сборка (основной путь, без Docker). Требует установленных `dpkg-dev`, `fakeroot`, `rpm`, `appimagetool`, `tar`, `gh` (+ `gcc-aarch64-linux-gnu`/`g++-aarch64-linux-gnu` для arm64 с x64-хоста). Отсутствие любого — fail-loud с командой установки, не тихий пропуск.
- **На macOS / Windows (Git-Bash) или по флагу `--docker`** — тяжёлая фаза делегируется в контейнер `ubuntu:22.04`: тот же скрипт запускается внутри с маркером `VIBE_LINUX_IN_DOCKER=1`. Host-`node_modules` — чужой платформы, поэтому контейнер делает свежий `npm ci`. Нужен установленный и запущенный Docker. На машине с малым ОЗУ (напр. Mac mini 16 ГБ) Docker-путь тяжёл — предпочтительнее реальный Linux-хост/VM.

Публикация из контейнера требует `gh`-аутентификации и git-identity внутри; штатный Docker-режим — Фаза 1 (`--skip-publish`), публикацию делать с хоста, где настроен `gh`.

---

## [сборка] Двухфазный флоу — как у Windows/macOS

Тот же принцип «собрал и протестировал → публикую ровно тот же билд», что в `release-windows.ps1` / `release-macos.sh`.

```bash
# Фаза 1 — бамп + компиляция + упаковка, без публикации:
./scripts/release-linux.sh -v vX.Y.Z --skip-publish
# Фаза 2 — публикация ТОГО ЖЕ билда без перекомпиляции:
./scripts/release-linux.sh --skip-compile
```

- Штамп версии пишется в `out-build/.vibe-build-version` на Фазе 1; Фаза 2 сверяет его → нельзя опубликовать чужую версию на старом коде.
- **Freshness-guard:** если `out-build` не перекомпилирован в этом прогоне и это не `--skip-publish`/`--skip-compile` — публикация отклоняется.
- **Release-readiness guard:** без записи «Что нового» в `vibeWhatsNew.ts` для версии и без совпадающего бейджа в `README.md` скрипт падает (общий foot-gun win/mac/linux).
- **Кросс-платформенный релиз одной версии:** запуск **без `-v`** собирает текущую версию `product.json` без бампа; если релиз тега уже создан Windows/macOS — Linux-артефакты **доливаются** в него (`gh release upload --clobber`), а не создаётся новый.

Полезные флаги: `--arch x64` (ограничить одной аркой), `--docker` (форсить контейнер), `--draft` (черновой релиз).

---

## [сборка] arm64 с x64-хоста — нужен cross-toolchain

Упаковка arm64 с обычного x64 Linux требует `gcc-aarch64-linux-gnu` + `g++-aarch64-linux-gnu` (gulp качает prebuilt arm64 Electron/нативные модули, но нативная пересборка идёт кросс-компилятором). Если тулчейна нет — скрипт **явно пропускает arm64 с предупреждением** и собирает только x64, а не падает и не тихо-молчит. Docker-путь ставит cross-toolchain автоматически.

Runtime-smoke (`bin/vibeide --version`) выполняется только когда арка исполнима на хосте (x64-бинарь на x86_64); для arm64 на x64-хосте smoke пропускается — проверять артефакт вручную на arm64-машине.

---

## [сборка] Подпись, манифест, зависимости X11

- **GPG-подпись опциональна** (зеркало `VIBE_MAC_SIGNING_IDENTITY`): при заданном `VIBE_GPG_KEY_ID` каждый артефакт получает `.asc` (`gpg --detach-sign --armor`); иначе — выпуск без подписи с предупреждением. Ключ мейнтейнера заводится разово (`gpg --gen-key` + публичная половина на `keys.openpgp.org`). Детали политики — [distribution-signing-runbook](../../references-v1/distribution-signing-runbook.md).
- **Манифест и суммы** — тот же `scripts/vibe-release-manifest.mjs`, что у win/mac → `release-manifest.json` + `checksums-sha256.txt` доливаются в релиз (нужны in-app updater'у).
- **X11-зависимости при `npm ci`** на Linux (`native-keymap` и др.) — см. [portableAndElectron.md](portableAndElectron.md), раздел «Linux CI / npm ci».

---

## [сборка] Первый прогон на чистой Linux-машине

```bash
# минимальный набор инструментов (Debian/Ubuntu):
sudo apt-get install -y dpkg-dev fakeroot rpm gcc-aarch64-linux-gnu g++-aarch64-linux-gnu
# appimagetool — с релизов AppImageKit (continuous), положить на PATH:
sudo curl -fsSL -o /usr/local/bin/appimagetool \
  https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
sudo chmod +x /usr/local/bin/appimagetool
# Node пинится .nvmrc через fnm/nvm (как на Windows/macOS).

# пробная сборка одной арки без публикации:
./scripts/release-linux.sh -v vX.Y.Z --arch x64 --skip-publish
```

Затем поставить получившийся `.deb`/`.AppImage` на чистой Ubuntu/Fedora VM — это и есть acceptance-smoke перед первой реальной публикацией.

**Применение:** onboarding Linux-сборки; диагностика «скрипт пропустил arm64/rpm»; кросс-сборка Linux с Windows или Mac.
