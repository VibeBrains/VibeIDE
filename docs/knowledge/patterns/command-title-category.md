# Заголовок команды vs category — не дублировать «VibeIDE»

← [Knowledge Index](../README.md)

---

## [квирк] Палитра команд склеивает `category` + `title` → двойной «VibeIDE: VibeIDE: …»

**Контекст:** 2026-06-12 в Command Palette у ~38 команд отображался двойной префикс: «VibeIDE: VibeIDE: Показать загруженные источники…», «VibeIDE Diagnostics: VibeIDE: Перепроверить каталог models.dev», «VibeIDE Dev: VibeIDE Dev: Снять снапшот памяти».

**Суть:** VS Code рендерит запись палитры как **`{category}: {title}`** буквально, без дедупликации. Если у `Action2` задана `category` (`'VibeIDE'`, `'VibeIDE Diagnostics'`, `'VibeIDE Cloud'`, `'VibeIDE Dev'`), а `title` ещё и начинается с того же слова — префикс задваивается. В кодовой базе сосуществуют два стиля регистрации:
- **С `category`** — тогда `title` должен быть БЕЗ префикса (`'Показать загруженные источники…'`).
- **Без `category`** (большинство `localize2`-команд: sidebar/quick/skills) — префикс «VibeIDE:» живёт прямо в `title` и это нормально.

**Применение:**
- Регистрируешь `Action2` с `category: { value: 'VibeIDE…' }` → `title` (и `value`, и `original`) НЕ начинай со слова из category. Под-квалификатор оставляй: title `'Debug: Открыть лог…'` при category `'VibeIDE'` → «VibeIDE: Debug: Открыть лог…».
- Нет `category` → можно префикс «VibeIDE: …» в title (старый дефолтный стиль).
- Греп для проверки: `category:\s*\{?\s*value:\s*['"]VibeIDE` по затронутым файлам, затем `title:.*VibeIDE` в них же — в title не должно остаться префикса (имя продукта внутри фразы, напр. «Статус VibeIDE», — ОК).

**Связано:** [[russian-first]] (тексты команд на русском), [[context-report]] (команда `vibeide.context.status`).
