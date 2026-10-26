# Прикрепления в чат и валидация

← [Knowledge Index](../README.md)

Paste файлов, vision-capability gate (двойной), скрытый dead-code после снятия блокировки.

---

## [архитектура] Paste файлов в чат — один источник правды на focused-элементе

**Контекст:** при подключении Ctrl+V прикрепления картинок (2026-05-09) файлы привязывались дважды. На `VibeChatArea` висел `container.addEventListener('paste', ...)`, а на `<textarea>` — React `onPaste`. В React 17+ синтетика делегирована на корень React-дерева, который выше container в DOM, поэтому в bubble-фазе **container.addEventListener срабатывает РАНЬШЕ** React-handler'а. `e.nativeEvent.stopPropagation()` в onPaste не помогал — он вызывается уже после native listener'а.

**Суть:** для file-paste в чате — единственный handler `onPaste` на focused-элементе (`<textarea>` в [VibeInputBox2 — inputs.tsx:429](../../../src/vs/workbench/contrib/vibeide/browser/react/src/util/inputs.tsx#L429)). Контейнер [VibeChatArea — SidebarChat.tsx:486](../../../src/vs/workbench/contrib/vibeide/browser/react/src/sidebar-tsx/SidebarChat.tsx#L486) обрабатывает только drop (`onDragOver`/`onDrop`) — это другой event-tree.

**Применение:** при добавлении любых clipboard-handler'ов в чат не дублировать listener'ами на родителях. Если нужен paste-fallback при focus вне input — использовать capture-phase или маркер на event'е (но на практике хватает onPaste на textarea).

---

## [архитектура] Vision-capability gate в чате сидит в ДВУХ местах

**Контекст:** при попытке снять блокирующее `notify.error + return` для прикрепления картинки баг "не починился" — то же сообщение приходило из второй точки. Время на поиск второй точки: пара итераций.

**Суть:** в [SidebarChat.tsx](../../../src/vs/workbench/contrib/vibeide/browser/react/src/sidebar-tsx/SidebarChat.tsx) проверка vision-модели стоит дважды:
1. В `addImages`-обёртке — на этапе **прикрепления** (Ctrl+V, drop, кнопка upload).
2. В `onSubmit` (vision/PDF validation) — на этапе **отправки**.

Каждая может блокировать с одинаковым текстом ошибки. Образец лояльного потока — PDF: всегда warn, никогда `error + return`.

**Применение:** при правке любой блокирующей валидации в чате (vision, лимиты вложений, размеры) — `Grep` по тексту ошибки и зеркалить правки в обеих точках. Не трогать только attach-flow или только submit-flow — обязательно обе.

---

## [правило] Снятие блокировки активирует скрытый dead-code

**Контекст:** после ослабления `error + return` в submit-валидации vision выскочил `ReferenceError: notificationService is not defined`. Переменная объявлялась внутри `try {}` блока @-резолвера и в block-scope умирала, но использовалась дальше в submit-валидации. Существовал с initial import; не проявлялся, пока vision-валидация была блокирующей и до этого пути не доходило с реальным payload'ом.

**Суть:** ослабление блокирующей проверки (`return` после `notify(...)`) превращает dead-code-путь в живой и моментально обнажает скрытые баги ниже по потоку — обычно scope/lifetime-проблемы переменных.

**Применение:** при снятии любого `return` после уведомления — прочитать **весь оставшийся поток** функции до конца. Особенно опасны переменные, инициализированные внутри `try {}` / `if {}` и используемые ниже. Поднимать такие на уровень всей функции.

---

## [vendor-quirk] OpenRouter free-tier врёт про vision в `/api/v1/models`

**Контекст:** 2026-05-10 пользователь отправил картинку в чат с моделью `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` через OpenRouter. Модель ответила «На фото фрагмент `.vibe/rules.md` — правила для ИИ проекта», что не имело отношения к реальной картинке (скриншот окна Claude Code). OpenRouter `/api/v1/models` для этой модели возвращает `architecture.input_modalities: ["text","audio","image","video"]` — то есть формально advertise vision. Фактически free-tier upstream-провайдер image input молча отбрасывает и отвечает только по тексту, галлюцинируя описание из system prompt VibeIDE-агента (где есть упоминания `.vibe/rules.md`).

Это ровно тот failure mode, ради которого был добавлен hard-block в коммите `e0bb82ac fix(image-vision): hard-block image attachments on non-vision models`.

**Суть:** catalog-метаданные OpenRouter для free-tier моделей **нельзя считать авторитативными** — поставщик может декларировать модальности, которые upstream не обрабатывает. Хуже: после нашего парсера эта декларация попадает в `overridesOfModel[provider][model].supportsVision = true`, и hard-block снимается → молчаливая галлюцинация.

**Применение:**
- **Не вводить hardcoded blacklist** в коде ([рассмотрено и отвергнуто 2026-05-10](../../../src/vs/workbench/contrib/vibeide/common/remoteCatalogService.ts)): забанить модель навсегда нельзя — может быть временный глюк free-tier upstream'а, и через неделю модель починится, а blacklist в коде продолжит её отрезать. Цена кодовой записи > пользы.
- Защитный механизм для пользователя — **UI override** через Settings: `setOverridesOfModel(provider, model, { supportsVision: false })`. Запись локальна для пользователя, легко снять, не требует пересборки.
- Substring-эвристика в [modelVisionHeuristics.ts](../../../src/vs/workbench/contrib/vibeide/common/modelVisionHeuristics.ts) — **не добавлять общие токены** (`omni`, `multimodal`, etc.). Many "omni" модели advertise мультимодальность, но text-only на free-tier — общий токен сразу даёт false-positive. Только узкие per-family маркеры (`-vl`, `vision`, `claude-3/4`, `gpt-4o/4.1/5`, `gemini`, конкретные имена типа `phi-3.5-vision`).
- Console.warn `[VibeIDE] vision capability for X resolved by name heuristic` в `aggregatorVisionHeuristic` — диагностический сигнал. Если пользователь жалуется на проблемы с картинками И этот warn срабатывает — подозревать false-positive heuristic ИЛИ catalog-lying upstream, рекомендовать UI override на конкретную модель.

---

## [баг] Молчаливая фильтрация по MIME гасила внешний DnD и скрепку (ATTACHMENTS-1026)

**Контекст:** внешний файл из Finder через drag-and-drop не прикреплялся, из дерева проекта — работал; скрепка молча не работала. Воспроизведено изолированным стендом: synthetic drop с `File.type=''` и реальный файл с неизвестным расширением через input (Chromium даёт `application/octet-stream`).

**Суть:** оба входа композера (`handleDrop`, `handleAttachInputChange` в `SidebarChat.tsx`) фильтровали строго по `File.type` (`startsWith('image/')`, `=== 'application/pdf'`) без fallback на расширение и без ошибки — файл с пустым или чужим MIME исчезал молча. Это вилка маршрутизации, а не валидации: типизированный, но неподдержанный `image/tiff` доходил до `validateImageFile` и давал видимую ошибку, а empty-type умирал раньше неё. Скрепка страдала тем же фильтром в `change`-обработчике, а не нативным диалогом.

**Применение:**
- Общий seam обоих входов — `routeAttachmentFiles` (`browser/attachmentFileRouting.ts`): пустой/`octet-stream` MIME восстанавливается по расширению из закрытой таблицы (только поддерживаемые типы, без расширения поддержки по запросу); File пересоздаётся с восстановленным MIME (`new File([file], name, {type})`), чтобы вся цепочка ниже (validate/process/submit) видела тип; остальное — в `unsupported` → видимая русская ошибка через `INotificationService`.
- Не принимать пустой `File.type` за факт без прогона: реальный drag может дать и нормальный MIME — финальную проверку делает владелец на живом Finder-drag (HITL); synthetic-замер механизма не выдаём за живой жест.
- `react/**` исключён из `src/tsconfig.json`: модули, нужные юнит-раннеру (`test/browser`), кладутся в `browser/`, а не в react-слой; react-слой собирается только `npm run buildreact`, типы — `npm run react-typecheck` (baseline: 3 ошибки `process` в `vibeCustomCommandsService.ts` — чужие, не этого гейта).
- `accept` input держит и MIME, и расширения — иначе ОС-пикер отфильтрует файлы, у которых MIME пустой; повторный выбор того же файла держится на сбросе `e.target.value=''`.


---

## [архитектура] Схема доставки вложений чата к LLM

**Контекст:** Пользователь пожаловался, что прикрепил три изображения к запросу Claude Agent, но в отправленном сообщении виден только текст, а вложения отсутствуют. Нужно было понять, как вложения хранятся в чате и как уходят к модели, не внося правки.

**Суть:**
- `ChatMessage` хранит вложения в полях `images` и `pdfs` (`ChatImageAttachment[]` / `ChatPDFAttachment[]`).
- Изображения проходят через `convertToLLMMessageService`: каждое превращается в base64 content part и далее подаётся в `aiSdkAdapter`.
- PDF бинарно не передаётся модели: вместо этого используется `extractedText` (текстовая выжимка, полученная до отправки).
- Эта схема описывает внутренний путь вложений от UI чата к транспорту LLM.

**Применение:** При будущем разборе UI-бага проверять два независимых факта: (1) видимость вложений в отправленном сообщении в UI, (2) фактический payload, уходящий агенту. Чтение кода подтверждает только внутреннюю схему; оно **не доказывает доставку в конкретном внешнем Claude Agent** и **не объясняет наблюдаемый UI-симптом**. Причина пока не утверждается, автоматического воспроизведения нет.
