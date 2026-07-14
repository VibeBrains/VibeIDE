# roadmap-max run log

Each entry = one autonomous `/roadmap-max` session. Append new entries at the bottom.
Full closed-item list is in git history — only record surprises and new patterns here.

---

## 2026-05-10/11 — sessions 1–4

**Closed:** 67 total (40 + 7 + 8 + 8 + 4 already-done confirmations)
**Skeleton:** ~50 items remain (L-task design required)
**Blocked:** 13 (7 external credentials, 6 Playwright E2E)

**Surprising blockers:**
- `tsgo` TypeScript compiler has 5 pre-existing React `out/` bundle errors (`mountCtrlK` / `mountVibeTooltip` / `mountVibeOnboarding` / `mountVibeSelectionHelper` / `mountVibeSettings`). Not fixable from `src/` side — caused by React bundles generated via `npm run buildreact`. Treat as baseline noise; filter by filename when scanning compile output for real regressions.
- `Disposable` base class reserves the `_store` member — new services must use `_memory` / `_state` instead.
- Slavic apostrophe (`snapshot'ы`, `embedding'и`, `runbook'ов`) inside single-quoted JS strings breaks TS parser. Rephrase to apostrophe-free forms (`снапшоты`, `embeddings`, `runbook-сценарии`).

**New patterns adopted:**
- **Standalone configuration files** (`vibeAgentBehaviorConfiguration.ts`, `commandsAuditPrivacyConfiguration.ts`) — registration-only TS file; consumer service keeps using `getValue` unchanged. Good pattern for grouping related config keys.
- **CommonJS mirrors in `scripts/lib/`** — CJS version of a TS helper for CLI scripts that run without compilation. Header `// MUST stay in sync with src/...` + 12–15 `node:assert` self-tests each.
- **Brand-name allowlist** in i18n scanner — 19 product nouns (Anthropic, Mistral, AWS Bedrock, etc.) in `BRAND_ALLOWLIST` set; skips forced localization of brand names.
- **`appRoot`** comes from `IWorkbenchEnvironmentService`, not `IEnvironmentService`; in browser-layer files use `process.cwd()` or `INativeWorkbenchEnvironmentService`.
- **`CompletionCache.get/set`** requires explicit `now: number` arg; property is `maxEntries`, not `maxSize`.
- **`serializeProjectCommandsInitTemplate`** requires `{ vibeVersion }` object as first argument.

---

## 2026-05-11 — session 5

**Closed:** 5 items (L1021, L306, L1159, L1160-partial, L991-already-done)
**Skeleton:** 66 items remain
**Blocked:** 13 unchanged (external credentials / Playwright)

**Surprising items:**
- `IFileService` does not support atomic append — JSONL logging in `autocompleteService.ts` uses read+append+write pattern (acceptable for low-frequency Tab events). Future high-frequency paths should use a write-debounced buffer or a Node-side `fs.appendFileSync` in a native service.
- `perf-guardrails-contract.md` was already present in `references/v1/` from a prior session — L991 doc part was done.
- `release.js` dispatcher maps win32 → `release-windows.ps1` via `spawnSync`; darwin/linux fail-loud with explicit unblock instructions. SHA256 in the manifest is `'0'.repeat(64)` placeholder — real hashing awaits a `crypto.createHash` pass after all platform builds complete (multi-platform scenario only).

**New patterns adopted:**
- **`DisposableStore` for dynamic watchers** — `_globalPathWatcherStore = this._register(new DisposableStore())` registers once; `.clear()` + refill on config change. Clean pattern for subscriptions that change over time.
- **`release.js` dispatcher pattern** — thin Node script that `spawnSync` the platform-specific shell script, then collects artefacts and writes `.vibe/release-manifest.json` via a CJS mirror. Extendable to darwin/linux when those scripts ship.

---

## 2026-05-16 — session 9 (Root cause найден: array-as-record в `convertToolsToAiSdkToolSet`)

**Closed:** 4 items — Q.0 (array fix), Q.1 (disposable leak), Q.2 (kept heuristic safeties, documented unblock), Q.3 (lesson learned recorded)
**Skeleton:** 0
**Blocked:** 0

После 7 предыдущих сессий обхода симптомов (numeric tool names квирка минимакса) пользователь дал решающий артефакт — request body, который мы реально шлём провайдеру. В нём `tools[].name` = `"0", "1", "2", "3", "5", ...` — мы регистрировали тулы с именами = ИНДЕКСАМИ МАССИВА. Минимакс не имел никакого quirk'а, она добросовестно вызывала имена которые мы ей присылали.

Корневая причина: `convertToolsToAiSdkToolSet(allowed, ...)` ожидала `{[k: string]: InternalToolInfo}` (record), на call site передавался `InternalToolInfo[]` (массив) с `as any` cast. `Object.keys(массив)` возвращает `["0", "1", "2", ...]`. Эти индексы стали именами регистрации. Полный анализ + retro по всем попыткам лечения симптомов — в `docs/knowledge/architecture/toolCalling.md`.

**Что считаем уроком (вечнодействующее правило):**

- **`as any` на параметре функции принимающей structured data — антипаттерн уровня priority bug.** Если типы не совпадают — рефакторить, не маскировать. Этот один-line cheat стоил 10 часов отладки и 8 итераций релизов.
- **Когда возникает шаткое поведение модели — request body всегда первое что смотреть.** Не headers, не system prompt, не SDK маршрутизация — а РОВНО ТЕ БАЙТЫ что идут к провайдеру. Если бы мы это сделали в первой итерации (capture via customFetch logging), нашли бы за 30 минут.
- **Все эвристики из секции O (auto-downgrade pipeline, alias maps, positional fallback, headers spoofing) остаются на месте как универсальные safety nets** — они не вредят, ловят гипотетические future-квирки, и оправдывают свою сложность тем что подсветят ровно так же быстро если завтра придёт другой root cause.

**Architectural decisions:**

- Поправлена сигнатура `convertToolsToAiSdkToolSet` — теперь принимает **и массив, и record**. Inside iterate как массив через `Array.isArray(allowed) ? allowed : Object.values(allowed)`. Имя берётся из `t.name`, не из ключа. Это устойчивее к type drift с обеих сторон.
- `as any` cast на call site убран. TypeScript теперь поймает аналогичную ошибку в будущем.
- Heuristic-фиксы из O.0–O.10 НЕ откатывал — они дают universal safety. Откат — отдельным PR при желании облегчить код (Q.2).

**Surprising blockers:**

- `as any` подавил TypeScript error который иначе указал бы на bug. Один час дебаггинга вместо десяти часов гонки за симптомами — если бы был type-safe.
- **`Object.keys(массив)` в JavaScript возвращает индексы как строки.** Знал теоретически, не вспомнил практически. Если в коде где-то есть structured data + Object.keys + as any — review immediately.
- Пользователь дал решающий артефакт через копирование fullError из chat error notification. Без этого продолжали бы лечить симптомы.

**New patterns adopted:**

- **Request body capture — first response к flaky-model bugs.** Будущий процесс: если model behaves странно через какой-то провайдер, capture HTTP request body (через `transformRequestBody` callback или log в customFetch wrapper) ПЕРЕД любыми догадками про prompt/SDK/headers. Это диктует workflow для future model-quirk debugging.
- **Disposable timeout with store** — `disposableTimeout(handler, ms, store)` чище чем wrapper самодиспоса в callback. Store auto-leaks (cleans) после fire. Применимо ко всем будущим debounced patterns.

---

## 2026-05-16 — session 8 (Data-driven SDK routing — корень проблемы найден)

**Closed:** 1 item — P.0 (modelsDevCatalog) + insight refactoring across knowledge docs
**Skeleton:** 3 items — P.1 (other SDK adapters), P.2 (persistent disk cache), P.3 (user override UI)

Контекст: после 7-й сессии (auto-downgrade O.0-O.10) минимакс через openCode-Go всё ещё ломался на циклы tool-error → circuit-breaker. Пользователь указал что в opencode CLI минимакс работает. Гипотезы headers (`x-opencode-*`) и спуф Kilo не помогли. Истинная причина обнаружена через **официальную доку opencode.ai/docs/go**: aggregator выставляет ДВА endpoint'а, минимакс ходит через Anthropic-protocol `/v1/messages`, мы шлём в OpenAI-protocol `/v1/chat/completions` → silent degeneration модели.

**Architectural decisions:**

- **modelsDevCatalog как single source of truth.** Hardcoded model name lists / regex по семейству — антипаттерн, потому что новые модели/семейства требуют code change. models.dev/api.json имеет `provider.npm` override per-model — это и есть data-source. Загружаем лениво, кешируем, матчим aggregator по `provider.api === baseURL`, model по id.

- **Zero hardcode после фикса.** Никаких `OPENCODE_GO_ANTHROPIC_MODELS`, никаких regex `/^minimax/`. Завтра `maximax-m1` в models.dev — works automatically.

- **Fallback на openai-compatible при сбое models.dev.** Если registry недоступен, модель попадёт в default путь и при квирках сработает auto-downgrade pipeline (O.0-O.10). Двойная страховка.

**Surprising blockers:**

- models.dev's `/v1/models` endpoint у opencode-go возвращает только `{id, object, created, owned_by}` — никакого протокола. Routing info живёт **только** в models.dev/api.json (community registry), не у самого aggregator.
- В models.dev структура нестандартная: `provider.npm` это default для провайдера, но `models[id].provider.npm` — это per-model override. Поле `provider` на уровне модели имеет другой смысл чем `provider` на уровне всего корня. Нужно читать через `((m as any).provider as any)?.npm`.
- `@ai-sdk/anthropic@3.0.78` имеет `createAnthropic({baseURL, apiKey, headers, fetch})(modelName)` API (модель — functional call, не `.chatModel(...)` как у openai-compatible).
- `npm install @ai-sdk/anthropic` сразу залил 25 vulnerabilities (13 moderate, 12 high). Pre-existing для других deps; не блокирует ничего, отметим в N (compliance).

**New patterns adopted:**

- **Community-registry-backed routing** — pattern «спросить у models.dev» применим к любому per-model решению (protocol, capabilities, cost, deprecation). Не только SDK выбор. Если ставится вопрос «как узнать X про модель» — первый ответ models.dev, второй ответ — поле в `ModelOverrides` (manual override), третий — code default.

- **`provider.api` URL matching вместо provider id mapping** — раньше я хотел писать `VIBEIDE_PROVIDER_TO_MODELS_DEV_ID = { openCode: 'opencode-go' }`. Это лишний слой и хардкод. matching по URL (`provider.api === baseURL`) полностью убирает связь имён.

- **Lazy module-level Promise<T | null> cache** — `let catalogPromise: Promise<CatalogIndex | null> | null = null` плюс `if (!catalogPromise) catalogPromise = fetchAndIndex()`. Первый caller инициирует fetch, последующие await тот же promise. Network-failure → resolve(null), не reject; caller проверяет на null и fallback'ит. Чище чем try-catch вокруг каждого вызова.

---

## 2026-05-16 — session 7 (Tool-call resilience — model-quirk auto-detect)

**Closed:** 11 items — O.0, O.1, O.2, O.3 (pre-existing confirmation), O.4, O.5, O.6, O.7, O.8, O.9, O.10 + bonus O.9.1 (stale-override bug fix)
**Skeleton (`- [~]`):** 0
**Blocked:** 0

После первого захода (8 closed, 2 skeleton) пользователь попросил доделать оставшиеся два пункта в этой же сессии — реализованы active re-probe (O.9, in-memory счётчик + per-iteration probe + outcome handling) и React Diagnostics панель в Settings (O.10, реактивная таблица с Revert/Pin actions). Бонусом найден и пофикшен stale-override bug в agent loop — `overridesOfModel` теперь читается заново на каждой iteration (O.9.1).

Контекст: за итерации v0.9.1–0.9.3 был накоплен hardcoded substring-match по `lower.includes('minimax')` / `/\bm2[-.]?7\b/` / `lower.includes('qwen')` в `aggregatorOpenAIFallback`, чтобы насильно force XML для известно-сломанных моделей. Пользователь правомерно поставил вопрос: «можно ли без хардкода». Сделано: data-driven runtime auto-downgrade, наблюдающий поведение модели и сам пишущий persistent override в settings.

**Architectural decisions:**

- **Runtime auto-downgrade вместо substring-match.** `consecutiveToolErrorsByModel: Map<string, number>` в `_runChatAgent` отслеживает ошибки per-(provider×model). На `AUTO_DOWNGRADE_THRESHOLD = 3` срабатывает `setOverridesOfModel` с метадатой `{ _autoDetected, _detectedAt, _reason }`. Никакого hardcode имён моделей.

- **Override metadata через подчёркнутые поля.** `ModelOverrides` расширен `_autoDetected?: boolean`, `_detectedAt?: number`, `_reason?: AutoDowngradeReason`. Префикс `_` — convention «системное поле». `getModelCapabilities` применяет TTL-check (7 дней) только для auto-detected override'ов; manual user-set overrides живут вечно.

- **In-session retry — нативно через loop continuation.** После записи override agent-loop НЕ прерывается — следующий итеранс while-loop читает `getModelCapabilities` снова, который уже видит override и возвращает `specialToolFormat: undefined`. Никакого специального retry-кода.

- **Enum-setting вместо двух флагов.** `vibeide.llm.toolFallbackMode: 'auto' | 'native' | 'xml'` заменил deprecated boolean `vibeide.llm.assumeNativeTools`. Migration в `sendLLMMessageService.ts`: `assumeNativeTools=false` без явного нового mode → синтезируется `'xml'`. `'native'` mode игнорирует auto-detected override'ы (override-the-override для пользователей, недовольных auto-downgrade).

**Surprising blockers:**

- `setOverridesOfModel(providerName, ...)` имеет строгий тип `Exclude<ProviderName, 'auto'>`. После `resolveAutoModelSelection` пройти весь narrowing TS не может — нужен явный `as Exclude<typeof resolvedModelSelection.providerName, 'auto'>` cast. Документировано inline.
- TypeScript narrowing через type-guard `isABuiltinToolName(toolName)` ломается даже при реассайнменте параметра `let toolName` где-либо в функции. Прошлая итерация (v0.9.2) уже потребовала переименования параметра в `requestedToolName` + `const toolName = ...` через тернарник. Подтверждено в этом проходе.
- `getModelCapabilities` spread'ит overrides последним: `{ ...modelOptions, ...overrides, ... }` — это значит auto-метадата `_*` тоже попадает в return value. TypeScript не показывает их (return type ограничен `VibeideStaticModelInfo`), но runtime они есть. Consumers их не используют — нет проблемы.

**New patterns adopted:**

- **`_*`-prefixed metadata fields in user-facing types** — `_autoDetected`, `_detectedAt`, `_reason` в `ModelOverrides`. Префикс маркирует «system-managed, не редактируйте вручную в JSON» (хотя технически можно). Чище чем отдельная settings-секция.
- **Per-(scope×subject) counter pattern для autodetect** — `Map<string, number>` с строковым ключом `${scope}:${subject}` (в нашем случае `${providerName}:${modelName}`). Reset on success per key. Один раз на сессию trigger через `Set<string>` для downgrade'ов. Применимо к любым другим heuristic detect'ам в будущем (per-thread error rate, per-tool failure rate и т.п.).
- **Backward-compat migration через synthesized field** — при чтении новой настройки в `sendLLMMessageService`: если старая boolean установлена и новая не установлена, синтезируется ожидаемое значение нового типа. Старая read-path сохраняется как secondary fallback в downstream code (legacy code paths не ломаются).

---

## 2026-05-11 — session 6 (Вкладка Б, context-resumed)

**Closed:** 8 items — L332, L344, L931 (confirmed), L1052, L323, L881, L904/L933, L1122 — all in commit `cc43b75c`
**Skeleton:** 12 items remain in Вкладка Б (runtime adapters, React UI panels, status-bar migration, CLI package, LSP decoration)
**Blocked:** 0 new (all pre-existing)

**Surprising blockers:**
- `IDebugService.onDidChangeBreakpoints` does not exist — events are on `IDebugModel` returned by `getModel()`. VS Code API surface differs from what intuition suggests.
- `IBreakpoint` has no numeric `hitCount` property — has `hitCondition` (string expression). Hardcode `hitCount: 0` in snapshot until hitCount tracking is added.
- `DebugContextForAgent` exposes `markdownBody`, not `markdown`. The naming diverges from the builder function name.
- Adding `vibeide` namespace to the `return <typeof vscode>{...}` in `extHost.api.impl.ts` fails TS2352 if the real module is not yet wired. Fix: add stub implementations that return `Promise.reject(new Error(...))` — satisfies the type without lying about functionality.
- `docs/` is gitignored project-wide — `roadmap.md` updates are local-only and cannot be committed.
- `IChatThreadService` has no direct `sendMessage` API. Solved via Emitter-bridge pattern: `IVibeWorkflowService.onWorkflowRunRequested` fires → `VibeWorkflowChatDispatchContribution` calls `addUserMessageAndStreamResponse`.

**New patterns adopted:**
- **Emitter-bridge contribution** — when Service A needs to trigger Service B but they can't depend on each other, put an Emitter on A and register a browser contribution that wires A.event → B.method. Clean, testable, avoids circular imports.
- **Personas import with SubtleCrypto** — `crypto.subtle.digest('SHA-256', body)` for pack verification in browser layer; avoids Node-only `crypto.createHash`. Buffer → hex via `Array.from(Uint8Array).map(b => b.toString(16).padStart(2,'0')).join('')`.
- **`ITooltipWithCommands` as right-click substitute** — VS Code status-bar entries don't natively support right-click context menus; `ITooltipWithCommands.commands[]` in the hover tooltip is the closest available equivalent.
