# React-локализация и перевод настроек

← [Knowledge Index](../README.md)

`vibeSettingsRu.ts`, перевод настроек напрямую (без bundle), правило для будущих PR.

---

## [русский] Панель настроек VibeIDE и боковый чат: React + language pack

**Контекст:** перевод UI VibeIDE на русский как на продукт по умолчанию (`product.defaultLocale: "ru"`); смесь React-бандла и NLS VS Code.

**Суть:** строки **React-панели** (`Settings.tsx`, `VibeWorkspaceForms.tsx`, `ModelDropdown.tsx` и др.) централизованы в **`src/vs/workbench/contrib/vibeide/browser/react/src/vibe-settings-tsx/vibeSettingsRu.ts`** (`nav`, `miscS`, `modelsS`, `modelDdS`, `workspaceS`, …). **Боковая панель Vibe Chat** (`SidebarChat.tsx`) подключает тот же файл: **`chatS`**, **`chatModeDisplayName`**, **`chatModeDetail`**, **`chatFilesWithChangesLabel`**, **`chatDiffCountLabel`** и т.д. Рантайм грузит **`react/out/`** — после правок **`npm run buildreact`**.

Подписи части настроек — **`common/vibeideSettingsTypes.ts`**, сервис — **`vibeideSettingsService.ts`**.

Строки из **`contrib/vibeide/**/*.ts`** с **`nls.localize` / `localize2`** попадают во встроенный **`extensions/vscode-language-pack-ru/translations/main.i18n.json`**: объект верхнего уровня в **`contents`** = путь **`vs/workbench/contrib/vibeide/<остальное как у файла>/<имя без .ts>`** (например **`vs/workbench/contrib/vibeide/browser/vibeSkillsWorkspaceDiscoveryContribution`** для попапа навыков, **`…/browser/vibeCommands`** для палитры и уведомлений команд). Значение поля по подстрокам-ключам (**`vibeideSkillsDiscoveryMsg`**, **`yolo.undo`** и т.д.) совпадает с **первым** аргументом `localize`. Нет секции или нет ключа → при локали **`ru`** остаётся **английский** текст из второго аргумента **`localize`**.

Апстримные строки VS Code приходят из синка vscode-loc; **кастомные** секции VibeIDE нужно сохранять при **`node scripts/sync-vscode-loc-ru.mjs`** (мержить или повторно накладывать). Отдельно не покрыты пакетом: **`extensions/vibeide-neon/package.json`** (`description` настроек), любой текст **без** `localize` (шаблонные строки в коде — например часть сообщений диаграмм в **`vibeDiagramContextContribution.ts`**), локализация **вне** `contrib/vibeide`.

**Применение:** новый UI в React — **`vibeSettingsRu.ts`** + **`npm run buildreact`**; новый `localize` в **`contrib/vibeide`** — секция по пути модуля + ключи в **`main.i18n.json`**; перезапуск Electron; рассинхрон **`clp`** → см. [languagePack.md](languagePack.md) и [nlsIndices.md](nlsIndices.md).

---

## [i18n] Перевод настроек VibeIDE — прямой путь, не bundle (2026-05-07)

**Контекст:** настройки VibeIDE отображались на английском в Settings UI. Источников два — `extensions/vibeide-neon/package.json` (`contributes.configuration.properties`, ~17 свойств + 12 commands) и 18 TS-файлов в [src/vs/workbench/contrib/vibeide/](../../../src/vs/workbench/contrib/vibeide/) с `Registry.as<IConfigurationRegistry>(...).registerConfiguration({...})` и `localize('key', 'message')`.

**Решение:** перевести напрямую — заменить второй аргумент `localize(key, message)` и значения `description`/`enumDescriptions` в JSON, **не** заводить i18n bundle сейчас.

**Почему:**
- Объём ~63 настройки в 19 файлах — день правок vs. полдня + риски на bundle (нужно подключить `@vscode/l10n`, прогнать XLF-pipeline, синхронизировать с upstream).
- Ключи `localize()` остаются прежними → миграция в bundle потом тривиальна: ключи становятся строками в `vibeide.nls.metadata.json`, второй аргумент `localize()` остаётся как английский fallback.
- В форке нет своего bundle-механизма; стандартный `MS-CEINTL.vscode-language-pack-ru` (Phase 1) покрывает только upstream-строки VS Code, не VibeIDE-собственные.

**Что переведено / что нет:**
- ✅ `description`, `enumDescriptions`, `title` секций в `registerConfiguration({...})`.
- ✅ `description` и `enumDescriptions` в `extensions/vibeide-neon/package.json`.
- ✅ Команды Command Palette в `extensions/vibeide-neon/package.json` → `commands[].title`.
- ❌ `localize()` для notifications, status bar, command palette внутри TS-файлов — **вне scope** этой задачи (заявлено пользователем «только настройки»). По AGENTS.md они тоже должны быть на русском — отдельная задача.
- ❌ ID настроек (`vibeide.safety.sessionTokenLimit`) — не переименовываем, иначе ломаются пользовательские конфиги. Авто-заголовок «Vibeide › Safety: Session Token Limit» в Settings UI генерируется VS Code из ID — остаётся английским.
- ❌ Брендовые/технические термины оставлены: `Trust Score`, `Manual/Supervised/Auto` (значения enum), `Skills`, `MCP`, `LLM`, `Apply`, `Pre-flight plan`, `Dead Man's Switch`, `OAuth`, `OTLP`, `NDJSON`, `SIEM`, `GDPR`, `URL`, `JSON`, `regex`, `Playwright`, `base64`, `Vibe Neon` (имя темы).

**Roadmap-продолжение:** полноценный i18n bundle (отдельный VSIX `vibeide-language-pack-ru`, Crowdin, pseudo-locale `qps-ploc`, CI-coverage gate) расписан в [docs/roadmap.md](../../roadmap.md) → Фаза 3a → «i18n bundle для VibeIDE-специфичных строк» — порядка 30 подпунктов с зависимостями.

**Применение:** при добавлении новой `vibeide.*`-настройки — сразу писать `description` на русском (по правилу AGENTS.md «Локализация UI-строк»), не складывать «потом переведём». При синке апстрима новые VibeIDE-настройки в `vibeide-neon/package.json` или TS-файлах — переводить в том же PR.
