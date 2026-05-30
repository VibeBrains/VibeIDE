# vibe-keybindings — собственный IntelliJ/JetBrains keymap VibeIDE

← [Knowledge Index](../README.md)

**Контекст.** VibeIDE поставляет keymap в стиле JetBrains / IntelliJ IDEA как встроенное расширение `vibe-keybindings` (`extensions/vibe-keybindings/`). С 2026-05-30 это **наш собственный keymap**, а не вендоринг стороннего расширения (см. историю ниже).

**Суть.**
- **Модель владения:** keymap авторизован для VibeIDE по **публичной схеме клавиш JetBrains** (горячие клавиши — функциональный факт) с привязкой к командам VibeIDE/VS Code и стандартным `when`-контекстам VS Code. Это НЕ порт чужого расширения; чужого копирайта не несёт.
- **Лицензия:** MIT © VibeIDE Team (`LICENSE.txt`). Никакой сторонней атрибуции.
- **Состав:** `extensions/vibe-keybindings/` = `package.json` (только `contributes.keybindings`, без `main`/`commands`/deps) + `LICENSE.txt` + `README.md`. **213** биндингов. Манифест: `publisher:"vibeide"`, `categories:["Keymaps"]`, `engines.vscode:"*"`, `repository` → репо VibeIDE.
- Билд подхватывает папку автоматически (`build/lib/extensions.ts`, glob `extensions/*/package.json`); регистрация не нужна.
- **Word-motion** использует стандартные `cursorWord*`/`deleteWord*` без «camel humps»-тумблера (раньше был дубль на `config.intellij-idea-keybindings.useCamelHumpsWords` — namespace чужого расширения, у нас всегда ложь → схлопнуто).

**Применение — обновление/правка.**
1. Редактировать `package.json` напрямую — это **наш** keymap, апстрима для ре-синка нет.
2. При сверке со схемой JetBrains брать публичную справку клавиш JetBrains, не файл стороннего расширения. Совпадение на фактах (Ctrl+Alt+L → format, Shift Shift → search) — нормально и не нарушение.
3. Не возвращать в файл маркеры происхождения: метки `"intellij"`/`"notebook"`/`"todo"`, `config.intellij-idea-keybindings.*`, `repository.url` на чужое репо, чужой копирайт.
4. Поля биндинга: `key`/`mac`/`linux`/`win`/`command`/`when`/`args` (стандарт VS Code).

**История (почему так).**
- Изначально (2026-05-30) расширение было дословным вендорингом `kasecato/vscode-intellij-idea-keybindings` (MIT) с его копирайтом и метками; это ушло в релиз v0.16.0.
- Проблему провенанса подняли постфактум: релиз v0.16.0 **удалён**, keymap переавторен как собственный, чужая атрибуция снята, релиз пересобран. Правило «поднимать лицензию ДО релиза» — [third-party-licensing.md](third-party-licensing.md).

Связано: вендоринг встроенных расширений — [compile-and-sync.md](compile-and-sync.md); провенанс-дисциплина — [third-party-licensing.md](third-party-licensing.md).
