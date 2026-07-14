# Чат-панель — архитектура

← [Knowledge Index](../README.md)

Записи про две поверхности чата, `VibeChatEditorPane`, multi-chat tabs, lockdown и session restore.

---

## [архитектура] Чат имеет две поверхности — изменения нужны в обеих

**Контекст:** в одной сессии 2026-05-08 два бага сразу из этой асимметрии: (1) настройки «прилипали» в DOM группы чата, (2) drop файлов из Explorer'а в чат не попадал в staging.

**Суть:** VibeIDE-чат живёт одновременно в **двух местах**:
- `VibeChatEditorPane` ([src/vs/workbench/contrib/vibeide/browser/vibeideChatPane.ts](../../../src/vs/workbench/contrib/vibeide/browser/vibeideChatPane.ts)) — таб в editor-area, монтирует React через `mountSidebar`, имеет capture-phase DnD на `.editor-group-container`.
- `SidebarViewPane` ([src/vs/workbench/contrib/vibeide/browser/sidebarPane.ts](../../../src/vs/workbench/contrib/vibeide/browser/sidebarPane.ts)) — viewlet в auxiliary bar (`workbench.view.vibeide`), монтирует React через `mountSidebarHistory`, capture-phase DnD на `parent` (теле ViewPane).

Любая cross-cutting фича (DnD, capture-листенеры, drag-over UI, маркеры на контейнере, перехват клавиш) должна быть подключена в **обе** точки. Иначе симптом «работает в одном месте, не работает в другом» гарантирован.

**Применение:** правя одну из этих двух точек, всегда грепнуть другую (`vibeideChatPane.ts` ↔ `sidebarPane.ts`) на тот же паттерн и зеркалить изменение.

---

## [архитектура] VibeChatEditorPane: session restore, стилизация, lockdown

**Контекст:** чат открывается как отдельная editor group; нужны сплиты (несколько чат-вкладок); миграция в AuxiliaryBar отвергнута — там нет сплитов. Чат остаётся в editor group, история — отдельный view в AuxiliaryBar.

**Архитектура:**
- `openVibeChatEditor()` ([vibeideChatPane.ts](../../../src/vs/workbench/contrib/vibeide/browser/vibeideChatPane.ts)) создаёт editor group справа и монтирует React-компонент `Sidebar` через `mountSidebar`.
- AuxiliaryBar остаётся для отдельной панели истории — [sidebarPane.ts](../../../src/vs/workbench/contrib/vibeide/browser/sidebarPane.ts) → `SidebarViewPane` → `mountSidebarHistory`.

**Проблема session restore:** VS Code сохраняет структуру editor groups в workspace storage независимо от сериализации редакторов. `VibeChatEditorInput` без `IEditorSerializer` → при рестарте группа восстанавливается пустой, плюс могут «прилипать» foreign-редакторы (если пользователь когда-то перетаскивал файлы в чат-группу).
- **Антипаттерн:** регистрация `IEditorSerializer` с `canSerialize()=false` делает хуже — VS Code при наличии зарегистрированного сериализатора создаёт 3 ghost-группы вместо 2.
- **Cleanup при пустой группе:** `ChatEditorGroupCleanupContribution` с `WorkbenchPhase.AfterRestored` — читает `vibeide.chatEditorGroupId` из workspace storage; если группа пуста (чат-редактор не восстановился) — закрывает и чистит storage key.

**Lockdown — изоляция чат-группы:** `setupChatGroupLockdown(group)` навешивает `onDidModelChange` фильтр на `EDITOR_OPEN`; любой не-`VibeChatEditorInput` редактор автоматически переносится `moveEditor` в соседнюю левую группу (если её нет — создаётся слева). При выселении вызываем `group.openEditor(chatEditor)` — иначе active editor остаётся stale (показывает контент только что выселенного файла; tab говорит «Chat», а EditorPane всё ещё рендерит файл — это бажно). Lockdown также «выселяет» всех чужаков уже присутствующих в группе при старте (session restore кейс).
- **Вызовы lockdown:** `openVibeChatEditor` (для existing и для new group) + `ChatEditorGroupCleanupContribution`.
- **Disposal:** `_chatGroupLockdownDisposable` диспозится в `onDidRemoveGroup` для нашей группы (рядом с `_groupListenerDisposable`).

**CSS-стилизация:** `VibeChatEditorPane.createEditor()` ставит `data-vibeide-chat-group="true"` на `.editor-group-container`. Переменные `--vibe-bg-*` переопределяются на этом уровне через `--vscode-editor-background` и каскадируются в React-дерево. Блок в `vibeide.css` использует селектор `.monaco-workbench .part.editor>.content [data-vibeide-chat-group]`. Цвет фона в vibe-neon: `--vscode-editor-background` = `#262335` (фиолетово-тёмный).

**Применение:** при любой работе с чат-панелью, session restore, editor groups, lockdown-логикой или CSS-стилизацией чата.

---

## [архитектура] Multi-chat tabs (несколько параллельных чатов в одной группе)

**Контекст:** до этой правки `VibeChatEditorInput` имел статический `RESOURCE = vibe:chat`, и `matches()` возвращал true для любого экземпляра — VS Code считал все чат-инпуты одним редактором. Можно было открыть только 1 чат-таб. Cursor разрешает несколько (по дефолту 5) — это удобно для side-by-side агентов и параллельных контекстов.

**Архитектура:**
- **`VibeChatEditorInput.chatId: string`** — UUID per instance (передаётся в конструктор или генерируется через `generateUuid()`). Resource per-instance: `URI.from({ scheme: 'vibe', path: 'chat/${chatId}' })`. `matches()` сравнивает `instanceof && other.chatId === this.chatId` — табы независимы.
- **Биндинг chatId ↔ threadId 1:1.** `VibeChatEditorPane.setInput()` override: при активации таба вызывает `chatThreadService.switchToThread(input.chatId)`. Глобальный `currentThreadId` отслеживает активную вкладку. React-сайдбар читает `currentThreadId` из state — при смене таба автоматически перерисовывается на тред этого таба.
- **Настройка:** `vibeide.chat.maxOpenTabs` (number, default 5, min 1) — soft-limit. При превышении — `notificationService.warn(...)` на русском, фокус на существующий таб как fallback.
- **Команды:**
  - `vibeide.chat.open` — фокус активного / создание первого таба (без проверки лимита).
  - `vibeide.chat.openNew` — новый таб (с проверкой лимита). Привязан к Ctrl+Alt+I (`vibeide.cmdShiftL`) и кнопке «+» в History panel toolbar.
- **Lockdown сохранён** — фильтрует по `instanceof VibeChatEditorInput`, ловит все табы корректно.

**Трапы и решения:**

1. **`ServicesAccessor` инвалидируется через `await`.** Caller вызывает `await something` до `openVibeChatEditor(accessor, ...)` → внутри `accessor.get(...)` бросает `Illegal state`. **Решение:** API принимает `IInstantiationService` (singleton, ссылка вечно валидна), внутри `instantiationService.invokeFunction(accessor => ({...}))` создаёт свежий accessor. В callerах захватываем `accessor.get(IInstantiationService)` **до** первого `await`. См. [runtimeQuirks/servicesAccessor.md](../runtimeQuirks/servicesAccessor.md).

2. **`openNewThread()` переиспользует пустые треды.** При втором клике "+" находил пустой тред T2, переключался на него, мы фокусировали уже существующий таб — третий не создавался. **Решение:** добавлен метод `IChatThreadService.forceCreateNewThread(): string` — всегда создаёт свежий тред через `newThreadObject()`. Используется в ветке `newChat` функции `openOrFocusChatInGroup`.

3. **Lockdown сбрасывал фокус на первый таб.** В `setupChatGroupLockdown` после выселения чужаков был безусловный `void group.openEditor(firstChatEditor)` — стирал активацию только что открытого таба. **Решение:** условный — `if (!(group.activeEditor instanceof VibeChatEditorInput))` — переключаем только если активный редактор НЕ чат.

4. **`addGroup` + `openEditor` не активирует группу при клике из aux bar.** Кнопка «+» живёт в `History` panel (правый AuxiliaryBar). Активная workbench part = aux bar. Ручной `editorGroupsService.addGroup(...)` создаёт editor group, но активная part остаётся aux bar → editor part не получает layout-тик → React не монтируется → чат-таб «висит» в DOM, но не виден. **Решение:** заменили ручной `addGroup` на `editorService.openEditor(input, options, SIDE_GROUP)` — каноничный VS Code путь, который атомарно делает `addGroup` + `activateGroup` + `focus` + переключение active part.

5. **`mountedInfo.whenMounted` зависает на свежем старте.** Конструктор `ChatThreadService` вызывает `openNewThread()` → `_setState` → создаётся `mountedInfo.whenMounted = new Promise(...)`. Promise разрешается только при mount React-компонента. На свежем старте чат-таб не открыт → React не монтируется → Promise pending forever. Команда `vibeide.cmdShiftL` ("+") делала `await ...mountedInfo?.whenMounted` ДО `openVibeChatEditor` → зависала навсегда. **Решение:** проверять флаг `mountedInfo.mountedIsResolvedRef.current` перед await — если ещё не разрешён, не ждём (`oldUI = undefined`, carry-over пропускается).

6. **Промежуточная пустая чат-группа на старте.** VS Code persist-ит layout editor groups независимо от сериализации редакторов. Антипаттерн (зафиксирован отдельно): регистрация `IEditorSerializer` с `canSerialize()=false` создаёт 3 ghost-группы, не помогает. **Обновлено в п.7 — теперь сериализатор реально регистрируется и фаза перенесена.**

7. **Воскрешение конкретных чат-табов через `IEditorSerializer` + перенос фазы на `AfterRestored`.** На практике (2026-05-07) выяснилось две проблемы. **(а)** При нескольких открытых чатах все, кроме одного, терялись на рестарте. Активной становилась не та вкладка. **(б)** Когда у пользователя в layout-storage оставался persisted `groupId`, на `BlockRestore` editor groups ещё не материализованы — `getGroup(storedId)` возвращает `undefined`, контрибуция выходит первой же веткой, fallback не срабатывает, правая панель остаётся пустой. **Решение:** (1) Зарегистрирован полноценный `VibeChatEditorInputSerializer` с `canSerialize() = editorInput instanceof VibeChatEditorInput`. Сериализатор пишет `JSON.stringify({ chatId })`, при десериализации проверяет существование `chatId` в `chatThreadService.state.allThreads` — если поток удалён из другого окна, возвращает `undefined`, VS Code просто пропускает вкладку. (2) `ChatEditorGroupCleanupContribution` перенесена на `WorkbenchPhase.AfterRestored` и внутри `await editorGroupsService.whenRestored` — двойная защита. **Эффект:** все чат-вкладки восстанавливаются, активной остаётся та, что была активна, layout полностью соответствует прошлой сессии.

**Не входит:**
- Tab-toolbar «New Chat (+)» внутри чат-группы (UI polish — сейчас «+» в title bar History panel в aux bar).

**Применение:** при работе с multi-chat tabs, чат-инпутами, threads сервисом или жизненным циклом editor groups. Если кто-то предложит вернуться к статическому `RESOURCE` и `matches() instanceof` — указать на эту запись (нельзя открыть >1 таба).
