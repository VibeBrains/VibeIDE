# Панель «Спеки»: sidebar-view из workspace-папки

← [Knowledge Index](../README.md)

Новый ViewContainer, читающий `docs/specs/<id>/` из воркспейса. Паттерн добавления боковой панели в vibeide.

---

## [ui] Как добавить sidebar-панель со списком из workspace-папки

**Контекст:** панель «Спеки» — список `docs/specs/<id>/` (PRODUCT.md/TECH.md) с открытием в редакторе (2026-07-13). Отличие от [projects-pane.md](projects-pane.md): данные не из profile-storage, а из файлов воркспейса + FS-watcher.

**Образец для копирования — Vibe Projects.** Четыре файла + один импорт:
1. `vibeSpecsConstants.ts` — `VIBE_SPECS_VIEWLET_ID`/`VIEW_ID`, enum команд, имена файлов.
2. `vibeSpecsService.ts` — `registerSingleton(..., InstantiationType.Delayed)`; `Emitter<void> onDidChangeSpecs`; чтение через `IFileService.resolve(dir).children`; **correlated-watcher**: `_fileService.watch(specsRoot, {recursive:true, excludes:[]})` в `MutableDisposable<DisposableStore>` + `onDidFilesChange(e => roots.some(r => e.contains(specsRootFor(r))) && debounce.schedule())` + `onDidChangeWorkspaceFolders` (пересобрать watchers). `RunOnceScheduler` для дебаунса.
3. `vibeSpecsViewPane.ts` — `ViewPane` + `WorkbenchList` (плоский; **`WorkbenchAsyncDataTree` в vibeide не используется нигде** — для 2 уровней список проще и ниже риск). `list.onDidOpen → IEditorService.openEditor({resource})`. `shouldShowWelcome()` + `_onDidChangeViewWelcomeState.fire()` для пустого состояния. Инлайн-действия строки — `ActionBar`, ребиндить в `renderElement` (виртуальный список рециклит шаблон).
4. `vibeSpecs.contribution.ts` — `registerViewContainer(..., ViewContainerLocation.Sidebar, {doNotRegisterOpenCommand:true})` + `registerViews` + `registerViewWelcomeContent` + `registerAction2` с `menu:[{id:MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VIEW_ID)}]`. Иконка — `registerVibeideFaSolidIcon(id, '\uXXXX', desc)`.
5. Импорт `'./vibeSpecs.contribution.js'` в `vibeide.contribution.ts`.

**Грабли:**
- **FA-глиф пишется реальным символом**, не escape: `registerVibeideFaSolidIcon(id, '', ...)` (U+F15C), а не строкой `''` в исходнике — при копипасте проверять байты (`od -c`: `357 205 234` = U+F15C).
- CSS строк живёт в `browser/media/vibeide.css` (импорт один — из `vibeide.contribution.ts`), классы вручную (React-scope tailwind тут ни при чём).
- Watcher на несуществующей `docs/specs/` не падает — папка всплывёт на следующем reload после создания.

**Статус спеки — детерминированно, не эвристикой.** Пилюля (draft/approved/implemented) читается из YAML-фронтматтера `status:` в PRODUCT.md, а не угадывается по наличию файлов/кода. Петлю замкнуть обязательно, иначе UI мёртвый: seed «Новой спеки» и `PRODUCT.skeleton.md` пишут `status: draft`, скиллы `write-product-spec`/`implement-specs` доводят до `implemented`. Урок: **не добавлять UI, читающий поле, которое никто не пишет** — сначала завести источник значения.

**«Спека из задачи» → чат, не своя механика.** Кнопка, отдающая задачу агенту: `views.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID)` + `IChatThreadService.addUserMessageAndStreamResponse({userMessage, threadId})` (threadId из `chat.state.currentThreadId`, иначе `openNewThread()`). Образец — `vibeDeploy.contribution.ts`. Промпт натравливает агента на скилл `write-product-spec` — не изобретать параллельный генератор спек в UI.

**Дрейф-от-спеки (Phase C) — зеркало план-дрейфа.** Реализовано переиспользованием механики `_pauseRunningPlanStepForToolDrift`:
- **Детерминизм, а не эвристика:** область спеки — явный `scope:` (globs) во фронтматтере PRODUCT.md, НЕ парсинг файлов из TECH.md-прозы. Нет `scope` → границ нет → дрейфа нет.
- **Только явная привязка:** тред привязан к спеке действием «Реализовать спеку» (пишет `boundThreadId` в PRODUCT.md); дрейф срабатывает лишь для привязанного треда со `status: approved` — обычную неспецифицированную работу не трогает (иначе шум).
- **Точки в цикле:** `chatThreadService.ts` хук-точки `:4998` (первый тул) и `:7136` (цикл), только `resolveToolClass(name)==='edits'`. Грабля: на первой точке доступны validated params (URI-объект), на второй — только `rawParams` (строка пути, часто относительная). Отсюда `_normalizeEditedUri(raw, root)`: URI-объект → как есть; строка с схемой → parse; абсолютная → `URI.file`; относительная → `joinPath(rootUri)`.
- **UI бесплатно, но с оговоркой:** пауза ставит `step.status='paused'` у текущего шага плана (чип появляется сам) — НО если плана нет, остаётся только warning-тост. Потому дрейф и триггерим внутри implement, где план обычно есть.
- **Перф:** `readSpecs` мемоизируется (`_cache`, инвалидация в `_fireChanged`) — проверка зовётся на каждой правке, читать все спеки с диска каждый раз нельзя.
- Настройка `vibeide.specs.driftPause` — рядом с `vibeide.plans.toolDriftPause`, тот же enum/логика автопилота.

**Отложено:** дерево с подпапками.

**Применение:** любую новую боковую панель vibeide начинать с дублирования этого квартета файлов Vibe Projects/Спеки, а не с нуля.

## [ui] Обновление: корень спек настраиваем, панель «Документы» — дерево (2026-07-13)

- **Спеки → `docs/specs/` (не корень).** `specsRootFor` читает `vibeide.specsPanel.root` (дефолт `docs/specs`), реагирует на смену настройки (reset watchers). Скиллы Spec-First (`spec-driven-implementation` и др.) обновлены на `docs/specs/<id>/`, seed/скелеты тоже. Промпты «Спека из задачи»/«Реализовать спеку» не хардкодят путь — делегируют скиллу.
- **Грабля replace:** слепой `specs/`→`docs/specs/` ломает `implement-specs/` → `implement-docs/specs/`. Защищать подстроки перед заменой пути каталога.
- **Панель «Документы» — `WorkbenchObjectTree`** (первое дерево в vibeide; эталон `preferences/tocTree.ts`): сервис отдаёт вложенные узлы (папки первыми, пустые папки без md отсекаются), ViewPane строит `IObjectTreeElement` рекурсивно, `collapseByDefault:false`. Спеки в `docs/specs/` естественно попадают в это дерево (по решению — включаем, не исключаем).
- **Порядок контейнеров:** Проводник → Спеки (0.50) → Документы (0.51) → Проекты (0.52) → Сервер (0.53).
