# Saved release notes — v0.13.14 (deleted, content reused for next release)

> **Source:** GitHub Release v0.13.14 (created 2026-05-24 by `release-windows.ps1`,
> deleted same day by user request after discovering workbench-freeze regression
> from modal-blocking-at-startup). The body below was original — donation phrase
> «Toast можно закрыть не глядя, модал — нужно прочитать. У автора с кнопкой
> ниже та же дисциплина: проигнорировать сложнее.» NOTE: that phrase is no
> longer apt after we revert `loaded_from_local` back to a toast — pick a new
> one for the next release.

---

## ✨ Новое

- **VibeModal — кастомный модал-фреймворк.** Workbench-level портал с собственным сервисом и React-контейнером. Темизация **только через `var(--vscode-*)`** — модалы выглядят нативно в Default Dark+, Light+, High Contrast и Vibe Neon без overrides. API: `showModal<T>` Promise / FIFO queue / focus-trap / ESC dismiss / Enter→primary / hotkey-bindings / `aria-live` announce. Опции: `size: 'small'|'medium'|'large'`, `loading`, `progress: {current,total,label}`, `autoDismissAfterMs` (с pause-on-hover/focus/loading), `onBeforeDismiss` veto с timeout-защитой, `onMount`/`onClose` lifecycle, keyboard-hint footer.
- **Shortcuts на сервисе:** `confirmModal({title, body, danger?})`, `successModal`/`errorModal`/`warnModal` пресеты, `showImportantInfoModal`. Closer'ы: `resolveHead` / `dismissHead` / `dismissHeadWithVeto` / `closeHead` (programmatic bypass).
- **Command Palette: «VibeIDE: Перепроверить каталог models.dev».** Сбрасывает in-memory cache и заново проходит priority chain без рестарта IDE. Loading-модал во время probe → result-модал с семантическим лейблом источника.

## 🐛 Исправления

- **models.dev — Roaming больше не побеждает.** Приоритет поиска snapshot'а перестроен: `exeDir → resourcesPath (bundled) → userData (Roaming)`. Файл, который пользователь положил рядом с `VibeIDE.exe`, теперь побеждает auto-cached Roaming-копию (ранее corporate-пользователи на work-машинах получали toast с Roaming-путём вопреки policy «положи рядом с exe»).
- **Fast-path priority bug** — pre-fix реализация читала только `userData` с TTL → даже свежий exe-adjacent файл игнорировался в пользу stale Roaming-cache. Fast-path переписан: exeDir/bundled читаются безусловно, userData — с TTL.
- **Toast → VibeModal для `loaded_from_local` + `failed`.** Важная info про каталог моделей раньше могла быть закрыта пользователем «не глядя» как toast. Теперь модал с семантическим лейблом источника («снимок, который вы положили рядом с VibeIDE.exe» / «встроенный снимок» / «кэшированный»), copy-URL action, open-URL action.
- **Broken `models.dev.json` snapshot перестал быть silent.** `console.warn` различает не-ENOENT read errors, JSON-parse failures, parsed-but-empty providers — пользователь видит actionable причину в DevTools.
- **`aria-hidden` restore bug.** Модал-контейнер при закрытии сохранял original-value `aria-hidden` и `inert` на workbench-siblings (sidebar etc) — не корраптит VS Code a11y state.
- **`onBeforeDismiss` hung-callback trap.** Default `onBeforeDismissTimeoutMs: 30s` — buggy veto-callback больше не trap'ит пользователя без возможности закрыть модал.
- **`autoDismissAfterMs` clamp.** Минимум 500ms (anything shorter — visual flash); warn one-per-session при clamp'е.
- **Keyboard hint multiline support.** Для textarea-модалов hint показывает корректный `Ctrl+Enter` / `⌘+Enter` commit shortcut вместо ложного `Enter`.
- **Per-button hotkey hints.** Каждый hotkey-button получает свой `<kbd>` chip с action label вместо генерик «Y/N hotkeys».
- **VibeModalService dispose drain.** Pending modals резолвятся с `__dismiss__` на shutdown — нет orphaned promise'ов.

## 🚀 Производительность

- **Status-bar idle leak.** `vibeideStatusBar` 500ms-polling выключается когда нет активного stream'а (~36k allocs за 5h idle устранены).
- **chatLatencyAudit context leak.** `completeRequest` теперь runs unconditionally — pre-fix render-monitoring interval (60fps) не останавливался при выключенном audit'е и при model fallback chain'е.
- **URI restore в thread persistence.** `URI.from` → `URI.revive` при загрузке persisted threads — cheaper restore без full re-parse (заметно на workspace'ах с сотнями persisted URIs).

## 🔒 Безопасность

- **a11y enforcement при открытом модале.** `inert` + `aria-hidden` на workbench-siblings — screen reader не может перепрыгнуть к workbench-элементам за backdrop'ом. Cleanup сохраняет original-value на restore.
- **Defensive `safeOnClose` wrapper** для caller-side lifecycle hooks — throwing hook логирует warning, не ломает modal flow.

## ♻️ Внутреннее

- **`common/modelsDevCatalogConstants.ts`** — `MODELS_DEV_URL` + `LOCAL_SNAPSHOT_FILENAME` + `labelOfSource` (был duplicate в 3 файлах).
- **`IModelsDevCatalogStatusService.onDidChangeStatus`** event — subscribers реагируют на recheck без polling. IPC contract разделён на `IModelsDevCatalogStatusServiceIPC` (methods) + service interface с event.
- **`recheckCatalog`** consolidated из дубля `_refreshCatalogForTests` (production + tests используют одну функцию).
- **30 «commit forthcoming» меток** в roadmap'е заменены на реальные хеши — roadmap стал working reference.
- **«COMPLETE HACK» / «SYSTEM MESSAGE HACK» комментарии** в `convertToLLMMessageService.ts` переписаны как описательные (объясняют intentional single-pipeline trim для system+chat).
- **48 unit-тестов** для VibeModalService (cumulative через 4 audit-rounds) — push/resolve/result, dismiss matrix, FIFO ordering, change events, loading toggle, confirmModal, closeHead, dismissHeadWithVeto with sync/async/throwing callback + timeout, updateHeadOptions, severity presets, onClose lifecycle, hotkey field, dispose drain.
- **VibeModal CSS** через `var(--vscode-*)` исключительно — переключение темы (Dark+/Light+/HC/Vibe Neon) не требует overrides.
- **Roadmap policy Z.10** — VibeModal audit-rollover terminate, parallels X.20.1 для XML normalize. Дальнейшие passes — только по triggers (incident / major refactor / pre-release).

## 📦 Сборка

- **`build/.moduleignore`** расширен правилами для нового flat-naming `@xterm/addon-*` (mirror legacy `@xterm/xterm-addon-*`) — X.12 ligatures fix.

---

### Поддержать проект

Если VibeIDE оказалось полезным — буду рад благодарности.
Toast можно закрыть не глядя, модал — нужно прочитать. У автора с кнопкой ниже та же дисциплина: проигнорировать сложнее.

<a href="https://raw.githubusercontent.com/borodatych/VSCodeSyncFiles/main/media/QR-Code.jpg" target="_blank">
  <img src="https://raw.githubusercontent.com/borodatych/VSCodeSyncFiles/main/media/QR-Code.jpg" width="120" alt="QR-код для поддержки проекта">
</a>

