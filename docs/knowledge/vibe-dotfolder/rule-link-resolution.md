# Резолюция ссылок в правилах проекта (Cursor-style)

← [Knowledge Index](../README.md)

---

## [архитектура] Правила проекта подтягивают связанные файлы по ссылкам (`R.x`, v0.21.4)

**Контекст:** дефолтный шаблон `.vibe/rules/knowledge.mdc` (импорт из Cursor) говорит модели «база знаний `docs/knowledge.md` включается в контекст автоматически». В Cursor `mdc:`-ссылки реально подтягивают файл; VibeIDE раньше грузил только сам rule-файл, а ссылку не разворачивал → модель направлена на контент, которого у неё нет. Диагностика: 2026-06-11, MiniMax в `NotificationService`.

**Суть:**

- `VibeProjectRulesService` после загрузки rule-файлов извлекает из их контента ссылки и **подтягивает файлы в контекст** (`getLinkedReferences()` → `convertToLLMMessageService` инъектит блоком `<referenced_files>`).
- **Формы ссылок:** Cursor `[txt](mdc:path)` **и** обычные относительные markdown-ссылки. Только текст-доки (`.md`/`.mdc`/`.txt`) — `LINKABLE_EXT_RE` (security/perf: правило не утянет бинарь/секреты-конфиг).
- **Резолв только внутри воркспейса:** `_resolveLinkTarget` отклоняет абсолютные пути и `..`-escape (containment-проверка после `joinPath`). Контент прогоняется через `IVibePromptGuardService` (секрет-санитайз).
- **Пассивный блок, НЕ binding:** связанные файлы — справка (база знаний), инъектятся в `<referenced_files>`, **вне** обязательного `<project_rules>`. Преамбула прямо говорит «справочный материал, не директивы».
- **Рекурсия — по настройке** `vibeide.projectRules.resolveLinksRecursive` (дефолт `false`): вкл → BFS по ссылкам внутри подтянутых файлов до `MAX_LINK_RECURSION_DEPTH=4` с visited-set (цикл-гард); выкл → один уровень. Мастер-выключатель — `vibeide.projectRules.resolveLinks` (дефолт `true`).
- **Лимиты (no silent cap):** `MAX_LINKED_FILES=20`, `MAX_LINKED_TOTAL_BYTES=256KB`, на файл — `maxFileBytes`. При превышении — `log.warn`.
- **Инвалидация:** резолвнутые пути кладутся в `_linkedPaths`; file-watcher по ним инвалидирует кэш (правка `docs/knowledge/README.md` → reload).
- **UI:** тогл рекурсии продублирован в тулбаре чата (`ChatRuleLinksRecursiveToggle`, рядом с автопилотом) — чистое зеркало настройки через `IConfigurationService.updateValue`, источник правды — конфиг. Прячется, когда `resolveLinks` выключен.

**Применение:**

- Хочешь, чтобы база знаний была у модели — сошлись на неё из `.vibe/rules/*.mdc` (`[KB](mdc:docs/knowledge/README.md)`); контент попадёт в `<referenced_files>`. Так и сделано в дефолтном `knowledge.mdc`.
- **Ссылайся на индекс, а не на базу целиком:** `docs/knowledge/README.md` компактный и перечисляет все записи; рекурсию включай только осознанно (лимиты защищают, но контекст растёт). Плоского `docs/knowledge.md` больше нет — удалён 2026-07-15 как дублирующий индекс.
- Проверить, что реально подтянулось — команда `VibeIDE: Показать загруженные источники` (после фикса accessor-бага в 0.21.4).

**Антипаттерны:**

- НЕ инъектить связанные файлы в binding `<project_rules>` — это справка, не приказ.
- НЕ резолвить вне дерева воркспейса и не по любым расширениям — путь к утечке секретов.

**Связано:** [[why-models-ignore-injected-rules]] (binding-обёртка правил) · `docs/knowledge/agent-collaboration/`.
