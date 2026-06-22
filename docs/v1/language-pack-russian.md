# Русский интерфейс VibeIDE (Language Pack)



Исходники строк Microsoft для VS Code лежат в репозитории [microsoft/vscode-loc](https://github.com/Microsoft/vscode-loc). В рантайме IDE **не** подтягивает этот Git напрямую: поставляются готовые **расширения Language Pack** (VSIX), собранные из `vscode-loc`.



## Это не Cursor и не установленный VS Code Marketplace



Открыть репозиторий в **Cursor** или в штатном **Visual Studio Code** и ждать русское меню **бесполезно**: языковой пакет из `product.json` подхватывает только **собственный Electron** VibeIDE (запуск из `scripts/code*.bat` после сборки или установленная сборка продуктa). На скриншотах из Cursor/Rider меню будет тем, как у того редактора.



### Англоязычная ОС → без `ru` останется английский UI



Языковой пакет **не** включается сам. Если ни в **`argv.json`**, ни флагом CLI не указать **`ru`**, после `app.ready` сработает локаль Electron (`app.getLocale()`), для EN‑Windows попадём в **`userLocale.startsWith('en')`** в [`src/vs/base/node/nls.ts`](../../../src/vs/base/node/nls.ts) → интерфейс остаётся English.



Что сделать быстро из корня репо:



- **Windows:** `scripts\code-vibe-ru.bat` (тонкая обёртка над `code.bat --locale ru`).

- **Linux/macOS:** `chmod +x scripts/code-vibe-ru.sh && ./scripts/code-vibe-ru.sh`  

  Или вручную: `scripts/code.bat`/`.sh ... --locale ru`.



Файл **argv для dev-сессии**: `%USERPROFILE%\.vibeide-dev\argv.json` (суффикс `-dev`; см. `product.json` → `dataFolderName` и [`src/main.ts`](../../../src/main.ts) → `getArgvConfigPath`). Пример содержимого: `"locale": "ru"` (перезапуск обязателен).



Встроенные VSIX должны быть на диске: один раз выполните **`npm run download-builtin-extensions`** (или обычный запуск через `scripts/code.bat` без `VSCODE_SKIP_PRELAUNCH` — тогда делает это preLaunch).



## Откуда качать русский пакет



| Канал | Идентификатор | Примечание |

|-------|---------------|------------|

| **Сборка VibeIDE (встроено)** | `MS-CEINTL.vscode-language-pack-ru` | Версия и `sha256` задаются в `product.json` → `builtInExtensions`; файл качается с Open VSX во время `getBuiltInExtensions` / preLaunch (см. `build/lib/builtInExtensions.ts`, `build/lib/extensions.ts` → `fromMarketplace`). |

| Open VSX (ручная установка / проверка) | [vscode-language-pack-ru](https://open-vsx.org/extension/MS-CEINTL/vscode-language-pack-ru) | API: `https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-ru/<version>` — в ответе есть `files.download`, `files.sha256`. |

| Visual Studio Marketplace | `MS-CEINTL.vscode-language-pack-ru` | Версии могут отличаться от Open VSX (часто более частые билды). Для **пинning в репозитории** используем Open VSX, т.к. в `product.json` указан `extensionsGallery` на open-vsx.org. |



Связь с `vscode-loc`: в манифесте пакета поле `repository` указывает на тот же git — см. описание проекта в [README vscode-loc](https://github.com/Microsoft/vscode-loc#readme).



## Версионирование (обязательно)



Версию language pack нужно держать **согласованной с версией движка VibeIDE** (`"version"` в корневом `package.json`, сейчас это линейка VS Code `1.x`).



- В `engines.vscode` у пакета указано нижнее ограничение, например `^1.106.0` для сборки IDE `1.106.0`.

- Ставить **случайно** `latest` с Open VSX опасно: при отставании форка новый пакет может требовать более новый `vscode`, либо наоборот — дать пропуски переводов при рассинхроне NLS.



**Правило для мейнтейнеров:** при bump версии IDE в `package.json` проверить, что на Open VSX есть соответствующий релиз пакета (или ближайший совместимый по `engines`) и обновить запись в `product.json` → `builtInExtensions`.



## Как обновить пакет после изменений во внешней репе / маркетплейсе



Microsoft правит строки на своей платформе локализации; в GitHub [vscode-loc](https://github.com/Microsoft/vscode-loc) и в маркетплейсах появляются новые теги релизов. Процедура для VibeIDE:



1. **Выбрать целевую версию** пакета = та же мажор/минор линия, что и `package.json` IDE (или новая — если вы подняли версию движка).

2. **Взять метаданные с Open VSX** (источник для `npm run compile` / prelaunch download):

   - Открыть `https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-ru/<версия>`.

   - Из JSON: `version`, ссылка `files.sha256` → hex SHA-256 VSIX.

3. **Обновить `product.json`**: в объекте `builtInExtensions` для `MS-CEINTL.vscode-language-pack-ru` заменить `version` и `sha256`.

4. **Очистить кэш при локальной отладке** (если VSIX не перекачивается): удалить каталог  

   `.build/builtInExtensions/MS-CEINTL.vscode-language-pack-ru`  

   и при необходимости кэш языка в user data (`clp/`, `languagepacks.json` — см. `src/vs/base/node/nls.ts`).

5. **Собрать** обычным пайплайном; встроенные расширения подтянутся заново при несовпадении версии на диске.



Переводы через PR в `vscode-loc` [Microsoft не принимает](https://github.com/Microsoft/vscode-loc#contributing) — только issues; для кастомных правок RU в форке IDE нужен либо свой language pack-расширение, либо отдельная ветка сборки (не входит в эту инструкцию).



## Включение языка у пользователя



После установки / встроенного пакета: **Command Palette** → `Configure Display Language` → **ru** → перезапуск (или ключ `"locale":"ru"` в `argv.json` в каталоге user data приложения — для VibeIDE это папка из `product.json` → `dataFolderName`, например профиль `.vibeide`). Сам по себе **встроенный пакет не переключает** язык: локаль выбирает пользователь или `argv`.



## Если интерфейс остаётся на английском



Upstream VS Code при **`VSCODE_DEV=1`** отключает загрузку language pack в main/renderer (`src/vs/base/node/nls.ts`, `src/bootstrap-esm.ts`). В VibeIDE в `scripts/code.bat` и `scripts/code.sh` задаётся **`VIBEIDE_LANGUAGE_PACK_IN_DEV=1`**, чтобы при запуске из исходников перевод работал после переключения на `ru` и перезапуска.



Для распакованной сборки без поля **`commit`** в `product.json` цепочка NLS бы не активировалась; в **`src/bootstrap-meta.ts`** при отсутствии `commit` подставляется `git rev-parse HEAD`.



Нужно **снова** только английский в dev — уберите переменную: `set VIBEIDE_LANGUAGE_PACK_IN_DEV=` (cmd) или `unset VIBEIDE_LANGUAGE_PACK_IN_DEV` (bash).

