# Прокси для LLM-трафика: единый undici-диспетчер + SOCKS-коннектор

← [Knowledge Index](../README.md)

---

## [архитектура] Один shared-диспетчер как точка внедрения прокси; undici + SOCKS вручную

**Контекст:** запрос — «дотянуться до гео-заблокированных API моделей» (Anthropic/OpenAI отвергают запрос по региону IP). DPI-обход (WinDivert/zapret) тут не помогает: он бьёт по блокировке *провайдером* и не меняет IP; API моделей блокируют на *своей* стороне по гео. Решение — маршрутизация исходящих запросов моделей через прокси с зарубежным exit-узлом. Реализовано настройкой `vibeide.llm.proxy.url` (2026-07-19, ветка `next`).

**Суть:**

- **Все** LLM-провайдеры (Anthropic, OpenAI-совместимые, Gemini, Mistral, динамические из `.vibe/providers.json`) и **оба** кодопути отправки (legacy `sendLLMMessage.impl.ts` + AI-SDK `aiSdkAdapter.ts`) резолвят **один общий undici-диспетчер** через `ensureSystemCADispatcher()`. Часть провайдеров (Gemini, Mistral) вообще ходит через global-fetch, для которого тот же вызов делает `setGlobalDispatcher`. → **Единственная правка, покрывающая всех, — в `buildDispatcher()`** ([systemCAFetch.ts](../../../src/vs/workbench/contrib/vibeide/electron-main/llmMessage/systemCAFetch.ts)). Не нужно трогать 20+ мест создания клиентов.
- **HTTP/HTTPS-прокси** → undici `ProxyAgent` (CONNECT-туннель). `requestTls.ca`/`proxyTls.ca` = системный CA-бандл, чтобы не потерять доверие к корпоративному MITM (иначе `SELF_SIGNED_CERT_IN_CHAIN`). Креденшелы из URL → `token: Basic base64(user:pass)`, из uri вычищаются (без двойной авторизации).
- **SOCKS4/5/5h** → **undici нативно SOCKS не умеет.** Открываем SOCKS-соединение сами (`SocksClient.createConnection` из пакета `socks`), получаем raw-сокет и отдаём его undici-коннектору (`buildConnector({ ca })`) через `{ ...options, httpSocket: socket }` — undici делает TLS к реальной цели поверх туннеля. Хост цели резолвит **прокси** (socks5h-семантика) и для `socks5`, и для `socks5h` — то, что нужно exit-узлу против DNS-блокировок.
- Прокси — **процесс-глобальный** (как и сам диспетчер), хранится модульной `_proxyUrl` в том же файле. `setLLMProxyConfig(url)` вызывается из `sendLLMMessage()` на каждый запрос: no-op при неизменном значении, при смене — `resetSystemCADispatcher()` пересоздаёт пул (без перезапуска IDE). Настройка `vibeide.llm.proxy.url` живёт в renderer-конфиге, доезжает в main полем `proxyUrl` в `LLMRuntimeOptions` (тем же каналом, что `timeoutMs`).

**Применение:**

- Новый провайдер/SDK автоматически получает прокси, **если** его клиент резолвит `ensureSystemCADispatcher()` (через `fetchOptions.dispatcher` или global-fetch). При добавлении провайдера — проверить, что клиент не создаёт свой собственный dispatcher/agent в обход.
- Настройка процесс-глобальна: пер-запрос разные прокси **не** поддерживаются (и не нужны). Если однажды понадобится — это уже не `_proxyUrl`-синглтон, а диспетчер на ключ.
- `socks` — теперь **прямая** зависимость (`package.json`); раньше был транзитивным через `@vscode/proxy-agent`→`socks-proxy-agent`. Полагаться на транзитив нельзя — сломается при смене дерева.

**Антипаттерны:**

- **Не** тащить DPI-обход (WinDivert/zapret) в IDE: не решает гео-блок (IP не меняется), Windows-only, kernel-драйвер + админ-права — три нарушения слоя и кросс-платформенности.
- **Не** использовать `socks-proxy-agent` для этого пути: он строит node `http.Agent`, а AI-SDK-трафик идёт через **undici**, а не `IRequestService`. `http.proxy` (апстрим, `getProxyAgent`) обслуживает обновления/маркетплейс и AI-запросы **не** покрывает.
- **Не** ронять отправку из-за плохого URL прокси: `buildDispatcher` логирует `vibeLog.error` и падает на прямое соединение — диспетчер всегда валиден (симптом — видимая гео-блокировка, а не «клиент без диспетчера»).

**Связано:** [[providerDiagnostics]] (кнопка «Сбросить клиентов» дёргает тот же `resetSystemCADispatcher`), [[providerQuota429]] (customFetch поверх этого же диспетчера), [[upstreamBoundary]] (`http.proxy` — апстримовый слой, не трогаем).
