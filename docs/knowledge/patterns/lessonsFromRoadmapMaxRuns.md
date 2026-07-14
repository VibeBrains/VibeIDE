# Lessons from roadmap-max autonomous runs

← [Knowledge Index](../README.md)

Извлечено из 30 логов прогонов skill `roadmap-max` (2026-05-08 — 2026-05-09).
Только durable паттерны/footguns — без счётчиков и имён закрытых пунктов.

---

## Footguns языка и тулинга

### [JSDoc] Литеральная последовательность `**/` терминирует JSDoc-блок
**Контекст:** при описании glob-паттернов или путей внутри `/** ... */` блока (`* src/**\/*.css → "style"`, `docs/v1/phases/*/README.md`) последовательность `*/` закрывает блочный комментарий. tsgo выдаёт стену `TS1109` / `TS1005` на следующей строке. Footgun ловится в среднем раз в квартал — за 30 прогонов встречен трижды.

**Применение:** в JSDoc-телах никогда не использовать литеральный `**/`. Заменять на прозу ("test files", "lock files"), placeholder (`<phase>`), или экранировать через `*\/`. Особенно осторожно в TSDoc / `/** ... */` блоках TypeScript.

### [TS] `ReadonlyArray<T>.push()` и `.sort()` запрещены в strict mode
**Контекст:** при объявлении локального аккумулятора как `FIMBudgetReport['trimmed']` (где поле — `ReadonlyArray<T>`) tsgo блокирует `.push()`. Аналогично `findSecretCanaries` возвращает `readonly string[]`, и любой вызов `.sort()` на возвращаемом значении не компилируется.

**Применение:** внутренний аккумулятор объявлять как мутабельный `Array<T>` с тем же union типом элементов, а ширение до `ReadonlyArray` оставлять компилятору при возврате. Для сортировки readonly-результата — `[...r].sort()` или принять inherent-ordering хелпера.

### [TS] `assert.fail()` после функции с типом возврата `never` — unreachable code
**Контекст:** конструкция `try { fnReturningNever(); assert.fail('should throw'); } catch (e) { ... }` отвергается tsgo: тип `never` сообщает компилятору, что строка после вызова недостижима.

**Применение:** для тестов sentinel-стабов с `never`-возвратом использовать `assert.throws(() => fn(...))` напрямую, без try/catch с failure-хвостом. Альтернатива — захватить ошибку в `let` вне try и проверить после.

### [URL] `URL` constructor URL-кодирует подставленный `[REDACTED]`
**Контекст:** в `redactOutboundUrl` подстановка `[REDACTED]` через URL constructor превращается в `%5BREDACTED%5D` в выходной строке (URL-spec поведение).

**Применение:** тесты редактора URL должны матчить `%5BREDACTED%5D`, а не `[REDACTED]`. Не пытаться "починить" — это спецификация.

### [VS Code API] `IAction` не имеет поля `dispose`
**Контекст:** при конструировании primary-actions для `INotificationService` включение поля `dispose` ломает компиляцию — TS-ошибка по форме объекта.

**Применение:** при сборке IAction-объектов оставлять только обязательные поля; не копировать форму из других disposable-интерфейсов VS Code.

### [CSS] Composite ID с точкой требует attribute selector, не `#id`
**Контекст:** composite ID `"workbench.view.vibeide"` содержит литеральные точки. CSS-парсер интерпретирует точки как class-chains и не находит элемент по `#workbench.view.vibeide`.

**Применение:** для составных ID с точками использовать `[id="workbench.view.vibeide"]` — attribute-селектор не парсит точку как разделитель.

### [tsgo] Базовый шум 5 ошибок React out-bundle — не регрессия
**Контекст:** `npm run compile-check-ts-native` стабильно держит 5 baseline-ошибок `TS2305 "no exported member"` на путях `react/out/*` (`mountCtrlK`, `mountVibeTooltip`, `mountVibeOnboarding`, `mountVibeSelectionHelper`, `mountVibeSettings`). React-bundle строится отдельным `npm run buildreact`.

**Применение:** не считать эти 5 ошибок регрессией. При оценке "сломал ли я что-то" — сравнивать **count и пути** до/после, а не наличие ошибок вообще. Если baseline вырос — `Grep` по новым файлам, прежде чем подозревать чужие.

### [Doctor] Pure-helper + CJS-mirror pair для CLI-сторон
**Контекст.** `vibe doctor --self-check` / `--knowledge` / `--perf` все wired
по одному паттерну: `common/<feature>.ts` (canonical + unit-тесты), `scripts/lib/
<feature>.cjs` (1:1 mirror с «MUST stay in sync» comment), `scripts/lib/
<feature>.test.cjs` (regression net для mirror drift), и mode flag в
`vibe-doctor.js`.

**Применение.** Любой новый `--<mode>` doctor:
- TS source canonical, не пересобирать логику в CJS — копировать
- Self-tests на mirror'е — это drift-detection (если в TS меняется правило
  и забыли обновить mirror, его тесты падают)
- `--json` всегда поддерживать (CI parsability)
- Mode уход в `process.exit(0|1)` — early-return до `OUTPUT` секции doctor'а

Примеры: `npm-cli-alignment-check`, `knowledge-md-staleness`,
`perf-guardrails-aggregator`, `project-commands-audit`.

### [Files] Пробел в `file_path` сохраняется в имени файла
**Контекст:** `Write` с `file_path` вида `husky LintStagedSkeleton.ts` (случайный пробел между camelCase словами) создаёт файл с пробелом в имени. Имя обнаруживается только при `ls common/`.

**Применение:** при выводе TypeScript-имени файла из doc-string или заголовка раздела следить, чтобы camelCase не разорвался пробелом. Sanity-проверка `ls` после генерации файла с производным именем.

---

## Идиомы и инварианты

### [FSM] Событие `pause` проверяется ПЕРЕД switch по состоянию
**Контекст:** в bg-agent IPC и roadmap-agent loop FSM правило одинаковое: `pause` работает из любого нетерминального состояния и захватывает `resumeWith`-данные для возврата в точное место. Если бы `pause` обрабатывался внутри switch, пришлось бы дублировать "что делает pause из running / paused / starting" в каждой ветке.

**Применение:** в `transitionX(state, event)` функциях — общие cross-state события (`pause`, `abort`, `cancel`) обрабатываются до state-switch. Делает FSM компактнее и устраняет drift между ветками.

### [FSM] Refused transitions НЕ продвигают from-state
**Контекст:** в plan lifecycle FSM `runPlanScenario` driver сохраняет from-state при отклонённом переходе (`{ ok: false, reason, attemptedFrom, attemptedEvent }`). Если бы guard ошибочно принял невалидное событие, тест поймал бы это только при таком инварианте.

**Применение:** scenario-драйверы FSM никогда не продвигают from-state на refused transition — это runtime-matching design. CANONICAL_SCENARIOS таблица в том же модуле даёт integration-тестам общий vector set без drift.

### [OAuth] State-CSRF проверка происходит ПЕРВОЙ, до error-параметра
**Контекст:** `verifyOAuthCallback` проверяет `state` ДО любого другого параметра. Иначе CSRF-нагруженный ответ от вредоносного callback мог бы достичь token-exchange пути даже при наличии `error=...`. Тест фиксирует "state-mismatch wins over error param".

**Применение:** для любого verify-callback хелпера — state/CSRF-проверка идёт первой ветвью. Сначала отказ по нарушению инварианта канала, потом разбор бизнес-ошибок.

### [Hash] Любой агрегатный hash над Map — сначала сортировка ключей
**Контекст:** в `nlsLiveReloadHash` aggregate-hash должен быть order-stable, чтобы `identical → no-op` короткое замыкание работало через разный insertion-order Map'ов. Тест: `new Map([['a','А'],['b','Б']])` и `new Map([['b','Б'],['a','А']])` обязаны давать идентичный hash.

**Применение:** при хешировании коллекции пар — сначала собрать массив ключей, отсортировать, потом feed в hash. Никогда не полагаться на insertion-order контейнера.

### [Determinism] Хелперы возвращающие список ID/keys/reasons обязаны самосортироваться
**Контекст:** `findDuplicateStatusRowIds` изначально возвращал дубли в input-order — сломал тест `.sort()`-инвариантности. То же самое для `decideContextFilterToast` reason-list. CI-снэпшоты становятся flaky как только regex-имплементация переупорядочит matches.

**Применение:** любой хелпер возвращающий список идентификаторов / keys / reasons / findings — сортирует выход внутри. Не позволять caller's input-order протекать в детерминированный результат. Тест должен явно фиксировать ordering хотя бы один раз.

### [Linter] Findings сортировать по `(line, column)`, не по source-order
**Контекст:** RTL CSS auditor явно фиксирует монотонность `(line, col)` тестом. Если бы порядок зависел от source/regex-impl — CI-снэпшоты ломались бы рандомно.

**Применение:** все linter-хелперы возвращают findings отсортированные `(line ASC, column ASC)`. Это исключает flakiness снэпшот-тестов независимо от regex-engine изменений.

### [Validation] Clamp входов на границе хелпера, не у call-site
**Контекст:** `decideContextFilterToast` клампит `ctxPct` и `threshold` к `[0,1]` внутри. Иначе `NaN`, отрицательные, `Infinity` или `>1` значения дают "branching на false === false" — невозможно отлаживать.

**Применение:** numerical inputs хелпера клампятся к допустимому диапазону на границе функции. Caller передаёт сырой настройку — хелпер возвращает осмысленное решение для всех конечных значений.

### [Decoder] Decoder rejection — all-or-nothing, не "filter-bad"
**Контекст:** `decodeAgentLocks` возвращает `null` на ЛЮБОЙ malformed entry, а не "отфильтровать плохие". Это форсит caller'а показать banner о corruption, а не молча маскировать.

**Применение:** decoder коллекций при малейшем нарушении формата — `null` (или `{ ok: false, reason }`). Никаких тихих фильтраций — порча данных всегда заметна на UI-слое.

### [Aggregator] Stable tie-break: primary metric DESC, secondary key ASC
**Контекст:** `modelUsageAggregator` сортирует `totalTokens desc, name asc` для byte-identical output. Это требование для snapshot-тестов и compliance-аудитов.

**Применение:** агрегатор-хелперы — primary метрика по убыванию, вторичный ключ по возрастанию. Тесты ассертят ordering хотя бы раз. Любой неабсолютно-уникальный primary требует tie-break.

### [Resolver] Unresolved `${...}` — оставить плейсхолдер в обеих строках (resolved + redacted)
**Контекст:** `projectCommandSecretsResolver` при `unresolved` оставляет литеральный `${...}` placeholder в resolved и redacted строках. Caller всё равно отказывается spawn'ить, поэтому resolved никогда не выполняется; banner-копирование показывает placeholder как diagnostic. Изначальная попытка заменить на пустую строку теряла диагностику.

**Применение:** для resolver-хелперов с unresolved/missing значениями — сохранить original placeholder, не подменять пустотой. Diagnostic value важнее видимости отсутствия значения.

### [Priority] First-match wins для revocation/disposal-политик
**Контекст:** `commandTrustRevoke` декларирует приоритет `explicit > orphaned > shape-changed`. Тесты ассертят, что `explicit` поверх `orphaned` всё равно отчитывается как `'explicit'`.

**Применение:** revocation/disposal/refusal политики — top-down list в JSDoc, "first-match wins". Не "all rules apply" — это смешивает причины и теряет priority.

### [Versioning] SemVer 2.0 без внешних зависимостей — ~30 LoC
**Контекст:** `cliVersionMismatch` парсит SemVer 2.0 включая prerelease-is-lower правило в ~30 строк. Зависимость на `semver` npm package оправдана только при range-matching.

**Применение:** для major/minor/patch comparison + одного prerelease tiebreak — inline-парсер. Ни VS Code, ни Anthropic SDK не тащат `semver` ради простого сравнения.

---

## Архитектурные паттерны

### Pure helper + thin DI wrapper (now-injected, vscode-free)
**Контекст:** L.0/K.1/K.4 хелперы кодифицировали единую форму: классы остаются в DI, но делегируют module-level pure-функциям. Все clock-чтения происходят в wrapper'е (`now: number` — последний аргумент), state — plain objects, decisions — `{ ok | reason }` или `{ kind, ...payload }`. Никакого `Date.now()` внутри `common/`.

**Применение:** новый хелпер начинать с pure-функции в `common/`, юнит-тесты без `TestServiceAccessor`. DI-обёртка инъектирует время и I/O, состояние держится отдельно. Помимо тестируемости даёт детерминизм для snapshot-тестов.

### Discriminated-union FSM с side-effect descriptors
**Контекст:** `streamingGapWatchdog`, `providerFailover`, `extensionHostCrashRecovery`, `windowLockPolicy`, `planLifecycleStateMachine`, bg-agent IPC, roadmap-agent loop — все используют одну форму. Side effects — это **дескрипторы** (`{ kind: 'retry', delayMs: 5000 }`), которые wrapper интерпретирует, а не функции, вызываемые внутри FSM.

**Применение:** для retry / lifecycle / OAuth-token refresh / reconnect — копировать эту форму. FSM остаётся чисто функциональным; runtime-сторона решает, какие эффекты выполнить и когда. Тестировать FSM напрямую, без моков сетки/таймеров.

### Tagged-result / decision union envelope
**Контекст:** `{ ok: true; value } | { ok: false; reason }` — кодифицировано в 23+ модулях. Аналог: `FailoverDecision`, `EvictionDecision`, `RotationDecision`, `FIMGuardDecision`, `DeletionAction` — всегда с `reason` полем для audit-метаданных и pinpoint test-failure.

**Применение:** ВСЕ validators/decoders/decisions — этот envelope. Не выдумывать вариантов. Toasts и audit-log entries напрямую читают `reason`-поле.

### Twin-shape redactor для privacy-by-default surface
**Контекст:** `commandsAuditPrivacy` экспортирует `redactCommandForAudit` (env keys only) и `redactCommandForCloudIndex` (id+name+description, никогда command/env) — две формы одного исходного source, обе pure, в одном модуле.

**Применение:** когда два consumer'а хотят разные cuts одного source — одна shape per consumer в одном модуле. Никаких re-redact в каждом call-site. Naming: `redact*ForX` где X — consumer.

### Pluggable lookups для развязки helper ↔ I/O
**Контекст:** `projectCommandSecretsResolver` принимает `SecretLookups: { env, secret }`. Тесты инъектируют in-memory dict; runtime — `process.env` + `IEncryptionService.getSecret`. Helper остаётся pure.

**Применение:** где нужно дёрнуть env / secret store / file system — параметризовать lookups. Helper не импортирует I/O напрямую. Runtime-сторона собирает lookups и вызывает helper.

### Collect-all-failures (не bail на первой)
**Контекст:** `releaseSmokeChecker.evaluateSmokeRun`, `projectCommandsSanitizer`, `vscodeTasksJsonImporter`, `validateDesktopNotification` — все собирают **все** проблемы за один вызов, не падают на первой. Человек, читающий отчёт, чинит всё за один проход.

**Применение:** для validator/sanitizer/importer/checker — никогда не возвращать после первого finding. Аккумулировать в массив, возвращать целиком. Codebase-wide норма, не вариант.

### Fail-loud heredoc skeleton scripts
**Контекст:** `release-macos.sh` / `release-linux.sh` skeletons — `set -euo pipefail` + `exit 1` + heredoc с unblock-list и 6-step контрактом. Будущий контрибьютор видит контракт на диске, а не в roadmap.

**Применение:** скрипты-заглушки распределения / сборки — fail-loud, не silent. Внутри heredoc — что нужно реализовать, в каком порядке, какие env vars подставить. Имя ошибки sentinel'а ссылается на roadmap section name (`§"<section title>"`).

### Detect THEN render — это два хелпера
**Контекст:** roadmap-пункт "при подряд 3 jumps → auto-suggest следующего jump через ghost text + Tab" покрывается двумя хелперами: `cursorJumpThemeDetector` (триггер) + `nextEditGhostText` (рендер). Закрывать только детектором — половина работы.

**Применение:** когда roadmap описывает "detect THEN render" / "decide THEN format" — это два хелпера. Closure только при наличии обоих. Один без другого — `[~]` skeleton.

### Singleton-with-pure-helper-wrapper
**Контекст:** `vibeOutboundRingBuffer` — `registerSingleton` обёртка над pure-хелпером из `common/`. Pure-helper unit-тестируется изолированно; singleton владеет in-memory state и DI hooks.

**Применение:** когда нужен per-process state (ring buffer, cache, registry) — pure helper в `common/` + thin singleton-wrapper. Eager-import singleton-модуля из `vibeide.contribution.ts`, если consumer резолвит сервис в constructor (lazy `import()` гонится с DI-инициализацией).

### `Pick<>` argument shapes в service-contract validators
**Контекст:** хелперы, потребляющие 2-3 поля большого типа (`Pick<ProjectCommand, 'id' | 'confirm'>`), не таскают весь `ProjectCommandsFile`. Тестовые fixtures остаются крошечными (`{id:'a',confirm:true}`).

**Применение:** когда helper читает 2-3 поля типа — параметр `Pick<T, K>`, не `T`. Снижает test-matrix и delegation cost. Codebase-wide convention.

### `buildDefault*` companion к decision-функции
**Контекст:** `outboundAllowlist.buildDefaultAllowlist` (Ollama+lmstudio+GitHub+MCP), `mcpTokenRotationPolicy` defaults — известная инфраструктура (порты, endpoints, URLs) кодируется в companion-функции. Caller компонует user-settings + buildDefault\*() и feeds union в decision-функцию.

**Применение:** decision-helper никогда не зашивает known-defaults внутрь. Их место — отдельный экспорт `buildDefault*()`, который caller сливает с user input. Tests могут verify defaults независимо.

### Single-string helper + fan-out wrapper для много-полевых форм
**Контекст:** `resolveProjectCommandSecrets` итерирует command/args/cwd/env через единый `resolveStringPlaceholders`. Тесты grammar edge-cases — на inner; тесты aggregation — на outer. Без разделения матрица тестов взрывается.

**Применение:** когда форма имеет 3+ полей одного типа (строки) — inner helper для одной строки + outer для итерации. Исключает дублирование grammar-логики и снижает test count.

### Section-drop truncation вместо hard-cut
**Контекст:** `inlineAiExplanationFormatter` — order section drop (`rationale-quote → session-summary → plan-step → hard-cut`) с `skippedSections[]` reporting. UI рендерит "show more" affordance вместо ellipsis в середине предложения.

**Применение:** при бюджет-truncation длинных markdown-ответов — стратегия "drop low-priority sections", не cut по символам. Caller получает список выкинутых секций, может показать UX для расширения.

### "Both gate" guards beat "either gate" в classifiers
**Контекст:** `heapGrowthClassifier` использует `pct AND bytes` leak-gate. `OR` версия misfires: 10MB doubling в 5MB heap — тригерит на 100% pct; 60MB leak в 5GB heap — тригерит на 60MB. AND-условие отсекает оба extremes.

**Применение:** для classifier'ов с метриками разной природы (proportional + absolute) — AND-условие. OR ловит false-positive на extreme inputs. Тесты на оба extremes обязательны.

### Adoption commit pattern: parity table в commit-message
**Контекст:** при замене inline ad-hoc heuristic на pure-helper (`nlShellSafetyAnalyzer`, `deriveConfidenceColor`) commit message содержит parity-таблицу: какие inputs → какие outputs до/после. Reviewer видит "no behavior change" без чтения кода.

**Применение:** adoption-commit формат: `(refactor): K.4/<line> adopt <helper> in <service>.<method>` + parity table в body. ALL output cases enumerated; impossible combinations помечены "n/a". Mock'и (`MockGitAutoStashService` etc.) обновляются ДО compile-check.

### Disposable-tracking Map для dynamic registry rebinds
**Контекст.** `CommandsRegistry.registerCommand` / `KeybindingsRegistry.registerKeybindingRule`
оба возвращают `IDisposable`. Когда snapshot динамический (FS-watch на
.vibe/commands.json), контрибуция держит `Map<id, IDisposable>` + dispose-all
+ re-register на каждом event.

**Применение.** Нельзя сделать "unregister by id" — нет API. Только через
disposable, который вернул register call. Pattern landed в
`vibeCustomCommandsContribution._rebindDynamicCommands` (commands +
keybinding chord pair). Disposable tracking — двойной: один `Map<id,
IDisposable>` для текущего snapshot + общий `DisposableStore` для cleanup
на dispose контрибуции.

### `touchesSensitiveFields` flag — обязательный invariant import-orchestrator'ов
**Контекст:** `commandsImportDiff` имеет `touchesSensitiveFields: boolean` (true iff command/args/env/cwd changed). Personas marketplace расширил это на `systemPromptHash`. Caller'у нужен один boolean "scare the user", а не полный набор полей.

**Применение:** любой marketplace/community import-orchestrator выставляет `touchesSensitiveFields`. Per-field детали — в `changedFields[]` для рендера. Это invariant, не опция.

---

## Безопасность

### Webhook handlers ВСЕГДА имеют HMAC verifier рядом с decoder'ом
**Контекст:** `crowdinWebhook` пара: `decodeCrowdinWebhookPayload` + `verifyCrowdinSignature` (constant-time-ish: length-equal then XOR-accumulate). Без HMAC verifier — payload-decoder бесполезен против подделки. Codify: каждая webhook-интеграция требует обоих.

**Применение:** для любого нового webhook-источника — `decode<Service>WebhookPayload` И `verify<Service>Signature` в одном модуле. Constant-time compare обязателен (length-equal затем XOR-accumulate байтов).

### CANARY-substring канарейки бьют opaque tokens
**Контекст:** `securityTestFixtures` — канарейки имеют литеральный substring `CANARY` (`ghp_CANARYabcdef...`). При утечке в log-file `grep CANARY` тривиален. Узнавание opaque-токена в дампе — нет.

**Применение:** все security-канарейки в test fixtures несут подстроку `CANARY` (или другой uniquely-identifiable маркер). Никаких "случайных opaque" — это убивает forensic-grep.

### Privacy-by-default decoder: только литеральный `true` включает enabled
**Контекст:** `decodeAuditFlags` валидаторы на settings-границе — `enabled` flips on только для `=== true` (не `1`, не `"true"`, не truthy). Runtime никогда не доверяет config-объекту напрямую.

**Применение:** privacy-флаги — strict equality на `true`. Любой другой input → false (privacy default). Это `decode*Flags` слой между config-чтением и consumer'ом.

### Audit-payload helpers выкидывают original `reason` (path-style secret risk)
**Контекст:** `agentLockDisposal` audit-payload helper НЕ включает оригинальный `reason` field входящего lock'а — он может содержать secret-shaped paths (`.vibe/secrets/...`). JSDoc каждого нового lock-release/disposal helper'а явно фиксирует это.

**Применение:** audit-emit функции не пробрасывают user-supplied `reason`-поля наружу. Если поле может содержать пути / токены / пользовательский ввод — sanitize или заменить на whitelist of known reason-codes.

### PII regex set отвергает ДО render, не после
**Контекст:** `discordBugIngest` PII-regex (SSN-shape / 16-digit PAN / email / IPv4) тригерит на этапе классификации `malformed(reason='pii-suspected')`. Bot никогда не успевает экспортировать PII в committed roadmap.

**Применение:** для пайплайнов user-input → public-output PII-фильтр стоит первым (до render, до dedup, до commit). Reject-early — единственный способ гарантировать non-leakage.

### `AllowUnsigned` escape hatch как first-class signing flag
**Контекст:** `sign-windows.ps1 -AllowUnsigned` и `notarize-macos.sh --allow-unsigned` exit 0 с warning, не fail. Release-script вызывает с флагом; флипа OFF — единственное что превращает "warn" gate в "block" gate. Operator-controlled gate shape.

**Применение:** для signing/cert/credential gates — explicit `--allow-X` flag, не silent fail-open. Default state — warn (build proceeds), но один env-var flip → refuse. Operator контролирует transition не из кода, а из конфига.

### Outbound URL sanitiser редактирует userinfo + sensitive query-keys (case-insensitive)
**Контекст:** `outboundConnectionsAggregator` группирует по `(host, source)` и редактирует userinfo/query-keys. Sensitive-key match — case-insensitive (потому что `Token`, `TOKEN`, `token` появляются вперемешку).

**Применение:** URL-redactor работает над всеми трёмя слоями: userinfo (`user:pass@`), query-string keys (`?token=...`), и path-segments (`/api/keys/<token>/`). Case-insensitive matching по списку sensitive-keys.

### Playwright script schema — allowlist actions, не denylist
**Контекст:** `playwrightScriptSchema` определяет 9-action allowlist, явно отказывая `evaluate` / `addScriptTag` / `addInitScript` / `exposeFunction` (всё что позволяет произвольный JS в browser context). URL allowlist — `*.host` wildcards + localhost-http flag.

**Применение:** для script-runner'ов user-supplied контента — allowlist actions, не denylist. Default-deny безопаснее, чем default-allow с blocklist'ом (новые dangerous APIs появляются быстрее, чем blocklist обновляется).

### JSON extraction из произвольной прозы — balanced-brace counting, не regex
**Контекст:** `parseNextEditCompletion` начально использовал regex `\{([^}]*)\}` — ломался на nested objects (`"insertion": "{nested:1}"`). Заменено на counting `depth` и поиск matching close.

**Применение:** для извлечения JSON из LLM-ответа или markdown — track brace depth, не regex. Non-recursive regex на сбалансированных скобках принципиально не работает.

---

## CI и процессные правила

### Sticky-comment CI workflows — find-by-prefix, edit-in-place
**Контекст:** `test-coverage.yml` использует sticky-comment паттерн: ищет существующий PR-комментарий по уникальному prefix, обновляет in-place; иначе создаёт. Prefix — уникальный per-workflow, чтобы updates не клэшились.

**Применение:** новые CI workflows публикующие PR-feedback — sticky-comment с `<!-- workflow-X-sticky -->` префиксом. Не плодить N комментариев в треде на каждый rerun.

### Warn-only CI gates — legacy artefacts не блокируют PR
**Контекст:** `test-coverage.yml`, `privacy-verify.yml`, `release-readiness.yml` — emit `::warning`, не fail-job. CI shows orange dot, PR mergeable. Снижает friction, пока coverage/privacy инвентарь не достроен.

**Применение:** для новых compliance/coverage gates — warn-only фаза до полного покрытия, потом флип на error. Грейс-период избегает лавины ложных block'ов.

### Skeleton sentinels ссылаются на roadmap section name
**Контекст:** `LanguagePackNotImplementedError` сообщение содержит `roadmap §"<section title>"`. Test runner или maintainer моментально знают, какую roadmap-строку поднимать. Sentinel — единственное место, где runtime встречает "not yet wired".

**Применение:** все sentinel-error классы ссылаются на roadmap-секцию в message. Format: `"<feature> not implemented (roadmap §\"<section title>\")"`. Catch-block consumer не должен re-grep'ить файл.

### Unblock list inline в commit-message адопшна
**Контекст:** adoption-commits включают "Adoption (out of scope here): …" хвост — список call-sites которые ждут wiring. Следующий contributor видит TODO inline.

**Применение:** при landing pure-helper с известными pending-адопшнами — список call-sites в commit body. Не оставлять discovery следующему как exercise.

### CI workflows mirror pure-validator regex set in inline JS
**Контекст:** `i18n-lint.yml` и `openvsx-publish.yml` дублируют regex/validation логику инлайн в JS чтобы избежать TS-compile dependency в workflow. Tests на `.ts` модуль каноничны; workflow-JS — thin no-compile clone.

**Применение:** CI workflow требует validation? Inline JS-зеркало pure-helper'а из TS, не `tsc` в workflow. Каноничны TS-тесты; JS-копия удерживается синхронной через PR-review.

### Roadmap markers могут отставать на 5+ commit'ов
**Контекст:** регулярно встречалось — pure-helper уже шипнут в `feat()` коммите, но `[ ]` в roadmap не обновлён. Категоризация должна делать `git log --format=%s | grep -i <topic>` ДО написания нового кода.

**Применение:** перед написанием нового хелпера — `grep -rn "decide<X>\|safeParse" common/` И `git log --format=%s | grep -i <topic>`. Markers лагают; код — единственный source of truth. Когда landing helper — обновлять roadmap entry в том же коммите.

### IDE diagnostics surface через `<system-reminder>` PostToolUse hooks
**Контекст:** при правке VS Code IDE передаёт диагностики (например, `redundant activationEvents`) как `<system-reminder>` через PostToolUse hook. Treat как user-flagged warning даёт чище PR, чем игнор.

**Применение:** `<system-reminder>` с диагностиками от IDE — обрабатывать как warning от пользователя, а не как noise. Часто это catch для опечаток или устаревших API.

---

## Источники

Извлечено из 30 файлов `~/.claude/projects/d--Projects-VibeCode-VibeIDE/memory/project_roadmap_max_2026_05_0{8,9}_*.md` (логи прогонов skill `roadmap-max` 2026-05-08 — 2026-05-09). После извлечения исходные логи удалены — этот документ — единственный остаток.
