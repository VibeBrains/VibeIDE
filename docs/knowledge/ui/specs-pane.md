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
- **Последняя пилюля (S) обрезалась справа** — строка `width:100%` + горизонтальный `padding` БЕЗ `box-sizing:border-box` → фактическая ширина 100%+падинги, последний элемент выезжает за правый край ровно на величину падинга. Фикс: `box-sizing: border-box`. (Проверять именно ПОСЛЕДНЮЮ пилюлю в смоуке, а не предпоследнюю — легко проглядеть.)
- **High-contrast: пилюли исчезали** — бордер `var(--vscode-badge-background)` в hc-black = чёрный на чёрном фоне, S-бордер `transparent` → пилюли-коробки невидимы (только буквы). Фикс идиоматичный: `border: 1px solid var(--vscode-contrastBorder, <обычный>)` — HC-темы задают `--vscode-contrastBorder` (видимый контур), обычные падают на fallback (прежнее поведение). Проверять UI хотя бы раз в HC — translucency/невидимые рамки там ломают доступность.
- **S vs P/T перенасыщение** — контурный (border+text) S визуально расходился с заливными P/T. Решение: S тоже заливкой, но приглушённой через `color-mix(in srgb, <status-token> 28%, transparent)` + `border-color: transparent`. `color-mix` в Chromium форка поддержан.
- **Кликабельные пилюли в WorkbenchList** — `stopPropagation` на `mousedown`+`click`, иначе клик пилюли ещё и триггерит open строки.
- **Тултипы 1с** — гайдлайн требует `IHoverService`, не native `title`. `setupDelayedHover` берёт задержку из конфига (не ровно 1с); для точной 1с — `instantiationService.createInstance(WorkbenchHoverDelegate, 'element', { dynamicDelay: () => 1000 }, {})` + `hoverService.setupManagedHover(delegate, el, content)`. Хуверы создавать ОДИН РАЗ в `renderTemplate` и обновлять `hover.update(content)` — не пересоздавать спаны каждый рендер (иначе течёт/ломается); клик-listener'ы тоже персистентные, читают `ctx.entry` (мутируемый холдер, обновляется в `renderElement`).

**Отложено:** спеки деревом с подпапками (остались плоским списком — пилюли P/T заменяют детей-доки).

## [ui] Обновление: корень спек настраиваем, панель «Документы» — дерево (2026-07-13)

- **Спеки → `docs/specs/` (не корень).** `specsRootFor` читает `vibeide.specsPanel.root` (дефолт `docs/specs`), реагирует на смену настройки (reset watchers). Скиллы Spec-First (`spec-driven-implementation` и др.) обновлены на `docs/specs/<id>/`, seed/скелеты тоже. Промпты «Спека из задачи»/«Реализовать спеку» не хардкодят путь — делегируют скиллу.
- **Грабля replace:** слепой `specs/`→`docs/specs/` ломает `implement-specs/` → `implement-docs/specs/`. Защищать подстроки перед заменой пути каталога.
- **Панель «Документы» — `WorkbenchObjectTree`** (первое дерево в vibeide; эталон `preferences/tocTree.ts`): сервис отдаёт вложенные узлы (папки первыми, пустые папки без md отсекаются), ViewPane строит `IObjectTreeElement` рекурсивно, `collapseByDefault:false`. Спеки в `docs/specs/` естественно попадают в это дерево (по решению — включаем, не исключаем).
- **Порядок контейнеров:** Проводник → Спеки (0.50) → Документы (0.51) → Проекты (0.52) → Сервер (0.53).

## [ui] DnD из дерева в чат + открытие в markdown-превью (2026-07-14)

**Контекст:** панель «Документы» — клик должен открывать рендер, а не исходник; строки должны перетаскиваться в чат «на разбор».

- **Куда на самом деле приземляется drop в чат.** Не в React-композер: его `onDrop` (`SidebarChat.tsx`) читает только `e.dataTransfer.files` и фильтрует по `image/*`/`application/pdf` — внутренний drag из дерева кладёт **типы данных, а не `File`-объекты**, поэтому композер его не увидит. Реальный приёмник — `sidebarPane.ts` (`renderBody`): перехват **в capture-фазе** (раньше React) по наличию `text/uri-list` → `chatThreadService.addNewStagingSelection({type:'File'|'Folder'})`. Вывод: чтобы что-то перетаскивалось в чат, drag ОБЯЗАН нести `text/uri-list`.
- **`fillEditorsDragData` (`workbench/browser/dnd.ts`) — готовый источник этого payload'а** (им же пользуется Explorer): ставит `TEXT`, `RESOURCES`, `CodeDataTransfers.EDITORS`, `text/uri-list` + `INTERNAL_URI_LIST`. Достаточно `dnd:` в опциях дерева с `ITreeDragAndDrop`: `getDragURI` (null → элемент не тащится, так отсекаются папки), `onDragStart` → `invokeFunction(a => fillEditorsDragData(a, uris, event))`, `onDragOver:false` + `drop:no-op` для drag-out-only панелей.
- **Ложная тревога в предикате:** `isExternalFileDrag` в `sidebarPane.ts` отбрасывает drag с типом `'application/vnd.code.editor'` — но эту строку **никто не ставит** (реальный тип редакторов — `CodeDataTransfers.EDITORS` = `'CodeEditors'`), так что проверка ни на что не влияет и drag'и с `fillEditorsDragData` проходят. Не пугаться комментария «Internal editor tab drags are skipped».
- **Мультидрег теряет всё, кроме первого файла** — не баг панели: `text/uri-list` из-за [chromium#239745](https://bugs.chromium.org/p/chromium/issues/detail?id=239745) несёт **только первый URI** (`slice(0,1)`), полный список идёт в `INTERNAL_URI_LIST`, который приёмник в `sidebarPane` не читает. Тот же эффект у мультидрега из Проводника. Если понадобится мультиприкрепление — читать `INTERNAL_URI_LIST` в `sidebarPane`, а не чинить панель.
- **Открытие в markdown-превью:** `ICommandService.executeCommand('markdown.showPreview', uri)`. Команда живёт в расширении `markdown-language-features`, и в его `activationEvents` её НЕТ — но пугаться не нужно: `contributes.commands` авто-генерирует `onCommand:<id>` (`menusExtensionPoint.ts`, `activationEventsGenerator`), а `CommandService.executeCommand` для незарегистрированной команды шлёт activation-событие и гоняет `*`-активацию против регистрации (30с) → холодный первый клик активирует расширение сам. Проверять `activationEvents` расширения недостаточно — смотреть на неявную генерацию.
- **Побочка превью, которую видно только в живом смоуке:** чип «Файл» в чате (`ContextChipsBar`, `SidebarChat.tsx`) печатает `basename(editorService.activeEditor.resource)`. У webview (markdown-превью, настройки, walkthrough) resource — служебный хэндл, и чип показывал `webview-markdown.preview-<guid>`. Переводя что-либо на превью, проверять всё, что завязано на `activeEditor` — не только сам редактор. Фикс: чип рисуется только для «файловых» схем (`file`/`vscode-remote`/`untitled`), иначе скрыт.

## [ui] Смена статуса из панели: цветные пункты контекст-меню (2026-07-14)

**Контекст:** статус спеки менялся только правкой фронтматтера руками — мануал буквально так и писал. Владелец: «может добавить ПКМ на статусе с дропдауном, каждый айтем со своим бэкграундом».

**Суть:** ПКМ по пилюле `S` → меню из трёх пунктов («Черновик / Утверждена / Реализована»), текущий с `checked` (штатная галочка-радио), каждый окрашен в цвет своего статуса. Запись — `setSpecStatus` в `vibeSpecsService`: ровная копия `bindThreadToSpec` (read PRODUCT.md → `upsertFrontmatterField(text,'status',v)` → write → `_fireChanged()`). Новой механики не понадобилось: писатель фронтматтера уже существовал ради `boundThreadId`. Переходы намеренно не ограничены (включая откат `implemented → draft`) — это документ автора, а не машина состояний; `approved` гейтит только «Реализовать спеку».

**Грабли — покрасить пункт контекст-меню в VS Code штатно НЕЛЬЗЯ:**
- `IAction.class` доезжает до DOM только если меню собрано с `options.icon` — `contextMenuHandler` его никогда не ставит (`menu.ts` `updateClass()`: `if (this.options.icon && this.label)`).
- `data`-атрибута или id у пунктов нет — `menu.ts` кладёт в DOM только `aria`/`role`/`tabindex`.
- **`checked` НЕ даёт класса на `<li>`**: состояние едет в `aria-checked` на `<a role="menuitemcheckbox">` + галочку рисует `span.menu-item-check`. Проверять в смоуке надо `aria-checked`, а не `classList.contains('checked')` — иначе решишь, что фича сломана, хотя сломан тест.
- Остаётся единственный крючок: `getMenuClassName()` (он в `IContextMenuDelegate` есть) + CSS по `nth-child`.

**Принятый компромисс и его цена:** `.vibe-spec-status-menu .action-item:nth-child(1..3) .action-menu-item`. **Красить надо `a.action-menu-item`** — это строка меню целиком; `.action-label` внутри неё лишь span с текстом (рядом с `.menu-item-check`), покрасишь его — затонируются слова, а не пункт (наступил на это в первой же попытке). И `.focused`-подсветку надо вернуть явно: штатное правило красит тот же элемент, что и мы, наш фон перебивает его, и наведение выглядит мёртвым. Стили **привязаны к порядку пунктов**: вставит кто-то четвёртый пункт или `Separator` — цвета молча съедут на соседей. Ничего не упадёт, просто начнёт врать, и тест этого не поймает. Защита — только предупреждения: в `_showStatusMenu`, в CSS-блоке и здесь; `STATUS_ORDER` — единственный источник порядка. **Понадобится четвёртый пункт — удалить цвета, оставить `checked`.** Выбор осознанный: в этой панели статус и ЕСТЬ цвет (пилюля `S` без текста), меню без цвета заставляло бы держать соответствие в голове ровно там, где его применяют.

**Обнаружимость:** жест невидим — пилюля цветная и молчит. Единственная зацепка в тултипе: «Статус: утверждена — ПКМ, чтобы сменить». Добавляя скрытый жест, сразу класть подсказку туда, куда пользователь и так наводит.

**Ещё:** `stopPropagation` + `preventDefault` на `contextmenu` пилюли обязательны — иначе поверх откроется и контекст-меню строки (`list.onContextMenu`).
