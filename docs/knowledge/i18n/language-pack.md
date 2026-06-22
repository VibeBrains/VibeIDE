# Russian language pack — vscode-loc, core pack, мнемоники

← [Knowledge Index](../README.md)

`vscode-loc` vs VSIX, встроенный core language pack до появления `languagepacks.json`, `&&` мнемоники в кнопках.

---

## [vscode] Русский UI: vscode-loc vs VSIX и согласование версий

**Контекст:** подключение [microsoft/vscode-loc](https://github.com/microsoft/vscode-loc) к VibeIDE.

**Суть:** `vscode-loc` — только исходники/экспорт строк; в IDE попадают **готовые** расширения `MS-CEINTL.vscode-language-pack-*`. Для форка их пиннут в `product.json` → `builtInExtensions`, качаются с галереей из `extensionsGallery` (у нас Open VSX). Версия пакета должна соответствовать линии `package.json` IDE (`engines.vscode`), иначе пропуски переводов или несовместимость. Upstream при `VSCODE_DEV` отключает NLS language packs — в VibeIDE в `scripts/code.*` включают `VIBEIDE_LANGUAGE_PACK_IN_DEV=1`, а при отсутствии `product.commit` в dev подставляется `git HEAD` в `bootstrap-meta.ts`.

**Применение:** обновление RU после релиза Microsoft — см. `docs/v1/language-pack-russian.md`, править `version` + `sha256` из Open VSX API. На англоязычной ОС без `--locale ru`/`argv.locale` интерфейс остаётся EN; редактор Cursor/Retail VS Code наш language pack из репозитория не подхватывает.

---

## [vscode] Встроенный core language pack до появления languagepacks.json

**Контекст:** `resolveNLSConfiguration` в main до полного скана расширений shared process; на первом старте `languagepacks.json` может быть пустым.

**Суть:** VibeIDE вшивает **`extensions/vscode-language-pack-ru/`** (официальный **полный** пакет MS-CEINTL с Open VSX: все `translations/*.json` + корректный `package.json`). Раньше в репо мог торчать урезанный вариант с одним `main.i18n.json` в манифесте — это ломало сопоставление ключей NLS и давало «чужие» подписи в UI.

**Обновление:** **`npm run sync-language-pack-ru`** (скачивает VSIX версии = корневой **`package.json` → `version`**, либо **`node scripts/sync-vscode-loc-ru.mjs --version X.Y.Z`**). После обновления при артефактах в **`clp`** — удалить **`%APPDATA%\…\vibeide*-dev\clp\`** и перезапустить Electron. `nls.ts` резолвит путь от **`nlsMetadataPath`** как **`../extensions/...`**.

Продуктовый default UI language — **`product.defaultLocale`** (сейчас **`ru`**); приоритет: **`--locale`** → **`locale` в argv.json** → **`defaultLocale`**.

**Важно:** в апстриме **`bootstrap-esm.ts`** при **`VSCODE_DEV`** не подгружались **`_VSCODE_NLS_MESSAGES`** вообще — в dev из репо интерфейс оставался английским; VibeIDE убрал эту проверку, чтобы RU работал и в dev-сборке.

**Баг (исправлен):** корневой **`main.ts`** брал **`product.nameShort`** без суффикса **`Dev`**, а **`EnvironmentMainService`** считает user data от **`IProductService.nameShort`** = **`… Dev`** (`product.ts`) — получались два каталога (**`…\vibeide-dev`** vs **`…\vibeide-dev-dev`**): NLS/`clp` и профиль разъезжались, скрипт очистки **`clp`** бил не ту папку. Нужно совпадение строки для **`getUserDataPath`** с dev-продуктом (см. **`main.ts`** комментарий у **`userDataPath`**).

**Применение:** форки с не-английским дефолтом и без обязательной установки MS Language Pack с Marketplace.

**Доп.:** после фикса **`compile-client`** в **`build/gulpfile.ts`** (`compileTask(..., build: true, { disableMangle, preserveEnglish })`) файлы **`nls.keys.json`** / **`nls.messages.json`** попадают в **`out/`** при обычном **`npm run compile`**. Раньше при `build: false` шаг **`nls()`** не вызывался — локализация была невозможна. В **`main.ts`** путь к метаданным: сначала **`out`**, затем **`../out-build`** (CI/legacy).

**Dev (`vibe-dev`):** если в логе экстрактора «N NLS entries» порядка единиц → **`out/nls.keys.json`** почти пустой (старый/битый экстрактор); **`resolveNLSConfiguration`** мог уже записать крошечный **`nls.messages.json`** в **`%APPDATA%\<product>-dev\clp\...`** и при следующих стартах **не пересобирает** перевод, пока файл в **`clp`** существует. Лечение: актуальный **`scripts/vibe-nls-extract.ts`** (regex, ~19k записей) → **`npx tsx scripts/vibe-nls-extract.ts`** → удалить **`...\Roaming\vibeide-dev-dev\clp\`** (или **`clp/vibeide-builtin.ru`**) → полный перезапуск Electron.

**Dev `product.commit`:** при **`VSCODE_DEV`** и пустом **`commit`** в продукте **`bootstrap-meta.ts`** задаёт **`git rev-parse HEAD`** (cwd = корень репо); в **`nls.ts`** ранний откат в EN для сочетания «нет bundled и нет commit» не применяется в dev — можно дойти до **`languagepacks.json`** без обязательного retail-commit.

---

## [баг] `&&` мнемоники в кнопках нотификаций VS Code (с русским языковым пакетом)

**Контекст:** при установленном русском языковом пакете и использовании `notificationService.notify()` с button labels из action.label, который содержит `&&` (мнемоники для меню), они отображаются буквально (2026-05).

**Суть:** `notificationsViewer.js` в строке `button.label = action.label` не снимает `&&` мнемоники. Фикс: `button.label = mnemonicButtonLabel(action.label, true)` + `import { mnemonicButtonLabel } from '../../../../base/common/labels.js'`. Применять одновременно в `src/` и `out/`.

**Применение:** если появляются `&&Да`, `&&Уменьшить` и т.п. в кнопках нотификаций — патчить `notificationsViewer.ts/.js` этой однострочной заменой.
