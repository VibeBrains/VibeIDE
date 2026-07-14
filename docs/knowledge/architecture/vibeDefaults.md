# `.vibe-defaults` — дефолтная обвязка для агентов

← [Knowledge Index](../README.md)

---

## [архитектура] `.vibe-defaults/` → манифест → `.vibe/` воркспейса

**Контекст:** 2026-06-12. В корне репо есть папка **`.vibe-defaults/`** (`rules/`, `skills/`, `prompts/`) — редактируемый источник дефолтной «обвязки для агентов». Её содержимое нужно засевать в `.vibe/` воркспейса при первом открытии проекта и по команде. Содержимое меняется, поэтому список файлов нигде не фиксируется.

**Суть:**

- **Бандлинг — генерируемый манифест, НЕ чтение с диска.** `scripts/gen-vibe-defaults.mjs` обходит `.vibe-defaults/` **с нуля** и перезаписывает `common/vibeDefaultsManifest.generated.ts` (`VIBE_DEFAULTS_MANIFEST: {path, contents}[]`, POSIX-пути под `.vibe/`, контент через `JSON.stringify`). Так упакованный рендерер пишет файлы без отдельной ресурс-папки в сборке.
  - npm: `npm run gen:vibe-defaults`.
  - **Авто-перегенерация в `release-windows.ps1`** перед `buildreact`/`compile-build` (только при `-not $SkipCompile`) → каждая сборка отражает текущую `.vibe-defaults/`. Список **никогда не хардкодится**.
- **Применение** — чистая функция `common/vibeDefaults.ts` `applyVibeDefaults(fileService, vibeDir, { overwrite? })`: пишет файлы манифеста. По умолчанию **create-if-missing** (правки пользователя не затираются); `IFileService.writeFile` сам создаёт вложенные папки (`skills/<id>/SKILL.md`, `.../scripts/*.py`).
- **Два потребителя** (DRY — оба через `applyVibeDefaults`):
  1. `VibeConfigInitContribution` (`vibeConfigInitService.ts`) — на первом открытии воркспейса, после JSON-конфигов. Инлайновые дубли `prompts/example.md` и `skills/example/SKILL.md` **удалены** — их даёт манифест.
  2. Команда `vibeide.defaults.apply` («Установить дефолтную обвязку для агентов (.vibe)», `vibeDefaultsContribution.ts`) — досев в существующий проект, без затирания.

**Применение:**
- Меняешь дефолты → правь **только `.vibe-defaults/`**. `vibeDefaultsManifest.generated.ts` не редактировать руками (перегенерится). При локальной проверке без релиза — `npm run gen:vibe-defaults`.
- Новый тип файла (любой текст) подхватится автоматически. Бинарники потребуют base64 в gen-скрипте (сейчас — UTF-8 текст).

**Связано:** [[commandsPaletteModal]] (команда видна в окне «VibeIDE Команды»), [[commandTitleCategory]] (категория без префикса).

---

## [архитектура] Заодно в этом же заходе

- **Единый источник списка команд:** `browser/vibeideCommandCatalog.ts` `collectVibeideCommands(keybindingService)` — читает канонический `MenuRegistry.getMenuItems(MenuId.CommandPalette)` (реестр, не копия), фильтр `id.startsWith('vibe')`. Окно «VibeIDE Команды» теперь берёт список ОТСЮДА (инлайн-логика из `VibeCommandsPalette.tsx` убрана). Любой будущий потребитель — через этот хелпер.
- **Word wrap по умолчанию ON:** `browser/vibeDefaultSettingsOverrides.ts` → `registerDefaultConfigurations([{ overrides: { 'editor.wordWrap': 'on' } }])`. Меняет дефолт (явный выбор пользователя сохраняется). Кросс-платформенный механизм; `product.json.configurationDefaults` работает только в web-сборке — поэтому не он.
