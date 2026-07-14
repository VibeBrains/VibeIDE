# Каталог скриптов `bin/` и `scripts/`

← [Knowledge Index](../README.md)

Правила хранения скриптов + текущая таблица содержимого `bin/`.

---

## [договорённость] Каталог скриптов (`bin/`)

**Контекст:** правило **`.cursor/rules/script-save.mdc`** — в сессиях появляются полезные утилиты; их нужно версионировать и не дублировать.

**Суть:** Перед созданием **нового** скрипта агент **читает эту секцию** и просматривает `bin/` / `scripts/`. Переиспользуемые утилиты без привязки к npm/gulp — в **`bin/`**; зафиксированные шаги сборки — в **`scripts/`**. Каждый новый файл в `bin/` сопровождается **строкой в таблице ниже** (имя, путь, что делает, зависимости, пример запуска).

**Применение:** ассеты, миграции, отладочные генераторы, разовые массовые правки.

| Имя | Путь | Назначение |
|-----|------|------------|
| run-dev.bat | `bin/run-dev.bat` | Резервная обёртка dev-запуска VibeIDE (зеркало корневого **`run-dev.bat`**). Вызывает **`bin/vibe-dev.bat`**. **Запуск из корня репо:** `bin\run-dev.bat` или `bin\run-dev.bat --clear`. См. [build/compileAndSync.md](../build/compileAndSync.md) → секцию **Запуск dev VibeIDE**. |
| vibe-dev.bat | `bin/vibe-dev.bat` | Резервная копия **`scripts/vibe-dev.bat`**: пути **`!REPO_ROOT!\scripts\...`** после **`cd`** для **`code.bat`** и **`vibe-dev-clear-nls-clp.mjs`**. Синхронизировать с **`scripts/vibe-dev.bat`**. |
| soften-png-icon.py | `bin/soften-png-icon.py` | Приглушает яркий неоновый PNG: saturation/brightness/contrast + опциональный Gaussian blur. **Запуск:** `python bin/soften-png-icon.py <вход.png> -o <выход.png>`; флаги `--color`, `--brightness`, `--contrast`, `--blur`. **Зависимость:** `pip install pillow`. |
| restore-vibeide-branding.py | `bin/restore-vibeide-branding.py` | После **merge upstream VS Code**: заново кладёт иконку/лого из **`references/icon-final-soft.png`** и **`references/logo-final.png`** в **`src/vs/workbench/browser/media/`** (`vibeide-icon.png`, `vibeide-logo.png`, `vibeide-main.png`), **`resources/win32/`** (`code_150x150`, `code_70x70`, `code.ico`, `sessions.ico`), **`resources/linux/code.png`**, опционально **`resources/darwin/code.icns`** (`npx png2icons`, флаг **`--skip-icns`**). **Запуск:** `npm run restore-branding` или `python bin/restore-vibeide-branding.py`. **Зависимости:** Pillow; для `.icns` — сеть под `npx`. **Не трогает** CSS/TS — если апстрим откатил пути на `code-icon.svg` / letterpress SVG, правки нужно вернуть отдельно (см. ниже). |
| vibe-language-pack-nls.mjs | `bin/vibe-language-pack-nls.mjs` | `verify` / `extract` / `sync-ru` / `clear-clp` — обёртка над `scripts/*`; см. `node bin/vibe-language-pack-nls.mjs --help`. См. [i18n/nlsIndices.md](../i18n/nlsIndices.md). |
| vibe-skills-catalog.js | `scripts/vibe-skills-catalog.js` | Community Agent Skills: **`list <catalogUrl>`** (формат **`vibe-community-skills-catalog-v1`**), **`manifest <manifestUrl> [expectedSha256]`** — сверка SHA-256 и печать тела; зеркало палитры IDE **Browse catalog / Import URL**. |
| vibe-plan-pr-export.js | `scripts/vibe-plan-pr-export.js` | Markdown для PR: **`## Implementation plan`** с чекбоксами из embedded JSON persisted-плана. **`npm run vibe:plan:pr-export`** — аргументы **`--file`**, **`--latest`**, или путь к `*.plan.md`. |

### После обновления VS Code: брендинг VibeIDE

**Один шаг (бинарники):** из корня репозитория **`npm run restore-branding`**, затем **`npm run transpile-client`** или **`npm run compile`**, чтобы в **`out/`** подтянулись PNG (в **`build/next/index.ts`** должен остаться паттерн **`vs/workbench/browser/media/vibeide*.png`**).

**Если растерялись правки разметки:** поиск по репо **`vibeide-icon.png`**, **`vibeide-logo.png`**, **`code-icon.svg`** в CSS/TS — целевое состояние: мелкая иконка везде **`vibeide-icon.png`**, крупный watermark / онбординг **`vibeide-logo.png`**, letterpress в **`editorgroupview.css`** на лого, **`build/next/index.ts`** копирует **`vs/workbench/browser/media/vibeide*.png`**.

**Промпт агенту (кратко):** «Запусти **`npm run restore-branding`**, проверь что в **`build/next/index.ts`** есть **`vibeide*.png`**, в workbench CSS пути на **`vibeide-icon` / `vibeide-logo`, letterpress не SVG upstream. Сверь с docs/knowledge/gitAndTools/binScripts.md → restore-vibeide-branding».
