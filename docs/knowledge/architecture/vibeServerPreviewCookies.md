# Vibe Server: cookie-авторизация в превью (SameSite-фикс)

← [Knowledge Index](../README.md)

---

## [архитектура] Перезапись Set-Cookie для cross-site iframe превью (VS.6, 2026-07-06)

**Контекст:** дев-сайт в embedded-превью живёт в iframe, чей top-level — всегда `vscode-webview://` (сменить схему нельзя, прокси-обход не лечит). Для Chromium это cross-site контекст: любой `Set-Cookie` без `SameSite=None; Secure` молча отбрасывается → логин на превью не работает. Репорт согласован 2026-07-05; из трёх вариантов (перезапись в main / top-level `WebContentsView` / предупреждение в UI) выбрана Electron-нативная перезапись — без HTTP-прокси, из-за рисков которого (HMR/WebSocket, form-submit) прокси осознанно не брали в MVP.

**Суть:**
- **Где:** webview делит `session.defaultSession` с окном (отдельной partition нет) → перехват в `app.ts#configureSession()`. **ГОЧА Electron:** на сессию допускается ОДИН обработчик `webRequest.onHeadersReceived` — новая регистрация ЗАМЕНЯЕТ предыдущие (апстрим сам зовёт его дважды: SVG и PRSS CORS). Поэтому наш вызов `maybeRewritePreviewCookies()` **встроен внутрь последнего апстрим-хендлера**, а не зарегистрирован отдельно.
- **Что:** pure `common/vibeServer/setCookieCompat.ts` — `rewriteSetCookieForPreview()`: срезать существующие `SameSite`/`Secure`, дописать **пару** `SameSite=None; Secure` (идемпотентно; `None` без `Secure` Chromium отбрасывает целиком; `Secure`-кука доставляется по plain-http на loopback — trustworthy origin по Secure Contexts spec).
- **Двойной гейт** (`electron-main/vibeServer/vibeCookieCompatMain.ts`): (1) origin зарегистрирован — renderer (`vibeBrowserManager`) регистрирует URL вкладки через IPC `registerPreviewOrigin`/`unregisterPreviewOrigin` (канал Vibe Server) при open/navigate/`navigated`/dispose, рефкаунт по вкладкам; (2) хост — loopback (127.0.0.1/localhost/[::1]). Нет открытого превью → пустой реестр → zero-cost pass-through; куки посторонних localhost-сервисов (LSP, debug-адаптеры) не трогаются.
- **Конфиг:** `vibeide.vibeServer.cookieCompat` (default true) — гейт на стороне renderer (при выключенном просто не регистрируем; unregister безусловный — конфиг-флип посреди сессии не оставляет хвостов). В main конфиг не проброшен вовсе.
- Один `vibeLog.info` на origin за время регистрации — видно, что механизм сработал, без per-request спама.

**Применение / границы:**
- LAN-превью на телефоне фикс НЕ покрывает: там куки режет реальный браузер телефона — вне нашего контроля.
- Если у Chromium когда-нибудь ужесточится `Secure`-на-http-loopback — фолбэк уже есть: `vibeide.vibeServer.https` (self-signed).
- При апстрим-мерже `app.ts` следить за блоком PRSS CORS `onHeadersReceived` — наш вызов должен остаться внутри ПОСЛЕДНЕГО зарегистрированного хендлера.
