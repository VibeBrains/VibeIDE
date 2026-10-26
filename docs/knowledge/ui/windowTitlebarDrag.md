# Титул-бар окна и drag-зона (узкие окна)

← [Knowledge Index](../README.md)

Grabbable-зоны `-webkit-app-region`, compact-режим правого тулбара, ловушки замеров оконных жестов.

---

## [баг] Узкое окно не перетаскивается за шапку: drag-зона умирает молча, scrollWidth-триггер её не видит

**Контекст:** WINDOW-DRAG-1026 — в окне ≤~460px за шапку не за что схватиться (grabbable-зона 9px), после растягивания drag работает. Диагностика синтетическим сканированием ширин через CDP (`resizeTo` из рендера — нативный ресайз, подтверждённый `outerWidth`).

**Суть:**
- Свободная drag-зона в кастомном титул-баре (`window.titleBarStyle: custom`) — фоновый `DIV.titlebar-drag-region` (prepend в `.titlebar-container`); видимая часть = фон минус покрывающие элементы. Пустые контейнеры `.titlebar-left/center/right` не перехватывают hit-test — только реальные айтемы.
- Левая зона под нативными traffic-light macOS (~78px, в скриншотах страницы их НЕ видно — это оверлей ОС поверх контента) не grabbable — исключать из замера.
- **Ловушка триггера:** `.titlebar-center` имеет `min-width: 0` и вбирает всё сжатие (`width: 60%; max-width: fit-content`), поэтому `scrollWidth > clientWidth` **никогда не выполняется** — штатный `updateTitleBarToolBarOverflow()` (#303222) молчит, пока drag-зона умирает. Триггер компактности — только по `clientWidth` (CSS px, зум-инвариантно), не по overflow.
- Правый `action-toolbar-container` — `WorkbenchToolBar` со счётным overflow (`overflowBehavior.maxItems`), шириновый overflow не поддерживает; его собственный «...» (`ToggleMenuAction`) — готовая альтернатива: ушедшие в `secondary` действия рендерятся в dropdown автоматически.
- В dev-стенде (`scripts/code.sh`, фреш-профиль) first-run онбординг перекрывает окно `.vibeide-modal-backdrop`, а после закрытия модалки остаётся **инертный бэкдроп/`vibeide-modal-root.is-active`** без содержимого — перехватывает hit-test. Побочная находка: корень модалок иногда не снимает `is-active` (бэкдроп пустой). Для стендов: удалять пустой бэкдроп и снимать `is-active`, когда диалога нет.

**Применение:**
- Любой фикс раскладки титул-бара проверять сканом grabbable-зоны по ширинам (≥24px на целевых узких), таблицей кликабельности (центр каждого интерактива → `elementFromPoint` ∈ элемент, цепочка app-region ≠ drag) и открытием «...» (действия не теряются). Гейт: `/Volumes/Storage/Caches/vibeide/window-drag-1026/red-loop.sh`.
- Не выдавать статический замер за живой жест: CDP Input (Playwright mouse) **не двигает нативное окно** через app-region в этом Electron; `python3-Quartz` отсутствует; у System Events нет drag-примитива. Реальный жест — только HITL (`hitl-drag.sh <ширина>`, измерение `screenX/screenY` по CDP).
- Окно двигается/ресайзится из рендера: `window.moveTo`/`window.resizeTo` работают в Electron (но это не жест drag).

---

## [механика] Компакт-режим правого тулбара (WINDOW-DRAG-1026, фикс)

**Контекст:** фикс в `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` (upstream-файл, уже несёт правки VibeIDE): `updateActionToolBarCompact()` по ширине `< 540px` (+гистерезис 64) включает compact — layout/trailing-global действия уходят в `secondary` → штатный «...»; `createActionToolBarMenus` пересобирает меню на смену режима. Порог 540 выбран замером: 560px ещё даёт 27px зоны, 520px — уже 17px.

**Суть:** действия не скрываются без альтернативы (dropdown «...» — существующий механизм), editor/activity действия на месте, no-drag на интерактивах не тронут (правый тулбар не имеет drag-предка — app-region ему не нужен; command-center контейнер — `drag`, его айтемы явно `no-drag`, см. комментарий в titlebarpart.css).

**Применение:** при изменении набора кнопок шапки (новые CommandCenter-вклады) перепроверять порог 540 замером; compact действует и на `AuxiliaryBrowserTitlebarPart` (aux-окна часто узкие — поведение осознанно).
