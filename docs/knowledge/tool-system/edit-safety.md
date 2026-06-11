# Edit safety pre-flights

`edit_file`, `rewrite_file`, and `create_file_or_folder` run a small set of pre-flight checks before any disk mutation. All checks throw `ToolValidationError` with a stable `code` and a `hint` for the model.

## edit_file — "must read first"

Refuses to run on a pre-existing file that has not been read in this session.

- **Code:** `edit_without_read`
- **Hint:** *"Call read_file first, then issue edit_file using the exact text you observed."*
- **Bypass:** newly-created files (via `create_file_or_folder`) and just-rewritten files (via `rewrite_file`) are auto-marked as read, so the natural chain `create → edit` and `rewrite → edit` works without an extra `read_file`.

This catches the most common edit-mode failure: the model guesses content based on filename + context, generates a SEARCH/REPLACE block, and the SEARCH side never matches because the real file looks different.

## create_file_or_folder — "parent must exist"

Refuses to create a file whose parent directory is missing or is itself a file.

- **Codes:** `parent_dir_missing`, `parent_not_directory`
- **Suggested fix:** create the parent first via `create_file_or_folder` with a trailing `/` on the path.

Without this guard, `IFileService.createFile` fails with an obscure `Unable to write file (NoPermissions)`-flavoured error that the model has no obvious recovery path for.

## [баг] rewrite_file / edit_file — тихая запись пустого файла (stale existence cache)

**Контекст:** 2026-06-11, отчёт пользователя — `rewrite_file` создавал вложенные файлы пачкой, возвращал «Change successfully made», но файлы оставались **пустыми** (0 байт). Чинилось в v0.21.3.

**Суть:** `vibeideModelService.initializeModel` кэширует существование пути (`_fileExistenceCache`, TTL 5 c) и **никогда не инвалидировал кэш при создании файла**. Два пути в один и тот же баг:
- (A) первый `initializeModel` (в начале `rewrite_file`) делал `stat` пока файла НЕТ → кэшировал `exists:false`; после `createFile` второй `initializeModel` читал протухший `false` → модель не создавалась;
- (B) файл создан ранее `create_file_or_folder`, но в кэше остался `false` → `rewrite_file` видит файл через прямой `fileService.exists` (мимо кэша), пропускает ветку create+init, модель так и не резолвится.
В обоих случаях `instantlyRewriteFile` → `getModel().model === null` → `_startStreamingDiffZone` возвращает `undefined` → запись **молча не происходит**, `saveModel` сохраняет пустую модель, тул рапортует success.

**Применение:** после ЛЮБОГО создания файла перед записью — `invalidateExistenceCache(uri)` + `initializeModel`, затем **assert** `getModel(uri).model != null` (иначе `throw` — пусть будет громкая ошибка, а не тихий no-op). Общее правило: кэш существования/состояния файла обязан инвалидироваться на мутации, а «успех» тула должен подтверждаться фактом записи, а не возвратом void-функции. Любой silent-no-op в write-пути = потенциальная потеря данных → конвертировать в tool_error.

## What we did NOT yet add

- **Strict uniqueness of `old_string` in SEARCH/REPLACE.** Currently the underlying `editCodeService.instantlyApplySearchReplaceBlocks` finds the first match. A stricter mode that refuses ambiguous matches and asks for more context belongs in that service, not in `toolsService`.
- **Diff preview before write.** Already exists via `editCodeService` for human-supervised edits; not exposed as a separate built-in tool yet.

These are tracked as follow-ups in the roadmap, not blockers for the current tool-hardening pass.
