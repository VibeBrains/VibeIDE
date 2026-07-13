# Панель «Спеки»: sidebar-view из workspace-папки

← [Knowledge Index](../README.md)

Новый ViewContainer, читающий `specs/<id>/` из воркспейса. Паттерн добавления боковой панели в vibeide.

---

## [ui] Как добавить sidebar-панель со списком из workspace-папки

**Контекст:** панель «Спеки» — список `specs/<id>/` (PRODUCT.md/TECH.md) с открытием в редакторе (2026-07-13). Отличие от [projects-pane.md](projects-pane.md): данные не из profile-storage, а из файлов воркспейса + FS-watcher.

**Образец для копирования — Vibe Projects.** Четыре файла + один импорт:
1. `vibeSpecsConstants.ts` — `VIBE_SPECS_VIEWLET_ID`/`VIEW_ID`, enum команд, имена файлов.
2. `vibeSpecsService.ts` — `registerSingleton(..., InstantiationType.Delayed)`; `Emitter<void> onDidChangeSpecs`; чтение через `IFileService.resolve(dir).children`; **correlated-watcher**: `_fileService.watch(specsRoot, {recursive:true, excludes:[]})` в `MutableDisposable<DisposableStore>` + `onDidFilesChange(e => roots.some(r => e.contains(specsRootFor(r))) && debounce.schedule())` + `onDidChangeWorkspaceFolders` (пересобрать watchers). `RunOnceScheduler` для дебаунса.
3. `vibeSpecsViewPane.ts` — `ViewPane` + `WorkbenchList` (плоский; **`WorkbenchAsyncDataTree` в vibeide не используется нигде** — для 2 уровней список проще и ниже риск). `list.onDidOpen → IEditorService.openEditor({resource})`. `shouldShowWelcome()` + `_onDidChangeViewWelcomeState.fire()` для пустого состояния. Инлайн-действия строки — `ActionBar`, ребиндить в `renderElement` (виртуальный список рециклит шаблон).
4. `vibeSpecs.contribution.ts` — `registerViewContainer(..., ViewContainerLocation.Sidebar, {doNotRegisterOpenCommand:true})` + `registerViews` + `registerViewWelcomeContent` + `registerAction2` с `menu:[{id:MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VIEW_ID)}]`. Иконка — `registerVibeideFaSolidIcon(id, '\uXXXX', desc)`.
5. Импорт `'./vibeSpecs.contribution.js'` в `vibeide.contribution.ts`.

**Грабли:**
- **FA-глиф пишется реальным символом**, не escape: `registerVibeideFaSolidIcon(id, '', ...)` (U+F15C), а не строкой `''` в исходнике — при копипасте проверять байты (`od -c`: `357 205 234` = U+F15C).
- CSS строк живёт в `browser/media/vibeide.css` (импорт один — из `vibeide.contribution.ts`), классы вручную (React-scope tailwind тут ни при чём).
- Watcher на несуществующей `specs/` не падает — папка всплывёт на следующем reload после создания.

**Статус спеки — детерминированно, не эвристикой.** Пилюля (draft/approved/implemented) читается из YAML-фронтматтера `status:` в PRODUCT.md, а не угадывается по наличию файлов/кода. Петлю замкнуть обязательно, иначе UI мёртвый: seed «Новой спеки» и `PRODUCT.skeleton.md` пишут `status: draft`, скиллы `write-product-spec`/`implement-specs` доводят до `implemented`. Урок: **не добавлять UI, читающий поле, которое никто не пишет** — сначала завести источник значения.

**«Спека из задачи» → чат, не своя механика.** Кнопка, отдающая задачу агенту: `views.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID)` + `IChatThreadService.addUserMessageAndStreamResponse({userMessage, threadId})` (threadId из `chat.state.currentThreadId`, иначе `openNewThread()`). Образец — `vibeDeploy.contribution.ts`. Промпт натравливает агента на скилл `write-product-spec` — не изобретать параллельный генератор спек в UI.

**Отложено (осознанно):** дрейф-от-спеки через механизм план-дрейфа, дерево с подпапками — отдельный слой.

**Применение:** любую новую боковую панель vibeide начинать с дублирования этого квартета файлов Vibe Projects/Спеки, а не с нуля.
