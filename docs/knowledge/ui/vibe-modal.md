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
