# Панель «Спеки»: sidebar-view из workspace-папки

← [Knowledge Index](../README.md)

Новый ViewContainer, читающий `docs/specs/<id>/` из воркспейса. Паттерн добавления боковой панели в vibeide.

---

## [ui] Как добавить sidebar-панель со списком из workspace-папки

**Контекст:** панель «Спеки» — список `docs/specs/<id>/` (PRODUCT.md/TECH.md) с открытием в редакторе (2026-07-13). Отличие от [projects-pane.md](projects-pane.md): данные не из profile-storage, а из файлов воркспейса + FS-watcher.

**Образец для копирования — Vibe Projects.** Четыре файла + один импорт:
1. `vibeSpecsConstants.ts` — `VIBE_SPECS_VIEWLET_ID`/`VIEW_ID`, enum команд, имена файлов.
2. `vibeSpecsService.ts` — `registerSingleton(..., InstantiationType.Delayed)`; `Emitter<void> onDidChangeSpecs`; чтение через `IFileService.resolve(dir).children`; **correlated-watcher**: `_fileService.watch(specsRoot, {recursive:true, excludes:[]})` в `MutableDisposable<DisposableStore>` + `onDidFilesChange(e => roots.some(r => e.contains(specsRootFor(r))) && debounce.schedule())` + `onDidChangeWorkspaceFolders` (пересобрать watchers). `RunOnceScheduler` для дебаунса.
3. `vibeSpecsViewPane.ts` — `ViewPane` + `WorkbenchList` (плоский; спека = один узел, доки — пилюлями, не детьми). `list.onDidOpen → IEditorService.openEditor({resource})`. `shouldShowWelcome()` + `_onDidChangeViewWelcomeState.fire()` для пустого состояния. Дизайн строки — см. секцию «Строка спеки» ниже (эволюционировал: ActionBar-иконки → 2 линии → одна строка с пилюлями `[P][T][S]`).
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

**Создание спек — модалки, не строка-поиск.** «Новая спека» и «Спека из задачи» открывают `IVibeModalService.showModal` (не `IQuickInputService.input`): первая — одно поле + `validator`; вторая — `input.multiline` + `imageInput:true` (📎 картинки→vision через `addUserMessageAndStreamResponse({images})`, PDF→инлайн `extractedText`). Модалки уже умеют input/imageInput/numberFields — bespoke React не нужен. API-шпаргалка модалок — [[vibe-modal]].

**Применение:** любую новую боковую панель vibeide начинать с дублирования этого квартета файлов Vibe Projects/Спеки, а не с нуля.

## [ui] Строка спеки: эволюция вёрстки и грабли (2026-07-14)

Финальный вид: **одна строка** — имя (flex) + ряд пилюль `[P][T][S]` фиксированной ширины справа. **P**=PRODUCT.md, **T**=TECH.md (клик открывает; отсутствующая T — пунктир, клик создаёт из seed), **S**=статус (приглушённая заливка в тон статуса через `color-mix`, borderless — консистентно с P/T: серый/синий/зелёный = draft/approved/implemented). Путь: ActionBar-иконки (книга/шестерёнка не влезали) → 2 линии → одна строка с пилюлями.

**Грабли (все всплыли в живом смоуке через agent-browser/CDP):**
- **«Лесенка»** — статус ТЕКСТОМ разной ширины (ЧЕРНОВИК/УТВЕРЖДЕНА/РЕАЛИЗОВАНА) сдвигал P/T по-разному. Фикс: статус → пилюля `S` фиксированной ширины + пилюли ПЕРЕД/в фикс-ряду → выровнены.
- **Клиппинг 2-й линии** — `line-height` метки НАСЛЕДУЕТСЯ от `.monaco-list-row` (≈высота строки, 40px) → первая линия занимала всю строку, вторая обрезалась. Фикс — явный `line-height` + `getHeight()` под контент. (В single-line неактуально, но помнить про наследование line-height в списках.)
- **Пилюли не влезали (T обрезалась)** — flex-метка без `min-width:0` не сжимается ниже min-content → выдавливает фикс-ширинные пилюли за край. Фикс: `.vibe-specs-label { min-width: 0 }` (обязателен для ellipsis+пилюли в одной flex-строке).
- **Кликабельные пилюли в WorkbenchList** — `stopPropagation` на `mousedown`+`click`, иначе клик пилюли ещё и триггерит open строки.
- **Тултипы 1с** — гайдлайн требует `IHoverService`, не native `title`. `setupDelayedHover` берёт задержку из конфига (не ровно 1с); для точной 1с — `instantiationService.createInstance(WorkbenchHoverDelegate, 'element', { dynamicDelay: () => 1000 }, {})` + `hoverService.setupManagedHover(delegate, el, content)`. Хуверы создавать ОДИН РАЗ в `renderTemplate` и обновлять `hover.update(content)` — не пересоздавать спаны каждый рендер (иначе течёт/ломается); клик-listener'ы тоже персистентные, читают `ctx.entry` (мутируемый холдер, обновляется в `renderElement`).

**Отложено:** спеки деревом с подпапками (остались плоским списком — пилюли P/T заменяют детей-доки).

## [ui] Обновление: корень спек настраиваем, панель «Документы» — дерево (2026-07-13)

- **Спеки → `docs/specs/` (не корень).** `specsRootFor` читает `vibeide.specsPanel.root` (дефолт `docs/specs`), реагирует на смену настройки (reset watchers). Скиллы Spec-First (`spec-driven-implementation` и др.) обновлены на `docs/specs/<id>/`, seed/скелеты тоже. Промпты «Спека из задачи»/«Реализовать спеку» не хардкодят путь — делегируют скиллу.
- **Грабля replace:** слепой `specs/`→`docs/specs/` ломает `implement-specs/` → `implement-docs/specs/`. Защищать подстроки перед заменой пути каталога.
- **Панель «Документы» — `WorkbenchObjectTree`** (первое дерево в vibeide; эталон `preferences/tocTree.ts`): сервис отдаёт вложенные узлы (папки первыми, пустые папки без md отсекаются), ViewPane строит `IObjectTreeElement` рекурсивно, `collapseByDefault:false`. Спеки в `docs/specs/` естественно попадают в это дерево (по решению — включаем, не исключаем).
- **Порядок контейнеров:** Проводник → Спеки (0.50) → Документы (0.51) → Проекты (0.52) → Сервер (0.53).
