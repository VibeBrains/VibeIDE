# VibeModal: реализация и ловушки

← [Knowledge Index](../README.md) · связано: [[scope-tailwind]] (`@@`-escape — критично для этого компонента)

Кастомные модальные окна VibeIDE (`IVibeModalService`). Тема-нативный вид, очередь, blocking/non-blocking, ресайз. Доведено до рабочего состояния в **0.13.19** (см. roadmap O.18) — до этого рендерилось сломанным (прозрачное, на весь экран, мёртвые кнопки) из-за рассинхрона классов со scope-tailwind.

---

## [архитектура] Из чего собрано

**Контекст:** нужно показывать модалки (инфо/подтверждение/ввод/прогресс) поверх workbench, не завися от VS Code dialog-сервиса, с темовым видом.

**Суть — слои:**
- **Сервис:** `IVibeModalService` (`common/vibeModalService.ts`) — API `showModal<T>({title, body, buttons, icon, size, blocking, ...})` + хелпер `showImportantInfoModal({..., secondaryAction})`. Очередь: показывается «голова» (`VibeModalQueueEntry`).
- **Mount:** `VibeModalRootContribution` (`browser/vibeModalRootContribution.ts`, `WorkbenchPhase` поздняя) **лениво** монтирует React-портал `mountVibeModalRoot` в `.monaco-workbench` при первом модале. Был отключён в bisect (commit `9143151f`) и восстановлен (`0195339a`) до 0.13.15.
- **React:** `react/src/modal-tsx/VibeModalContainer.tsx` (рут + `is-active`/`non-blocking` + анимация) → `VibeModal.tsx` (голова очереди: header/body/buttons/input/progress/keyboard-hint).
- **Стили:** ВСЕ в `browser/media/vibeModal.css` через `var(--vscode-*)` токены (ноль хардкод-цветов). Грузится через `import './media/vibeModal.css'` в `vibeide.contribution.ts` — то есть **вне** scope-tailwind-пайплайна (отсюда главная ловушка ниже).

**Применение:** новый тип модалки → расширить `VibeModalOptions` + ветку рендера в `VibeModal.tsx` + стиль в `vibeModal.css` (токенами). Открытие — только через `IVibeModalService`, не свой DOM.

---

## [foot-gun] Рассинхрон классов: `@@`-escape ОБЯЗАТЕЛЕН для инлайн-литералов, но НЕ для классов-переменных

**Контекст:** на 0.13.18 модалка офлайн-каталога рендерилась полностью сломанной — прозрачная, на весь экран, без рамки/падингов, **кнопки не кликались** (только Esc/Enter). Полсессии диагностики.

**Суть (корень):** `VibeModal.tsx` живёт в React-сборке → `scope-tailwind` префиксует инлайн-`className`-литералы `vibe-` (`vibeide-modal` → `vibe-vibeide-modal`). А `vibeModal.css` грузится отдельно (workbench-import, вне пайплайна) с **сырыми** селекторами `.vibeide-modal*`. Рассинхрон → **ни одно правило не применяется**. Подтверждено грепом собранного `out/modal-tsx/index.js`: было 22× `vibe-vibeide-modal`, 0× сырых. Доп-симптом «мёртвые кнопки»: non-blocking-рут получал `pointer-events:none`, а карточка (`vibe-vibeide-modal`) не матчила `.vibeide-modal{pointer-events:auto}` → клики проходили насквозь; Esc/Enter жили через document-handler.

**Решение (0.13.19):** пометить инлайн-литералы маркером `@@` (`@@vibeide-modal`, `@@vibeide-modal-header`, …, `@@is-invalid`, `@@codicon`, `@@size-${...}` внутри инлайн-шаблона) — scope-tailwind стрипает `@@` и НЕ префиксует → DOM получает сырой `vibeide-modal*`, матчит CSS. Проверено эмпирически: `@@` стрипается и для составных токенов с интерполяцией (`@@codicon-${icon}`).

**Тонкость, которая чуть не сломала фикс:** классы, собранные в **отдельную переменную** (а не инлайн в `className={...}`), scope-tailwind **вообще не видит** → они и так сырые → `@@` там НЕ нужен (и не стрипнется, останется буквально `@@`!). В модалке это:
- `VibeModalContainer.tsx`: `const rootClassName = \`vibeide-modal-root${...' is-active'}${...' non-blocking'}\`` → БЕЗ `@@`.
- `VibeModal.tsx`: `const sizeClass = \`size-${options.size}\`` → БЕЗ `@@`.

То есть правило: **инлайн-литерал в `className={...}` → `@@`; класс из переменной → без `@@`.** (Это частный случай общей ловушки из [[scope-tailwind]] «классы только в константах».)

**Применение:**
- Любой класс модалки в JSX-атрибуте → `@@vibeide-X`; в `vibeModal.css` селектор `.vibeide-X` (без `vibe-`).
- Класс, собираемый в `const` вне атрибута → оставить сырым (без `@@`).
- Проверка после `npm run buildreact`: `grep -oE "vibe-vibeide-modal" out/modal-tsx/index.js` → должно быть **0**; `grep -c '@@' out/modal-tsx/index.js` → только React-овский `@@iterator` (не классы).

---

## [реализация] blocking / non-blocking

**Контекст:** часть модалок должна блокировать workbench (action-required), часть — только привлекать внимание, не мешая работать.

**Суть:** `blocking: false` → `VibeModalContainer` ставит на рут `non-blocking`. CSS: `.vibeide-modal-root.is-active.non-blocking { pointer-events: none }` (клики проходят сквозь рут к workbench), `.non-blocking .vibeide-modal { pointer-events: auto }` (карточка кликается), `.non-blocking .vibeide-modal-backdrop { display: none }` (нет затемнения). Исторически блокирующий модал на старте применял `inert` на весь workbench и морозил меню на офлайн-машинах (Z.12) → офлайн-каталог сделали non-blocking.

**Применение:** «можно проигнорировать» (инфо/офлайн-уведомление) → `blocking:false`. «Нужно действие» (нет каталога моделей вообще) → blocking. НЕ применять `inert` к workbench на старте.

---

## [реализация] Размер и ресайз (≤800×600, тянется)

**Контекст:** запрос пользователя 0.13.19 — модал не на весь экран, дефолт ≤800×600, с ресайзом.

**Суть (`vibeModal.css`):** `.vibeide-modal { resize: both; overflow: hidden; max-width: min(800px,95vw); max-height: min(600px,90vh); min-width:320px; min-height:160px }`. Size-варианты задают ДЕФОЛТНУЮ ширину: `.size-small{width:min(420px,90vw)}`, `medium{600}`, `large{800}` (все под общим капом 800). Body — `flex:1 1 auto; min-height:0; overflow-y:auto` → при сжатии карточки контент скроллится, а не вылезает за кнопки. `resize:both` требует `overflow != visible` (отсюда `overflow:hidden` на карточке).

**Применение:** менять дефолт-размер → size-варианты (ширина); общий потолок — `max-width/max-height` базового `.vibeide-modal`. Любой скроллящийся контент в модалке требует `flex:1 + min-height:0` на контейнере.

---

## [usage] API-шпаргалка: как открыть модалку (чтобы не искать каждый раз)

**Сервис:** `IVibeModalService` (`common/vibeModalService.ts`), renderer-side (browser). Получать через `accessor.get(IVibeModalService)` в Action2 или DI в сервисе/ViewPane. Из main-процесса напрямую нельзя — только тосты (`INotificationService`) или IPC.

**Главный метод:** `showModal<TButtonId>(options): Promise<VibeModalResult<TButtonId>>`. Резолвится по клику кнопки или `__dismiss__` (ESC/backdrop, если `dismissible !== false`). Типы — `common/vibeModalTypes.ts`.

**Заменяет `IQuickInputService.input()`** (верхняя строка-поиск) на брендовую модалку — предпочитать для любого ввода id/имени/промпта.

### `VibeModalOptions` — что уже поддержано (bespoke React НЕ нужен)

| Поле | Назначение |
|---|---|
| `title`, `body`, `bodyMarkdown`, `icon` (codicon), `size` (`small`/`medium`/`large`) | шапка/тело |
| `buttons: [{id,label,role,disabled,hotkey}]` | `role`: `primary` (Enter) / `secondary` / `danger`; `hotkey` — одиночная буква |
| `footerLeftButton` | кнопка слева внизу (образец — «🎭 Роли»); резолвит модалку своим id |
| `input: { placeholder, initialValue, multiline, validator }` | текстовое поле; `multiline:true` = textarea; `validator: v => null\|"ошибка"` (при не-null primary-кнопка авто-дизейблится) |
| `imageInput: true` | **скрепка**: картинки+PDF (drag-drop+вставка). Требует `input`. Картинки → `result.images`, PDF → `result.pdfs` (с `extractedText`) |
| `numberFields: [{id,label,default,min,max}]` | числовые поля под input (образец — лимиты субагента: шаги/токены/время) → `result.fieldValues[id]` |
| `checkbox: { label, initialChecked }` | «запомнить выбор» → `result.checked` |
| `contentKey: 'agentRoleModels'` | live-React-компонент в теле по КЛЮЧУ (не JSX — разные React-бандлы!); расширять union + switch в `VibeModalSimple.tsx` |
| `blocking` (деф. true), `dismissible`, `loading`, `progress`, `autoDismissAfterMs`, `onBeforeDismiss`, `onMount`, `onClose` | поведение/прогресс/lifecycle |

### `VibeModalResult`

`{ buttonId: TId | '__dismiss__'; inputValue?; checked?; fieldValues?; images?: ChatImageAttachment[]; pdfs?: ChatPDFAttachment[] }`. Проверять `buttonId === '<primary>'` перед действием (не `!== '__dismiss__'` — кнопка «Отмена» тоже валидный close). `ChatImageAttachment`/`ChatPDFAttachment` — `common/chatThreadServiceTypes.ts` (:141/:155); PDF несёт `extractedText` для инлайна в промпт, картинки уходят в чат через `addUserMessageAndStreamResponse({ images })`.

### Хелперы-шорткаты (не собирать options руками)

`confirmModal({title,body,okLabel,cancelLabel,danger})→bool`; `showImportantInfoModal({title,body,secondaryAction})`; `successModal`/`errorModal`/`warnModal`. Управление открытой: `updateHeadOptions(partial)`, `updateHeadLoading(bool)`, `closeHead(id,inputValue)`, `dismissHead()`.

### Пример: ввод с валидатором + вложениями (как «Спека из задачи»)

```ts
const res = await modal.showModal<'create' | 'cancel'>({
  title: 'Спека из задачи', icon: 'sparkle',
  input: { placeholder: 'опишите фичу…', multiline: true, validator: v => v.trim() ? null : 'Пусто' },
  imageInput: true,
  buttons: [{ id: 'create', label: 'Создать', role: 'primary' }, { id: 'cancel', label: 'Отмена', role: 'secondary' }],
});
if (res.buttonId !== 'create' || !res.inputValue?.trim()) { return; }
// res.inputValue, res.images (vision), res.pdfs[].extractedText (инлайн)
```

**Добавить НОВЫЙ тип контента** (сложнее inline-полей): расширить `VibeModalOptions` + ветку рендера в `react/src/modal-tsx/VibeModalSimple.tsx`/`VibeModal.tsx` + стиль в `media/vibeModal.css` (токенами), затем `npm run buildreact`. Инлайн-классы в JSX → маркер `@@` (см. foot-gun выше); классы из `const` — без `@@`. Для чисто TS-использования готовых опций `buildreact` НЕ нужен — хватает `npm run compile`.

## [ловушка] Тело модалки — ВНЕ `.vibe-scope`: Tailwind-компоненты из чата приезжают голыми

**Контекст:** справка «Как работать со спеками» (`bodyMarkdown: true`) содержит ```yaml-блок. Владелец заметил: «предложение закончилось на двоеточии, выглядит обрубленным».

**Суть:** блок рендерился — `ChatMarkdownRender` → `BlockCode` → `<div class="monaco-tokenized-source">` с подсветкой, текст на месте, высота ненулевая. Не было **оформления**: ни фона, ни рамки, ни падингов — три строки моноширинного текста в потоке прозы, и вводящая фраза читается как оборванная.

Причина — не в markdown и не в модалке как таковой:
- `BlockCode` (`util/inputs.tsx`) обрамляет себя **Tailwind-утилитами**: `<div className='relative z-0 px-2 py-1 bg-vibe-bg-3'>`. Без `@@` → `scope-tailwind` префиксует их в `vibe-px-2`, `vibe-bg-vibe-bg-3` и т.д.
- Эти правила действуют **только под `.vibe-scope`**. Чат внутри скоупа (`chat.closest('.vibe-scope')` → true), **тело модалки — нет** (→ false). Классы в DOM есть, `getComputedStyle` даёт `padding: 0px`, `background: transparent`.
- Модалка стилизована собственным `vibeModal.css` (классы `@@vibeide-modal-*`, экранированы → не префиксуются), Tailwind ей не нужен — поэтому расхождение и не замечали.
- В чате блок дополнительно оборачивается в `BlockCodeApplyWrapper` (фон + кнопки), но он включается только при `options.isApplyEnabled && chatMessageLocation`, а модалка передаёт `chatMessageLocation={undefined}` → остаётся голый `BlockCode`.

**Вывод шире одного бага: ЛЮБОЙ переиспользованный из чата компонент, который стилизуется Tailwind-утилитами, внутри модалки будет без стилей.** Проверять глазами, а не по «отрендерилось ли» — DOM и innerText врут, что всё хорошо.

**Применение:** стилизовать в `vibeModal.css` по стабильному якорю (`.vibeide-modal-body .monaco-tokenized-source`), а не по префиксованным `vibe-*` классам — те меняются при любой правке компонента. Обернуть корень модалки в `.vibe-scope` — **не** решение: preflight скоупа переставит стили всем контролам во всех модалках.
