# Раскладка доков: `docs/manuals/`, GitHub-конвенции, ловушка вшитых ссылок

← [Knowledge Index](../README.md)

---

## [конвенция] Мануалы — только `docs/manuals/`, имена camelCase

**Контекст:** доки расползлись — руководства лежали и в корне репо (`HOW_TO_CONTRIBUTE.md`, `VIBEIDE_CODEBASE_GUIDE.md`), и в `docs/` вперемешку с каталогом/планом/индексом, в трёх стилях именования (`SCREAMING_SNAKE`, `kebab-case`). Правило введено 2026-07-14, правило-источник — в `CLAUDE.md`.

**Суть:**
- **Мануал** = руководство «как сделать» по шагам → `docs/manuals/<camelCase>.md`.
- **Не мануалы** → живут вне `manuals/`: каталог возможностей (`functional.md`), план (`roadmap.md`), индекс базы знаний (`knowledge.md`), концепт (`idea.md`), FAQ, регламенты, **спеки формата**. Граница именно по жанру: `functional.md` отвечает «что умеет», мануал — «что делать».
- `docs/knowledge/**` остаётся **kebab-case** — исторически так, переименовывать не стали. То есть внутри `docs/` осознанно живут две конвенции: `manuals/` — camelCase, `knowledge/` — kebab.

**Применение:** новый мануал → сразу в `docs/manuals/`, строкой в дерево `docs/README.md`. Переносить существующий — `git mv` (иначе git потеряет историю файла и покажет delete+add).

## [ловушка] `docs/CONTRIBUTING.md` переносить нельзя

**Контекст:** при переносе мануалов возник соблазн утащить в `manuals/` и `docs/CONTRIBUTING.md`.

**Суть:** GitHub ищет `CONTRIBUTING.md` ровно в **трёх** местах — корень репо, `docs/`, `.github/`. Список зашит, конфига для переопределения **нет**. Найдёт — покажет плашку «Please review the contributing guidelines» при создании issue/PR и зачтёт пункт в Community Standards. Из `docs/manuals/` не увидит. Ломается только это (плашка + чеклист), на сборку и продукт не влияет. Те же три пути — у `SECURITY.md` и `CODE_OF_CONDUCT.md`.

**Применение:** `docs/CONTRIBUTING.md` — исключение из правила, остаётся на месте. Если очень надо унести — оставить копию/указатель в одном из трёх легальных мест, и **навсегда**, а не «на пару релизов»: удалим — плашка пропадёт.

**Доп. (разведено 2026-07-14):** `HOW_TO_CONTRIBUTE.md` и `docs/CONTRIBUTING.md` — **не дубли**, хоть заголовок у обоих «Contributing to VibeIDE». Первый — про сборку и запуск (prerequisites, Developer Mode) → мануал, уехал в `manuals/howToContribute.md`. Второй — про процесс (TL;DR, structure, workflow, PR review) → регламент, остался. **Не разобрано:** корневой `./CONTRIBUTING.md` — это вообще апстримный «Contributing to **VS Code**», и README ссылается именно на него, говоря «гайдлайны и процесс PR». Три contributing-дока в репо — отдельная задача.

## [ловушка] Перенос дока ломает ссылки в засеянных `.vibe` — навсегда

**Контекст:** `docs/providers-spec.md` → `docs/manuals/providersSpec.md`. На него вёл **абсолютный** URL (`https://github.com/…/blob/main/docs/providers-spec.md`) из `.vibe-defaults/providers/README.md` — файла, который засевается в проект пользователя как `.vibe/providers/README.md`.

**Суть:** правка `.vibe-defaults/**` + `npm run gen:vibe-defaults` чинит только **будущие** засевы. Уже созданные копии не обновятся: `applyVibeDefaults` (`common/vibeDefaults.ts`) пропускает существующие файлы (`exists → skipped++`), а единственный путь перезаписи — опция `overwrite: true`, у которой **нет ни одного вызывающего** (мёртвый параметр; оба вызова — `vibeConfigInitService.ts` и команда «установить обвязку» в `vibeDefaultsContribution.ts` — идут без него). Значит у существующего пользователя битая ссылка останется навсегда.

**Применение:** прежде чем двигать/переименовывать док, грепнуть его имя по `.vibe-defaults/**` и по `*.generated.ts`. Если на него ведёт абсолютный URL из засеваемого файла — либо не двигать, либо осознанно принять битые ссылки у старых пользователей, либо дать им команду обновления окружения (см. Волна 3: `diffVibeDefaults` + «Обновить окружение из релиза», где `overwrite` наконец оживает). Правку `.vibe-defaults/**` **всегда** сопровождать `npm run gen:vibe-defaults`, иначе манифест разойдётся с источником.
