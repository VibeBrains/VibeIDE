# Граница «наш код ↔ upstream»: почему upstream не трогаем ради стиля

← [Knowledge Index](../README.md)

> Фундаментальное правило форка. Возникает каждый раз, когда линтер/чекер/стиль-гейт ругается на файл, который мы не писали. Прецедент фиксации — eslint-чистка 2026-07-19 (вариант 2 «только наш код»).

---

## [правило] Что такое «upstream» и почему его правки дорогие

**Контекст:** VibeIDE — **форк `microsoft/vscode`**. Мы периодически **вливаем свежие версии VS Code** (upstream sync — `git merge` тега апстрима поверх нашего оверлея; см. [`docs/references-v1/upstream-merge-playbook-vibeide.md`](../../references-v1/upstream-merge-playbook-vibeide.md)). В дереве живут два класса файлов:

- **Наш код** — что добавили мы: `src/vs/**/vibeide/**`, `src/vs/sessions/**`, файлы с `VibeIDE`/`vibe` в имени (`mainThreadVibeIDE.ts`), `scripts/`, `bin/`, `docs/`, `extensions/project-manager/`, наши тесты. Плюс форк-модификации апстрим-файлов.
- **Upstream** — унаследованное от VS Code, что мы не трогали: большинство `src/vs/**` без `vibeide` (`skipList.ts`, `app.ts`, `webWorkerFactory.ts`, `auxiliaryBarPart.ts`, `nls.messages.ts`, `.eslint-plugin-local/**` и т.п.).

**Суть — почему upstream-файл нельзя править ради стиля/линта:**

1. **Налог на merge-конфликты.** Каждый upstream sync — `git merge` их версии файла поверх нашей. Если мы изменили их строки (добавили `{}` под `curly`, заменили `any`, переставили импорты), **при следующем синке эти строки конфликтуют** с апстримной версией → ручное разрешение **на каждом синке, навсегда**. Чем больше расходятся апстрим-файлы, тем дороже каждый синк.
2. **Нулевая продуктовая ценность.** Починка `no-explicit-any` в `skipList.ts` не даёт пользователю ничего, но добавляет постоянную maintenance-стоимость.
3. **Это не их баг — это наш конфиг строже.** Апстрим-файлы проходят **собственный CI VS Code**. Warning всплывает, потому что **наш** eslint-конфиг строже апстримного (например, `no-explicit-any: warn`, которого у них нет для этих файлов). Мы ругаем их код своими правилами.
4. **Теряем их будущие фиксы.** Разошёлся файл — их улучшения приезжают конфликтом, а не чистым fast-forward.

**Применение — правило:**
- **Стиль/линт/формат в чистом upstream-файле — НЕ трогаем.** Вместо правки — **исключаем из гейта**: `.eslint-ignore` (eslint), `src/tsec.exemptions.json` (tsec), «принятый базлайн» в layers-чекере ([[layerSplitElectronBrowser]] — 3 upstream-нарушения `IMainProcessService`, неустранимы без конфликта). Исключение сопровождать комментарием «upstream, не трогаем — merge-риск».
- **Как отличить наш от upstream:** `git log --diff-filter=A -- <file>` — пришёл с `Initial import: VibeIDE` и ноль `vibe`-коммитов → upstream. Заголовок `Copyright … VibeIDE Team` вместо `Microsoft Corporation` → форк-тронут (наш). Путь с `vibeide`/`sessions`/`scripts`/`bin`/`docs` → наш.

**Когда upstream-файл трогать МОЖНО** (не ради стиля — ради дела): реальный баг-фикс, проводка нашей фичи (импорт vibeide-сервиса в `main.ts`/`workbench.desktop.main.ts` — цена осознанная, [[layerSplitElectronBrowser]]), security. Тогда правка оправдана продуктом, и merge-налог принимается сознательно. Стилевой warning — не тот случай.

**Антипаттерн:** «зелёный гейт любой ценой» — массово править upstream, чтобы линтер молчал. Получаем вечный merge-ад ради косметики. Правильно: наш код чистим, upstream исключаем из гейта.

**Связано:** [[layerSplitElectronBrowser]] (базлайн 3 upstream-нарушений — та же логика) · [[modelQuirks]] («отклонение от рабочего апстрима без репорта» — родственный антипаттерн) · playbook синка — `docs/references-v1/upstream-merge-playbook-vibeide.md`.
