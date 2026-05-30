# vibe-keybindings — встроенный набор IntelliJ-кейбиндингов

← [Knowledge Index](../README.md)

**Контекст.** VibeIDE поставляет набор IntelliJ IDEA / JetBrains-кейбиндингов как встроенное расширение `vibe-keybindings` (папка `extensions/vibe-keybindings/`). Это форк/вендоринг стороннего расширения, перебрендированный под VibeIDE.

**Суть.**
- **Источник (upstream):** https://github.com/kasecato/vscode-intellij-idea-keybindings
- **Лицензия:** MIT (бандлинг разрешён; LICENSE-атрибуцию сохранять в папке расширения).
- **Дефолтная ветка:** `master`.
- **Что отдаёт upstream:** `contributes.keybindings` (сотни IntelliJ-шорткатов: edit/search/debug/navigation/refactor) + runtime-команда «Import IntelliJ Keybindings (XML)» (импорт кастомного keymap из IntelliJ XML).
- **Имя в VibeIDE:** расширение названо `vibe-keybindings` (перебрендировано `name`/`publisher`/`displayName` относительно upstream).

**Реализовано (2026-05-30) — вариант B (keybindings-only):** `extensions/vibe-keybindings/` = `package.json` (без `main`/`commands`/`deps`) + `LICENSE.md` + `README.md`. **219** кейбиндингов (из 220 upstream — см. фильтр ниже). Билд подхватывает папку автоматически (`build/lib/extensions.ts:409`, `glob extensions/*/package.json`); регистрация не нужна. Манифест: `publisher:"vibeide"`, `categories:["Keymaps"]`, `engines.vscode:"*"`. Runtime-importer (XML) НЕ бандлится (это был бы вариант A).

**Применение — ОБНОВЛЕНИЕ (когда пользователь попросит «обнови vibe-keybindings» / «подтяни кейбиндинги»):**
1. Брать актуальную версию **только** с upstream-репо выше (ветка `master`): `git clone --depth 1`.
2. Взять `contributes.keybindings` из их `package.json` и **отфильтровать runtime-only команды**: `kept = all.filter(k => !String(k.command).startsWith("intellij."))`. Это правило дропает биндинги на команды, которых нет в keybindings-only сборке (на 2026-05-30 — ровно 1: `intellij.openInOppositeGroup`, у него к тому же нет `key`). Поля `key/mac/linux/win/command/when/args` + аннотации `intellij/notebook/todo` копируются **дословно** (VS Code лишние свойства игнорирует).
3. Записать в `extensions/vibe-keybindings/package.json`, сохранив манифест-идентичность VibeIDE (`name`/`publisher`/`displayName`/`categories`/`engines`) — upstream несёт своё имя/издателя/`main`.
4. Сохранить `LICENSE.md` (MIT + © Keisuke Kato) и обновить `version` под upstream.
5. Не редактировать кейбиндинги вручную в обход upstream — следующий ре-синк затрёт. Локальные отклонения держать overlay-слоем, не в вендоренном массиве.

Связано: вендоринг встроенных расширений — [compile-and-sync.md](compile-and-sync.md); сборка extensions — `extensions/` (auto-discovery билдом).
