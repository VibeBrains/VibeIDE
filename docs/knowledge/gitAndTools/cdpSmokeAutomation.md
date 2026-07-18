# CDP-смоук dev-IDE: agent-browser + координатные клики в OOPIF (webview/превью)

← [Knowledge Index](../README.md)

---

## [рецепт] Базовый цикл смоука

**Контекст:** живые смоуки фич dev-IDE (голос 2026-07-16, /watch 2026-07-17, inspect-превью 2026-07-18) гоняются через CDP: `./run-dev.sh --remote-debugging-port=9224 [папка-workspace]` → `node_modules/.bin/agent-browser connect 9224`. Смоуки регулярно ловят боевые баги (showinfo-формат ffmpeg 6.x; дубль interim-вставки голоса) — прогонять их стоит ДО отдачи фичи владельцу.

**Суть:**
- Command Palette: `press Meta+Shift+p`, затем текст **по одной клавише** (`press v`, `press i`, …— латиница ок; `type`/`keyboard type` на Code OSS молча не работают), выбор — `ArrowDown`×N + `Enter`.
- Верификация — скриншоты (`agent-browser screenshot <путь>.png`) + `eval` по DOM основного окна (React-чат живёт в главном документе — чипы/сообщения читаются `document.querySelector`).
- Модалки «Что нового»/офлайн-каталога закрывать `Escape` до начала сценария.
- По окончании: `agent-browser close` + `kill $(lsof -t -i :9224)` — dev-IDE держит 1-4 ГБ.

## [рецепт] Клик по координатам внутрь webview (OOPIF) — agent-browser не умеет, raw CDP умеет

**Контекст:** превью Vibe Server — webview (vscode-webview://, out-of-process iframe), внутри него — второй iframe с origin сервера. `agent-browser click` принимает только CSS-селектор/`@ref` главного документа, `snapshot -i` **не обходит OOPIF** — элементы хрома превью и страницы невидимы и некликабельны.

**Суть:** сырой `Input.dispatchMouseEvent` на **корневом** page-таргете роутится браузерным процессом по hit-test'у — добивает до вложенных OOPIF любой глубины (webview → iframe превью). Мини-скрипт (модуль `ws` брать из node_modules репо через `createRequire`):

```js
const list = await (await fetch('http://127.0.0.1:9224/json')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('workbench-dev.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
// mouseMoved (hover) → mousePressed → mouseReleased, координаты в CSS-пикселях
ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 } }));
```

Координаты снимать со скриншота: при `devicePixelRatio: 1` (дефолт dev-IDE) пиксели скриншота == CSS-пиксели (сверить `eval 'window.innerWidth'` с шириной скриншота). Для hover-эффектов слать `mouseMoved` перед кликом.

**Применение:** любой смоук, где надо жать кнопки в хроме превью или кликать по странице внутри превью. Инжект-скрипт и хром общаются postMessage'ем — результат клика проверять по ЭФФЕКТУ в главном документе (чип в чате, нотификация), не пытаться читать DOM OOPIF.

**Антипаттерны:** `agent-browser click "x,y"` — это селектор, не координаты; `type`/`fill` в Monaco/textarea на Code OSS — молча теряют текст (только `press` по клавише); ждать элементы webview в `snapshot` — их там не будет.

**Связано:** [[vibeDocsGraph]] — чем врут CDP-проверки; `docs/knowledge/voice/localSttSherpaOnnx.md` — CDP-eval живёт в изолированном мире, Trusted Types бьёт createElement('script'); [[previewInspectElement]] — устройство трубы postMessage превью.
