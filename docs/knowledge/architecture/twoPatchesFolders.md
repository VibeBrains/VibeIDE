# Две папки патчей

← [Knowledge Index](../README.md)

---

## [архитектура] Две папки патчей: `patches-node-modules/` и `patches-vscode-source/` (2026-05-07)

**Контекст:** в проекте две физически разные пачки `.patch` файлов с принципиально разным назначением. Раньше назывались `patches/` и `patches-vibeide-product/` — имена ничего не говорили о scope, что приводило к ошибочным попыткам положить source-патч в `patches/` (см. коммит `74bb1ff2 fix(ci): minimal patch-package patches for native modules` — переезд из `patches/` именно по этой причине). Переименовано для ясности.

**Суть:**

| Папка | Что патчит | Кто применяет | Когда |
|---|---|---|---|
| `patches-node-modules/` | **node_modules** (`@vscode/sqlite3`, `policy-watcher`, `windows-registry`, `native-is-elevated`) | `patch-package --patch-dir patches-node-modules` | автоматически на `npm install` (postinstall в `package.json`) |
| `patches-vscode-source/` | **наш `src/` (форк VS Code)** — отключение нативных Copilot/chat sparkle, удаление built-in chat panel, surveys/telemetry | **никто автоматически** — это архив | патчи применены однократно вручную, файлы оставлены как memo |

**Foot-gun (зачем явные имена):** если положить патч против `src/vs/...` в `patches-node-modules/`, `patch-package` на постинсталле попытается найти пакет `src/vs/workbench/...` в `node_modules`, упадёт и сорвёт сборку. Имя папки буквально подсказывает, куда какой `.patch` класть.

**Применение:**
- Новый патч против пакета из `node_modules` (фикс несовместимости с Windows, Spectre, ABI и т.п.) → `patches-node-modules/`. Команда генерации: `npx patch-package <package-name> --patch-dir patches-node-modules`.
- Изменение в нашем форке VS Code (отключение upstream фичи, тонкая правка contrib) → НЕ через `.patch`, а **прямо в `src/`** обычным редактированием + commit. `patches-vscode-source/` — историческая справка; новые правки туда складывать не нужно. Если действительно нужен файл-патч (например, для рефакторинга, который потом будет легче снять при апгрейде upstream) — генерировать через `git diff > patches-vscode-source/<name>.patch` и применять руками.
- При апгрейде upstream VS Code — пересмотреть оба набора: node_modules-патчи могут стать ненужными (фикс ушёл в upstream), source-патчи могут начать давать конфликты.

**Antipatterns:**
- НЕ класть source-патч в `patches-node-modules/` (см. foot-gun выше).
- НЕ объединять обе папки под одним именем — разный scope, разные применятели, фундаментально разная семантика.
