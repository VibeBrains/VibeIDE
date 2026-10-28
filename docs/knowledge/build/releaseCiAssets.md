# Релизный CI: SBOM и образы macOS

← [Индекс базы знаний](../README.md)

## [грабли] В релизе 1.29.0 был пустой sbom.json и образы с чужим оформлением (2026-10-28)

**Контекст:** v1.29.0 собран workflow `release.yml` (а не `release-macos.sh`). В релизе нашлось три дефекта.

**1. Пустой SBOM (195 байт, `"components": []`; у v1.28.0 — 4 МБ)**
- Шаг «Generate SBOM» в `release.yml` писал заглушку с пустым списком и класть её в релиз
- Настоящий SBOM делает `sbom.yml`, но только по событию `release: published`
- Первый прогон `sbom.yml` по тегу v1.29.0 отработал честно: «SBOM generated with 1394 components», приложил файл (прогон 40456790255, 27.10)
- Потом `release.yml` перезапускали, пока чинили сборку; каждый прогон заново публиковал релиз и затирал `sbom.json` заглушкой (`overwrite_files` по умолчанию включён), а `sbom.yml` второй раз не запускался
- Сборка без `node_modules` тут ни при чём: причина — две разные реализации одного файла

**Как сделано:**
- `scripts/vibe-sbom.mts` — единый генератор для обоих workflow
- Зависимости берутся из `package-lock.json` (`cyclonedx-npm --package-lock-only`), `node_modules` и `npm install` не нужны
- Версия `@cyclonedx/cyclonedx-npm` закреплена (6.0.1)
- Меньше `MIN_NPM_COMPONENTS` (100) компонентов — скрипт падает, пустой SBOM больше не публикуется
- Тест `scripts/vibe-sbom.test.mts`; проверено на каталоге только с `package.json` и `package-lock.json`: 1515 компонентов
- Из `sbom.yml` убраны `npm install --ignore-scripts` и дублирующий Python

**2. Имена образов без версии (`VibeIDE-darwin-arm64.dmg`)**
- Так называет файл апстримовый `build/darwin/create-dmg.ts`; версию он не знает
- Теперь образ собирается сразу под именем `VibeIDE-<тег>-darwin-<arch>.dmg`, как ZIP и остальные пакеты того же CI-релиза (тег с `v`)
- Локальные `release-macos.sh` и `release-windows.ps1` называют файлы без `v` — расхождение осталось, на манифест не влияет (`release-manifest.json` берёт имя из файла)

**3. Образ 1.29.0 открывался окном «VS Code» с фоном апстрима (`#HAPPY_CODING!`)**
- Причина: CI-задача macOS звала `create-dmg.ts` (dmgbuild, стоковый фон и том «VS Code»), а наш `scripts/build-dmg-macos.sh` — только `release-macos.sh`
- Теперь CI зовёт `scripts/build-dmg-macos.sh`: том «VibeIDE», фон `build/darwin/dmg-background.svg` с версией, раскладка и гейты проверки образа
- Заодно CI-задача больше не отдаёт приложение с испорченной подписью: версия в `Info.plist`, строка про микрофон и подпись вынесены в `scripts/finish-macos-app.sh`, его зовут и CI, и `release-macos.sh`
- Страж `scripts/dmg-single-path.test.mts` (идёт первым шагом перед сборкой образа) падает, если `release.yml` или `release-macos.sh` вызовут `create-dmg.ts`
- Сам `create-dmg.ts` и стоковые фоны не удалены — это файлы апстрима, нужны для слияний

**Проверено:** `build-dmg-macos.sh` на готовом `VibeIDE.app` 1.29.0 — образ собран, внутренние гейты прошли (фон по sha256, версия, раскладка), том смонтировался как `/Volumes/VibeIDE` с `.background`, `Applications`, `VibeIDE.app`. `finish-macos-app.sh` на копии приложения — версия записана, подпись переставлена.
**Не проверено:** сам CI-прогон (`brew install librsvg` и venv на раннерах `macos-15-intel` / `macos-latest`, `sbom` на `ubuntu-latest`) — workflow проверен только `actionlint`.
