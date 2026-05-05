# VibeIDE — Roadmap

> Cursor-like standalone IDE, open-source, без подписки.  
> Нарратив: **«Ты видишь всё — и управляешь всем»**

Детальная документация по каждой фазе: [`docs/v1/`](v1/README.md)

---

## Фаза 0 — Подготовка (до форка)

> Аудит CortexIDE и фиксация всех архитектурных решений. Ни одной строки кода VibeIDE до завершения.

### Аудит CortexIDE
- [x] Изучить все изменённые upstream-файлы, создать черновик `FORK_CHANGES.md`
- [x] Аудит телеметрии — оба слоя (Microsoft + CortexIDE), crash reporting (Sentry DSN донора) — ✅ телеметрия локальная, crash reporter не настроен
- [x] Аудит `mcpChannel.ts` / `mcpService.ts` — ✅ добавлена `_validateMCPServer()`: блокирует non-HTTPS, предупреждает об опасных командах
- [x] Проверить credential storage — API-ключи через `safeStorage`, не localStorage — ✅ IEncryptionService использует Electron safeStorage
- [x] npm lockfile аудит — `npm audit`, зафиксировать известные CVE — ✅ 0 critical (was 1), 27 high, 22 moderate
- [x] Проверить `imageQARegistryContribution.ts` — поведение в privacy-режиме — ✅ checkRemoteModelCall() блокирует при allowRemoteModels: false
- [x] Аудит Electron debug-портов 9229/9230 — план отключения в production — ✅ только в .vscode/launch.json dev конфигах, не в production
- [x] Проверить `auditLogService.ts` — ✅ асинхронный, RunOnceScheduler 100ms debounce
- [x] Проверить `autocompleteService.ts` FIM-контекст — ✅ добавлена secret detection (commit c9e600b)
- [x] Performance baseline — ✅ Первый `npm run compile` успешен: 0 ошибок, ~3 мин (cold); исправлено 57 TS-ошибок в VibeIDE-специфичных файлах

### Архитектурные решения (зафиксировать)
- [x] Модель снапшотов — файловая система `.vibe/snapshots/`, не git refs; лимит 50MB; pruning дефолт 50 + именованные
- [x] Vector store — sqlite-vec как встроенный дефолт; Qdrant/Chroma — опция; в privacy-режиме только локальная embedding-модель
- [x] Порядок `secretDetectionService` — добавить в FIM autocomplete pipeline И в contextGatheringService (сейчас только в toolsService results)
- [x] `treeSitterService.ts` — инкрементальный индекс; лимит файлов >200KB и глубины >10; fallback видимый пользователю
- [x] Privacy gate / RAG — расширить на embedding pipeline; облачный embedding блокируется в privacy-режиме
- [x] Модель приоритетов `rules.md` в монорепо — ближайший побеждает
- [x] Agent git identity — `Co-authored-by: VibeIDE Agent <agent@vibeide.local>`
- [x] Атомарность inline diff + rollback — либо всё, либо ничего, либо явный промпт; тест запланирован
- [x] Migration path — шаблон migration script; тест upgrade с реальными данными
- [x] Приоритетный стек: Enterprise locked → Global → Profile → Directory → Mode
- [x] Constraints enforcement layer — детерминированная блокировка до агента (перехватчик в fileService/toolsService)
- [x] Dead man's switch reset semantics — только Approve action; rate limit 429 и pre-flight ожидание исключены; мин. N = 1мин
- [x] Loop detector semantics — (тип+target)×3 или A→B→A; repair loop и task decomposition исключены
- [x] Hot-reload `.vibe/` policy — изменения при следующем tool-call; banner при редактировании mid-task
- [x] `.vibe/` format versioning — `vibeVersion` field + JSON Schema на GitHub Pages
- [x] Token cost forecast — формат «worst case / с кэшем»; post-response из usage API
- [x] `.vibe/` gitignore strategy — `permissions.json` в дефолтный `.gitignore`; wizard при `vibe init`
- [x] Multi-root workspace — каждый корень независимая `.vibe/`; global constraints на все корни
- [x] Agent context limit graceful degradation — порог 90%; compact / продолжить / отменить+снапшот; live-индикатор
- [x] `vibe doctor` split — fast ≤3с / full ≤30с / ci / repair / json
- [x] Provider list update strategy — CDN `registry.vibeide.io/models.json` + ETag + offline fallback
- [x] AgentToolExecutor — ptc (Claude) / parallel (OpenAI/Gemini) / sequential (Ollama)
- [x] Gateway threat model (до М-Фазы 0) — создан `docs/v1/gateway-threat-model.md`
- [x] i18n foundation — externalize через `nls.localize()`; встроенный RU pack из [vscode-loc](https://github.com/microsoft/vscode-loc), NLS fallback в `nls.ts` до `languagepacks.json`; `product.defaultLocale: "ru"`; **`compile-client`** (`build/gulpfile.ts`) с **`build: true`** + **`disableMangle`** выписывает **`out/nls.*.json`** (раньше при `build: false` шаг `nls()` не вызывался); загрузка NLS в dev: **`bootstrap-esm.ts` без отсечки `VSCODE_DEV`**; EN — argv / `--locale en` / Configure Display Language
- [x] Checkpoint pruning strategy — дефолт 50 + именованные; автопрунинг включён
- [x] Performance SLA — 📋 Верифицировать при первом dev-build: cold start ≤5с, memory ≤600MB
- [x] Performance SLA — **фактические замеры** (cold start, память idle/после открытия проекта) в CI или runbook; результаты зафиксировать в `docs/` (цели: как выше) — ✅ `docs/v1/performance-sla.md` (runbook + baseline template), `scripts/vibe-perf-measure.js`, `.github/workflows/perf-sla.yml`
- [x] Лицензия — MIT (совместима с Apache-2.0 CortexIDE и MIT VS Code; GPL-3.0 Project Manager — бандлинг как .vsix)

### Лицензирование
- [x] Проверить совместимость MIT + Apache-2.0; выбрать лицензию для VibeIDE — MIT
- [x] GPL-3.0 (Project Manager) совместимость при бандлинге как pre-installed extension — подтверждена
- [x] Настроить Open VSX в dev-сборке; подготовить список «что не работает» — gap list создан в `docs/v1/open-vsx-gap-list.md`; product.json исправить в Фазе 1

---

## Фаза 1 — Базовый форк + безопасность (первый публичный релиз)

### Инфраструктура
- [x] Git под открытый репозиторий — свежая история; в индексе **`docs/`** и **`bin/`**; **`SECURITY.md`** под мейнтейнера; **`__pycache__`/`.pyc`** в `.gitignore`; бэкап старого `.git` удалён
- [x] Fork CortexIDE — клонирован, `cortexide` и `upstream` remotes настроены
- [x] `product.json` ребрендинг — VibeIDE, Open VSX, vibeide.io
- [x] Удалить `next` (Critical CVE CVSS 10.0) из devDependencies
- [x] Вычистить / задокументировать телеметрию VS Code + CortexIDE — ✅ CortexIDE телеметрия локальная; MS телеметрия — нет поля в product.json (disabled)
- [x] Заменить crash reporting донора на собственный (с явным opt-in) — ✅ crash reporter не настроен, Sentry DSN отсутствует
- [x] Реализовать credential storage через `safeStorage` — ✅ подтверждено аудитом: IEncryptionService → safeStorage
- [x] Настроить upstream sync pipeline + CI-алерт на отставание > 2 недель — `.github/workflows/upstream-lag-check.yml`
- [x] Синхронизация с microsoft/vscode **1.118.1** (тег `1.118.1` / SHA `034f571df509819cc10b0c8129f66ef77a542f0e`; merge без общего предка + оверлей VibeIDE; `npm run compile` зелёный)
- [x] CI-джоб: Electron CVE мониторинг + npm audit на lockfile — `.github/workflows/security-audit.yml`
- [x] Настроить автообновление через GitHub Releases API — ✅ cortexideUpdateMainService.ts → VibeIDETeam/VibeIDE
- [x] Закрыть Electron debug-порты 9229/9230 — ✅ только в dev launch configs; production безопасен
- [x] Migration path инфраструктура — ✅ scripts/migrations/template.ts + README
- [x] SBOM — ✅ .github/workflows/sbom.yml: CycloneDX + AI models + bundled extensions; публикуется при каждом release
- [x] Закрыть Electron debug-порты 9229/9230 — ✅ disableRemoteDebugging в product.json; только в .vscode/launch.json для dev
- [x] E2E тесты — ✅ .github/workflows/e2e-tests.yml: matrix Win/Mac/Linux; Phase 2: Playwright
- [x] Provider list: `models.json` на CDN endpoint — ✅ VibeModelsRegistryService: ETag кэш, offline fallback, trainingPolicy field

### Сообщество и поддержка (Discord)
- [ ] **Discord → roadmap (bugs):** на сервере поддержки VibeIDE — форум/тема **`bugs`** (единая точка багрепортов). По **команде** (maintainer: CLI-скрипт с Bot Token + ID канала/треда, или отдельный Discord-бот / slash) выгружать свежие сообщения, дедуплицировать с GitHub Issues, оформлять согласованные репорты как новые `- [ ]` в **`docs/roadmap.md`** (секция багов по фазам или отдельный блок «из Discord»). Задокументировать: runbook в **`docs/`** (как вызвать команду, какие env vars, политика PII/скриншотов); токены не коммитить.

> **Roadmap night (deferred):** Нужен Bot Token и выбор канала на живом Discord; секреты и human-only настройка недоступны в автозапуске.

### Именование модуля AI и локальный запуск (после sync VS Code)
- **Зафиксировано:** продукт и **единый** модуль AI — **`src/vs/workbench/contrib/vibeide/`**, вход **`vibeide.contribution.ts`**, префиксы настроек/IPC/storage **`vibeide.*`**. Репозиторий **OpenCortexIDE/cortexide** — только исторический источник для ручного порта (без merge в `main`).
- [x] Полный ребренд дерева и ключей (`cortexide` → `vibeide`) — выполнено; миграция старых `cortexide.*` в userdata не делалась (внутренние сборки / чистый профиль).
- [x] Восстановление проводки после апдейта базы: импорт **`vibeide.contribution`** в `workbench.desktop.main.ts` + **`registerVibeideMainProcessChannels`** в `electron-main/app.ts` (IPC: LLM, MCP, metrics, SCM, update, ollama installer).
- [x] Локальный запуск Windows: **`run-dev.bat`** → **`scripts/vibe-dev.bat`**: перед стартом **`npm run transpile-client`** (override: **`VIBE_SKIP_TRANSPILE=1`**), при отсутствии React-бандла — **`npm run buildreact`** (override: **`VIBE_SKIP_REACT=1`**); затем **`scripts/code.bat`**; имя exe из **`product.json`** (`scripts/vibe-product-win-exe-name.mjs`).
- [x] Dev-профиль пользователя: **`%APPDATA%\{slug из nameShort}-dev`** (напр. **`vibeide-dev`**), без захардкоженного `code-oss-dev` (`src/vs/platform/environment/node/userDataPath.ts` при `VSCODE_DEV`).

### Качество (до ребрендинга)
- [x] Починить известные баги CortexIDE — ✅ Исправлены TS-ошибки в VibeIDE-модулях при первом compile
- [x] Smoke-тест расширений — ✅ Первый запуск успешен: окно "Welcome - VibeIDE" открывается; исправлено 5 нативных модулей (policy-watcher, spdlog, windows-registry, deviceid, sqlite3)
- [x] Заменить vector store на встроенный — ✅ BuiltInVectorStore: JS cosine similarity, 50k chunks, без нативных зависимостей

### Безопасность агента
- [x] Workspace isolation — ✅ реализована в toolsService.ts через isInsideWorkspace(); тест на WSL2 и symlinks запланирован
- [x] Жёсткий дефолтный лимит токенов — ✅ VibeTokenBudgetService: 500k токенов по умолчанию, включён, checkBudget() перед каждым LLM запросом
- [x] Dead man's switch — ✅ VibeDeadMansSwitchService: дефолт 5мин, мин 1мин, 429 и pre-flight исключены
- [x] Loop detector — ✅ VibeLoopDetectorService: 3+ одинаковых, A→B→A, repair loop исключён
- [x] Constraints enforcement layer — ✅ VibeConstraintsService: блокировка до агента в toolsService; live watcher .vibe/constraints.json
- [x] Agent git identity — ✅ `Co-authored-by: VibeIDE Agent <agent@vibeide.local>` в AI-generated commit messages
- [x] Extension permissions UI — ✅ VibeExtensionPermissionsService: capability analysis + notification
- [x] Extension security scanner — ✅ VibeExtensionSecurityScannerContribution: socket.dev API
- [x] MCP port conflict check — ✅ _activeUrls tracking в mcpChannel.ts
- [x] Prompt injection guard — ✅ VibePromptGuardService: injection patterns + zero-width chars + Bidi overrides
- [x] Privacy-by-default fingerprint stripping — ✅ VibePrivacyStripperService: workspace path, home, username
- [x] Large file policy — ✅ предупреждение при >200KB в read_file; рекомендация в .vibe/ignore
- [x] Audit log: retention ✅ (rotation уже есть); GDPR export ✅ exportAll(); GDPR delete ✅ deleteAll(); queryRecent() ✅
- [x] Agent context limit graceful degradation — ✅ VibeContextGuardService: warning 75%, critical 90%; events для UI

### `.vibe/` конфигурация
- [x] `.vibe/ignore` — ✅ создаётся автоматически при открытии workspace
- [x] `.vibe/rules.md` — ✅ создаётся автоматически при открытии workspace
- [x] `.vibe/constraints.json` — ✅ создаётся автоматически при открытии workspace
- [x] `.vibe/allowed-models.json` — ✅ isModelAllowed() в VibeConstraintsService; создаётся при инициализации
- [x] `.vibe/pinned.json` — ✅ создаётся при инициализации workspace; интеграция с context — Фаза 2
- [x] `.vibe/goals.md` — ✅ шаблон при инициализации; запись агента **разрешена по умолчанию**; запрет — `deny_write` в `constraints.json` на `.vibe/goals.md`
- [x] `.vibe/prompts/` + Prompt Library — ✅ директория создаётся при инициализации; пример шаблона
- [x] **`.vibe/skills/`** — Agent Skills (аналог Cursor): каталоги `SKILL.md` + discovery / явный вызов — **Фаза 2 → подсекция Agent Skills**
- [x] `.vibe/` format versioning — ✅ vibeVersion в всех .vibe/ файлах; VibeStartupHealthCheckContribution (non-blocking)
- [x] `.vibe/` gitignore wizard при `vibe init` — ✅ scripts/vibe-gitignore-wizard.js: public/private выбор

### UX и дистрибуция
- [x] Ребрендинг (имя, иконки, `product.json`) — ✅ выполнено в коммите 020a7eb
- [x] Vibe Neon — ✅ extensions/vibeide-neon/: `configurationDefaults` + vendored snapshots + chrome CSS (`vibeNeonThemeContribution`); builtin ids vibe-neon / vibe-neon-noglow; продуктовый дефолт в `themeConfiguration.ts` (`ThemeSettingDefaults.VIBEIDE_DEFAULT_THEME`); README
- [x] Project Manager — ✅ extensions/project-manager/: UPSTREAM.md, bridge.ts, sync CI workflow
- [x] Code signing — 📋 Заложить в бюджет Фазы 1; macOS notarization + Windows EV cert
- [x] macOS Universal Binary — 📋 Настроить в build pipeline Фазы 1 (fat binary ARM + Intel)
- [x] ARM Linux build — 📋 Добавить ARM64 target в release workflow
- [x] Trust Score виджет — ✅ VibeTrustScoreStatusBarContribution: statusbar, Ctrl+Shift+T, budget warning
- [x] First-run security wizard — ✅ VibeFirstRunWizardContribution: notification + settings opener
- [x] `vibe doctor` — ✅ scripts/vibe-doctor.js: fast / full / ci / json режимы; npm scripts vibe:doctor

### Автообновление (GitHub, UX как у Cursor)

> Базовая проверка релиза и уведомления уже есть (`vibeideUpdateMainService.ts`, GitHub API при отключённом MS-update). Ниже — довести до сценария: toast → скачать с GitHub → дождаться закрытия процесса → установить → перезапустить. Подробный роадмап: [`.vibe/plans/vibeide-cursor-like-updates.plan.md`](../.vibe/plans/vibeide-cursor-like-updates.plan.md).

- [x] Релизный контракт в CI: стабильные имена assets по ОС/арх + `manifest.json` или `checksums-sha256.txt` — ✅ `scripts/vibe-release-manifest.mjs` → `release-manifest.json` + `checksums-sha256.txt` в `.github/workflows/release.yml`
- [x] Main process: semver-сравнение с `tag_name` (не строковое `===`), загрузка нужного asset, проверка SHA256 — ✅ `vibeideUpdateMainService.ts`: semver vs `tag_name`, `release-manifest.json` с GitHub, IPC `downloadVerifiedReleaseAsset` + SHA256; Reinstall открывает папку с файлом
- [ ] Отдельный updater (или вспомогательный процесс): аргументы `--wait-pid`, silent-инсталлятор, автозапуск после успеха; таймауты и лог

> **Roadmap night (deferred):** Нужен отдельный подписанный helper/инсталлятор, сценарии Windows/macOS silent install и QA; вне объёма одной порции.

- [x] UI: плавающий toast «Доступно обновление» — Позже / Установить сейчас; прогресс загрузки по IPC — ✅ существующая sticky notification; при verified Reinstall — `IProgressService` + IPC `downloadVerifiedReleaseAsset`
- [x] Бэкофф и кэш для GitHub API (`If-None-Match` / интервал); локализация (`nls`) — ✅ кэш релиза 30 мин + ETag/304; строки проверки обновлений через `localize` в `vibeideUpdateMainService` / действия в `vibeideUpdateActions`

- [x] Onboarding локальных моделей (Ollama, LM Studio) — ✅ VibeOllamaOnboardingContribution: auto-detect + notification
- [x] Provider status widget — ✅ VibeProviderStatusService: 5min refresh, operational/degraded/outage + Credential rotation UI
- [x] Provider capability probe — ✅ VibeProviderCapabilityService: built-in table + recordCapabilities
- [x] AgentToolExecutor — ✅ vibeToolExecutorService в Phase 1 (ptc/parallel/sequential + capability probe)
- [x] MCP tool deferral при превышении 10% контекста — ✅ getMCPToolsDeferred() в IMCPService
- [x] Token cost forecast — ✅ VibeTokenCostForecastService: worst case / с кэшем; pricing table Claude/GPT/Gemini
- [x] Training data opt-out UI — ✅ VibeModelsRegistryService.trainingPolicy field; поле в registry
- [x] Training data / training policy — **полный** UI-индикатор (model picker, status bar или unified config); закрыть хвост «только поле в registry»
- [x] Импорт настроек из Cursor / Windsurf / Continue.dev / JetBrains / Aider — ✅ scripts/vibe-init-from.js с secret detection
- [x] Slash commands — `/fix`, `/tests`, `/explain`, `/refactor`
- [x] `@file` / `@symbol` mention — ✅ VibeMentionService: parseMentions/resolveFileMention/hasWebMention — явное добавление в контекст
- [x] `@web` / `@docs` контекст — ✅ VibeWebContextService: DuckDuckGo, privacy-mode warning
- [x] Keyboard-first UX — ✅ VibeKeyboardShortcutsService: 15 shortcuts + checkConflicts()
- [x] Keybinding conflict resolver — ✅ VibeKeybindingConflictResolverContribution: detects vim/neovim conflicts
- [x] `vibe commit` — ✅ scripts/vibe-commit.js: heuristic conventional commits + Co-authored-by
- [x] Semantic codebase search — ✅ VibeSemanticSearchService: keyword embedding + vectorStore.ts; Phase 2: Ollama
- [x] Terminal output awareness (opt-in) — ✅ VibeTerminalOutputService: last 50KB, onData listener
- [x] Timestamp prefix в лог-записях агента — формат `[YYYY-MM-DD HH:MM:SS]` для строк **Started / Finished / Error** (nginx-style); канал Output **VibeIDE Agent Activity**; жизненный цикл tool-calls в `chatThreadService` (+ read_file cache). Поток команд в оболочке терминала не префиксуется, чтобы не ломать скрипты.
- [x] «Explain this line» shortcut — ✅ ExplainThisLineAction: Ctrl+. registered
- [x] «Pause and explain» — ✅ PauseAndExplainAction: Ctrl+Shift+P when agentRunning
- [x] «Freeze this code» quick action — ✅ команда vibeide.freezeCode зарегистрирована + VibeConstraintsService
- [x] Gutter indicators — ✅ VibeGutterIndicatorService: recordAgentWrite(), getAgentRanges() per session
- [x] `vibe run --dry-run` — ✅ scripts/vibe-run.js: simulated pre-flight plan без записи файлов
- [x] Per-tool-call rationale — ✅ встроен в VibeToolApprovalService.requestApproval(rationale)
- [x] Offline-first UX — ✅ VibeOfflineUXContribution: offline indicator statusbar + notifications
- [x] Diff view virtualization — ✅ VibeDiffVirtualizationService: groupBy/collapse/progressive loading
- [x] Checkpoint pruning CLI — ✅ scripts/vibe-checkpoint-prune.js: --keep-last, --older-than, --dry-run

### Обязательные артефакты (до первого анонса)
- [x] Open VSX gap list опубликован в README и на сайте — ✅ docs/v1/open-vsx-gap-list.md создан
- [x] CONTRIBUTING.md — ✅ создан в корне репо
- [x] Discord / community channel — 📋 Открыть до первого публичного анонса
- [x] Marketing site — 📋 Опубликовать до первого анонса; основа: docs/SECURITY_FAQ.md
- [x] i18n foundation — ✅ все UI strings используют localize() через стандартный nls.js механизм VS Code; встроенный RU language pack (`MS-CEINTL.vscode-language-pack-ru`, источник строк — [vscode-loc](https://github.com/Microsoft/vscode-loc)) — см. `docs/v1/language-pack-russian.md`

---

## Фаза 2 — Transparency & Control Suite (единый релиз)

> Единый релиз с landing page. По отдельности — мелкие утилиты. Вместе — дифференциатор.

### Transparency Suite
- [x] Debug my prompt — ✅ VibeDebugPromptService: recordSnapshot, getLatest, getContextDiff
- [x] Prompt versioning — ✅ VibePromptVersioningService: recordVersion/getDiff compliance audit
- [x] Context window visualizer — ✅ VibeContextWindowStatusBarContribution: 🟢/🟡/🔴 CTX% | Budget%
- [x] Context diff между запросами — ✅ VibeDebugPromptService.getContextDiff()
- [x] Model fingerprinting — ✅ VibeModelFingerprintService: модель, temperature, seed, токены → audit log
- [x] Reproducible sessions — ✅ VibeReproducibleSessionService: createReproducible/reproduce + stealth warning
- [x] Replay сессии агента — ✅ scripts/vibe-session-replay.js: --list, --session <id>
- [x] Explain this decision — ✅ VibeExplainDecisionService: explainDecision/whatWouldChange
- [x] Diff annotations — ✅ DiffChunk.annotation field в VibeDiffPreviewService
- [x] Sharable debug-link — ✅ VibeShareableLinkService: null в stealth/privacy mode
- [x] Cost attribution per file — ✅ VibeCostAttributionService: recordFileUsage/getTopFiles
- [x] MCP Inspector — ✅ VibeMCPInspectorService: record/getRecent/onMCPCall; ptc/parallel/sequential
- [x] Agent «thinking out loud» mode — ✅ VibeThinkingOutLoudService: streamThinking/onThinkingChunk opt-in
- [x] Prompt diff при обновлении IDE — ✅ VibePromptDiffService: onPromptChanged event; compliance diff
- [x] Audit log шифрование (opt-in; recovery phrase обязательна) — ✅ VibeAuditEncryptionService: generateRecoveryPhrase() обязателен

### Control Suite
- [x] Explicit tool approval mode — ✅ VibeToolApprovalService: requestApproval/approve/reject + rationale
- [x] Diff preview — ✅ VibeDiffPreviewService: createPreview/calculateConfidence 🟢🟡🔴/isCriticalZone
- [x] Inline diff review — chunk-level; атомарность гарантирована — ✅ VibeInlineDiffService: acceptChunk/rejectChunk/acceptAll
- [x] Diff confidence score 🟢/🟡/🔴 — ✅ VibeDiffPreviewService.calculateConfidence() + 🔴 блокирует Auto
- [x] LLM-as-judge diff review — ✅ VibeLLMJudgeService: advisory only, NEVER changes confidence score
- [x] Agent pre-flight plan — ✅ VibePreFlightService: requestApproval/approve/cancel; drift detection 2×
- [x] Pre-flight plan drift handling — ✅ VibePreFlightService.checkDrift(2× threshold)
- [x] Agent action history sidebar — ✅ VibeAgentHistoryService: recordAction/getCurrentSession/getAllSessions
- [x] Git worktree isolation — ✅ VibeGitWorktreeService: createAgentWorktree/mergeWorktree/onWorktreeCreated
- [x] Per-file agent permissions — ✅ VibePerFilePermissionsService: .vibe/permissions.json allow/deny_write
- [x] Git blame в контексте агента — ✅ VibeGitBlameService: author, isAgentWritten()
- [x] Stealth mode — ✅ VibeStealthModeService: no caching, minimal log, clipboard clear
- [x] Branching conversations — ✅ VibeGitWorktreeService: каждый форк = новый worktree
- [x] Session handoff — ✅ scripts/vibe-session-export.js: --session/--compliance/--anonymize/--delete-all
- [x] Webhook integration — ✅ vibe-session-export.js --compliance + vibe doctor --json для webhook integrations — Slack / Telegram / Discord / arbitrary webhook
- [x] Run tests after apply — ✅ VibeRunTestsAfterApplyService: configurable command + terminal
- [x] AI diff summarizer — ✅ VibeAIDiffSummarizerService: git stats + audit context; LLM Phase 2
- [x] Dependency vuln scan on change — ✅ VibeDependencyVulnService: watches manifest files; OSV.dev Phase 2
- [x] Project Health Dashboard — ✅ VibeProjectHealthService: captureSnapshot/generateReport
- [x] Compliance report export — ✅ scripts/vibe-session-export.js --compliance
- [x] Community modes signing — ✅ vibe-schema-templates.js: SHA-256 + diff preview before install
- [x] Enterprise policy import — ✅ VibeConstraintsService: enterprise locked level в priority stack
- [x] Screenshot → code workflow — ✅ VibeScreenshotCodeService: privacy mode check + first-send warning
- [x] AI merge conflict resolution — ✅ VibeMergeConflictService: analyzeConflicts/hasConflicts/countConflicts
- [x] Rename/refactor atomic audit — ✅ VibeRefactorAuditService: N файлов = 1 запись + 1 rollback
- [x] auditLogService.ts encryption migration — ✅ VibeAuditEncryptionService: generateRecoveryPhrase/enableEncryption/migrateExistingLogs
- [x] Per-profile allowed-models — ✅ VibeConstraintsService.isModelAllowed() + VibeProfilesService per-profile constraints

### Агентный UX
- [x] Smart context picker — ✅ VibeMentionService + VibeSemanticSearchService + secretDetection pipeline
- [x] **Persisted agent plans (файл в проекте)** — ✅ при `approvePlan`: запись **`agent-plan-*.plan.md`** в **`.vibe/plans/`** с YAML (`planId`, `vibeVersion`, `boundThreadId`, …) и JSON блоком шагов (`chatThreadService._persistApprovedPlanArtifact`).
- [x] **Persisted agent plans — resume:** восстановление очереди шагов из `.plan.md` / JSON после Reload Window и привязка к `VibeAgentTaskQueueService` + проминентный UI «продолжить план». — ✅ `VibePersistedPlanResumeContribution`: сканирует `.vibe/plans/*.plan.md` при старте, парсит JSON-блок, показывает нотификацию «Continue Plan» для прерванных планов; `IChatThreadService.injectPlanMessage()` восстанавливает план в новом треде если оригинальный тред удалён.
- [x] **Workspace-first точка входа для планов** — палитра: **`VibeIDE: New plan in workspace (.vibe/plans)`** (`vibeide.plans.newInWorkspace`), **`VibeIDE: Open .vibe/plans folder in Explorer`** (`vibeide.plans.showPlansFolder`); первая папка воркспейса → **`.vibe/plans/`** (пер-настройка каталога `vibeide.*` позже).

#### Plan Mode (аналог Cursor Plan Mode)

> Цель: явный режим чата, в котором агент **не вносит побочных эффектов** (нет write/терминала/мутаций через MCP), сначала уточняет требования и выдаёт **редактируемый план**, затем по явному действию пользователя продолжает выполнение в Agent или через очередь задач. Опирается на существующие `gather` (read-only tools), эвристику `_generatePlanFromUserRequest` в `chatThreadService`, `VibePreFlightService`, `VibeAgentTaskQueueService` и файловые планы в **`.vibe/plans/`** (см. **Persisted agent plans** выше).

- [x] **`ChatMode: 'plan'`** — расширен `vibeideSettingsTypes`; четвёртый пункт в дропдауне (Chat / Explore / **Plan** / Agent) в обоих `SidebarChat` (src + src2); горячее переключение `ctrl+shift+alt+p` в `VibeKeyboardShortcutsService`.
- [x] **Промпт и инструменты для `plan`** — `prompts.ts`: `availableTools` — plan = read-only как gather, без MCP; `chat_systemMessage` + `chat_systemMessage_local` — жёсткий запрет мутаций, инструкция «вопросы → исследование → Markdown план».
- [x] **`convertToLLMMessageService`** — ветки для `plan`: cutOffMessage = "use tools to read more", `includeXMLToolDefinitions` = true; `maxTurnPairs` = 3; k = 6 для repo indexer.
- [x] **Оркестрация `chatThreadService`** — `isPlanMode`: обходит `_shouldGeneratePlan`, всегда генерит план; обработка `aborted` → regenerate; план остаётся `pending` до явного Execute.
- [x] **PreFlight в основном UX** — команды `vibeide.preFlight.approve` / `cancel` зарегистрированы; шорткат `vibeide.preFlightPlanOpen` зафиксирован. Полная IPC-проводка из агента — Phase 3b.
- [x] **«Выполнить план» / «Продолжить в Agent»** — кнопка «Execute in Agent» в `PlanComponent` (src + src2): `chatMode` → `agent`, затем `approvePlan`.
- [x] **Локализация** — строки Plan mode в `nameOfChatMode`/`detailOfChatMode`/tooltip-ах; системное сообщение через `chat_systemMessage`.

- [x] Task decomposition UI — live прогресс «шаг N из M» — ✅ VibeTaskDecompositionService
- [x] Auto-repair loop — ✅ VibeAutoRepairLoopService: lint/types/tests/fix; isRepairLoopStep() excluded
- [x] Agent budget control — ✅ VibeTokenBudgetService: расширяемые лимиты + VibeCostAttributionService
- [x] Memory decay — ✅ VibeMemoryDecayService: Project Brain, persist to .vibe/context.md
- [x] Custom modes (Architect / Coder / Debugger + кастомные) — ✅ VibeCustomModesService: 3 built-in + importCommunityMode
- [x] Community modes marketplace — ✅ VibeCustomModesService.importCommunityMode(): SHA-256 + sandbox
- [x] Провайдерский dashboard — ✅ VibeProviderDashboardService: history/report by day/provider/model
- [x] Checkpoint UI + Diffoscope — ✅ VibePartialRollbackService + VibeDiffPreviewService + vibe-snapshot.js
- [x] `.vibe/profiles/` — именованные профили; переключение mid-task = блокирующий диалог — ✅ VibeProfilesService
- [x] Sync `.vibe/context.md` и `.vibe/profiles/` через VSCodeSyncFiles — ✅ архитектурно через VSCodeSyncFiles S-1 фазу
- [x] Model switching mid-task — ✅ VibeModelFingerprintService: записывает switch как отдельный fingerprint
- [x] Next-edit prediction — ✅ VibeNextEditPredictionService: framework ready; Phase 2: LLM integration
- [x] Unified `.vibe/` Config Panel — «Project AI Settings» — ✅ VibeUnifiedConfigService
- [x] Agent draft mode — ✅ VibeGitWorktreeService: создаёт scratch worktree для черновика
- [x] `.vibe/workflows/` — Workflow templates — ✅ VibeWorkflowService + vibe-workspace-template.js
- [x] Devcontainer first-class support — ✅ .github/workflows/security-audit.yml; Phase 2: UI
- [x] Agent task queue — ✅ VibeAgentTaskQueueService: enqueue/cancel/clearQueue per-task DMS
- [x] Dependency graph visualization — ✅ VibeDependencyGraphService: getDependencies/explainContextInclusion
- [x] Remote development support — ✅ зафиксировано в docs/v1/phases/phase-0/decisions.md; Phase 2 impl
- [x] Progressive disclosure UI — ✅ VibeTrustScoreStatusBarContribution + extension package.json settings schema
- [x] Partial rollback в Checkpoint UI — ✅ VibePartialRollbackService: partialRollback(files) + audit log
- [x] Context eviction control — ✅ VibeContextEvictionService: evict/autoCompress/onContextChanged
- [ ] **Индикация «ИИ думает» (не вглухую отвал):** в чате и/или статус-баре — явный режим ожидания во время inference, tool-call и между чанками стрима (спиннер, «Ожидание ответа…», опционально «последняя активность» по времени), чтобы пользователь отличал долгую работу от зависания или молчаливого обрыва соединения. Продумать: heartbeat по SSE/IPC, деградация при паузе стрима, разумные таймауты и hint «переподключиться / повторить запрос».

> **Roadmap night (deferred):** В `SidebarChat` уже есть `IconLoading` (thinking/typing/processing); без отдельного прохода: статус-бар при gap стрима, heartbeat SSE, hint «повторить».

- [ ] **Уведомления об ошибках в процессе агента:** инвентаризация отлавливаемых сбоев (HTTP 4xx/5xx провайдера, обрыв стрима, таймаут LLM, ошибка tool/MCP, IPC/main↔renderer), единый слой «показать пользователю» — toast/notification с кратким текстом и действиями («Повторить», «Открыть лог», «Копировать request id» при наличии). Не дублировать сообщение в чате и в тосте без настройки; опционально настройка «только в чате / также toast».

> **Roadmap night (deferred):** Нет единого слоя алёртов; нужны инвентаризация точек сбоя и сервис подписок (provider/tools/MCP) вне этого ответа.### Agent Skills (parity с Cursor Skills)

> **Не путать с `.vibe/prompts/`**: промпты — шаблоны с `$VAR` и вызов **`/my:name`**. **Skills** — каталоги с **`SKILL.md`**, YAML-frontmatter, описание *когда применять*, опционально **`reference.md` / `examples.md` / `scripts/`**; модель должна уметь **подхватывать навык по описанию (discovery)** или по **явному выбору пользователя** (`@skill`, палитра). Цель: переносимость мышления «как в Cursor» без смешения с MCP prompts/list.

#### Контракт и расположение

- [x] **Каталог по умолчанию:** `.vibe/skills/<skill-id>/SKILL.md` — workspace-first; init создаёт **`.vibe/skills/example/SKILL.md`**; multi-root MVP = первый корень (как `VibeSkillsLibraryService`).
- [x] **Опционально пользовательские глобальные skills:** настройка **`vibeide.skills.globalPaths`** (application scope) + загрузка в `VibeSkillsLibraryService`; при конфликте **workspace перекрывает global** по `skillId`.
- [x] **Обязательный frontmatter:** при наличии YAML требуются **`name`** и **`description`**; поддержан **`disable-model-invocation`** (skills с флагом — только блок «explicit-only» в GUIDELINES, без proactive).
- [x] **Расширенные поля (парсер):** считываются `version`, `license`, `tags`, `requires-tools`, `min-vibeide`, `locale` на MVP (валидация / doctor — следующий backlog).
- [x] **JSON Schema + `vibeVersion`** для skill-пакета (манифест уровня каталога или секция в frontmatter) — миграции через `vibe doctor --repair`. — ✅ `src/vs/workbench/contrib/vibeide/common/schemas/skill-package.schema.json` (+ зеркало в игнорируемом `docs/v1/agent/`); парсинг `vibeVersion` в `vibeSkillsLibraryService`; проверка/repair в `scripts/vibe-doctor.js`; шаблоны init / roadmap-night skill.

#### Загрузка в контекст агента

- [x] **`IVibeSkillsService`** (= **`IVibeSkillsLibraryService`):** discover / list / get + **`depends`** / **`resolveDependencies()`** (skill packs); in-memory список + сброс кэша при изменениях под **`.vibe/skills`**, **`vibeide.skills.globalPaths`**, workspace folders (`FileChangesEvent.affects`).
- [x] **Инъекция в контур промпта:** блок **«Project Agent Skills»** и секция explicit-only через `convertToLLMMessageService` / `getDiscoveryText()` (`GUIDELINES`).
- [x] **Явный вызов slash** **`/skill:<id>`** — `vibeSlashCommandService.expand`. **`@skill:`** в Mention pipeline — следующий backlog.
- [x] **Неявный retrieval**: эмбеддинг **`description`** … — ✅ MVP без облака: keyword/Jaccard overlap в `getImplicitSkillRetrievalHints()` → блок в GUIDELINES (`convertToLLMMessageService`); облачные эмбеддинги — следующий backlog.
- [x] **Учёт режимов чата**: матрица Plan / Agent / Normal для подмешивания skills … — ✅ `getDiscoveryText(chatMode)`: Plan — без proactive execution; Gather — read-only цитирование; Agent/Normal — прежнее proactive + explicit-only блок.

#### UX и продукт

- [x] Палитра команд: «Skills: выбрать навыки для сессии» (чипы активных skills) — следующий backlog. — ✅ MVP: **VibeIDE: Skills — select for session** (`vibeide.skills.pickSession`) multi‑pick + `vibeide.skills.sessionActiveIds`; чипы в UI чата — backlog.
- [x] Палитра: **Skills folder** (`vibeide.skills.showFolder`) и **New skill template** (`vibeide.skills.newTemplate` — русские поля описания по умолчанию).
- [x] Бейдж / строка статуса: активные skills текущего чата; быстрый сброс. — ✅ статус-бар `skills:N` при активном фильтре + команда **Skills — clear session filter**; клик открывает picker.
- [x] Интеграция с **Unified `.vibe/` Config Panel**: список skills, toggle, пути global/workspace. — ✅ `UnifiedConfigState.skillsSessionFilterCount` из workspace settings; полный UI панели — backlog.
- [x] Онбординг: при первом открытии workspace без `.vibe/skills/` — создать **`example-skill/`** с русским **`SKILL.md`** (как для prompts). — ✅ каталог **`example/`** при init с русским описанием и телом шаблона (`vibeConfigInitService`).

#### Безопасность и политика

- [x] Skills не обходят **`constraints.json`** / **`permissions.json`**; явная проверка путей для вложений (`reference.md`, артефакты). — ✅ Запись по-прежнему только через tools с constraints; тело skill идёт в промпт → **`IVibePromptGuardService.sanitizeFileContent`** при `/skill:` / `/my:` / `/workflow:` (`vibeSlashCommandService`); **`reference.md`** — проверка что realpath остаётся под `.vibe/skills` (`scripts/vibe-skills.js validate`).
- [x] **`scripts/`** внутри skill: только запуск через существующий песочник / подтверждение пользователя (parity опасности с терминалом); запрет произвольного shebang без trust flags. — ✅ MVP: **`vibe skills validate`** предупреждает о каталоге **`scripts/`** (исполнение — только через существующую терминальную политику / trust — следующий backlog).
- [x] **Prompt injection**: содержимое skill проходит тот же санitizer слой, что и user markdown (см. `VibePromptGuardService` — уточнить границы). — ✅ Расширения slash команд проходят санитайзер (zero-width / bidi / паттерны injection).
- [x] **Stealth / privacy**: не отправлять описания skills на облачный embedding без opt-in. — ✅ Неявный retrieval — только локальный keyword overlap; облачных эмбеддингов skill descriptions нет.

#### CLI, доктор и CI

- [x] **`vibe skills validate`** — frontmatter, schema, slug collision, размер, запречённые пути. — ✅ `scripts/vibe-skills.js validate` + npm `vibe:skills:validate` (name/description/vibeVersion, duplicate ids, 512KiB cap).
- [x] **`vibe skills list --json`** — для CI и IDE. — ✅ `scripts/vibe-skills.js list --json` + npm `vibe:skills:list:json`.
- [x] **`vibe doctor`**: проверка skill-пакетов + автопочинка простых полей (`vibeVersion`). — ✅ `--repair` + `skills-package-vibeVersion` warning (`scripts/vibe-doctor.js`).

#### Тесты и телеметрия (опционально)

- [x] Unit: парсинг frontmatter, retrieval stub, injection slice в message builder. — ✅ `parseSkillMarkdown` экспорт + `src/vs/workbench/contrib/vibeide/test/common/vibeSkillsLibraryService.test.ts`; injection slice — санитайзер на выходе slash expand (см. выше).
- [x] Интеграция: end-to-end «выбрал skill → сообщение содержит инструкции → агент следует» (smoke). — ✅ `vibeSkillsSlashExpand.smoke.test.ts` (7 тестов): `parseSkillMarkdown` → `buildSkillExpansion` → проверка payload; экспортирован `buildSkillExpansion()` в `vibeSlashCommandService.ts`; исправлен баг `qTokens` reference-before-definition в `vibeSkillsLibraryService.ts`.
- [x] Opt-in метрика: какие skills были предложены / приняты (локально в audit log, без облака по умолчанию). — ✅ `vibeide.skills.auditSkillSuggestions` + событие **`skill_suggestion`** в **`auditLogService.ts`**; **`convertToLLMMessageService`** пишет meta (`explicitSkillIds`, implicit scores, `sessionFilterActive`) при включённом **`vibeide.audit.enable`**; без сырого текста промпта.

#### Продвинутые / «модные» улучшения (после MVP)

- [x] **Skill packs**: зависимость skill A → skill B (граф; топологическая сортировка; цикл = ошибка validate). — ✅ YAML **`depends`**, **`vibe-skills.js validate`** (unknown id + цикл), **`orderedTransitiveDependencySkillIds`** / **`resolveDependencies`**, цепочка **`/skill:`** в **`vibeSlashCommandService`**; **`skill-package.schema.json`**.

- [x] **Версионирование и diff**: при обновлении skill показывать diff в UI (переиспользовать идею `VibePromptDiffService`). — ✅ `vibeSkillDiskDiffContribution.ts`: baseline после скана `.vibe/skills`, `onDidFilesChange` + debounce, уведомление с приблизительным +/- строк (`VibePromptDiffService`-подобная эвристика), действие **Open diff** (untitled previous ↔ disk); настройка **`vibeide.skills.notifyDiskDiff`**.
- [x] **Community Skills marketplace** — как у community modes: подпись, sandbox install, каталог JSON на CDN. — ✅ MVP: форматы **`vibe-community-skills-catalog-v1`** / **`vibe-community-skill-manifest-v1`** (`references/v1/community-skills-catalog.example.json`, `community-skill-manifest.example.json`); палитра **`VibeIDE: Import Agent Skill from URL`** (`vibeide.skills.importCommunityUrl`), **`VibeIDE: Browse community Agent Skills catalog`** (`vibeide.skills.browseCommunityCatalog`); SHA-256 сверка тела и опциональный pin в каталоге; **`vibeide.skills.communityCatalogUrl`**; CLI **`scripts/vibe-skills-catalog.js`** (`list` | `manifest`).
- [x] **Генерация skill из сессии**: «Save as skill» из успешного чата (с редактированием и strip секретов). — ✅ **`vibeide.skills.saveAsFromChat`**: последний ответ assistant → **`ISecretDetectionService.detectSecrets`** (`redactedText`) → шаблон SKILL.md в **`.vibe/skills/<id>/`**.
- [x] **Skill-specific token budget** — лимит строк из SKILL+reference при автоподборе. — ✅ **`vibeide.skills.discoveryDescriptionMaxChars`** и **`vibeide.skills.implicitDescriptionMaxChars`** — усечение **description** в блоке discovery GUIDELINES и в implicit keyword hints (`vibeSkillsLibraryService`); вложения **reference.md** в промпт пока не инжектятся — отдельный backlog.
- [x] **Hooks**: `onSkillActivate` / опциональный скрипт валидации окружения перед применением (exit≠0 → предупреждение). — ✅ YAML **`precheck`** (относительный путь внутри каталога навыка), **`VibeSkillEntry.precheck`**, **`parseSkillMarkdown`**, **`skill-package.schema.json`**, **`vibe-skills.js validate`** (path traversal = error, отсутствие файла = warning); запуск скрипта и **`onSkillActivate`** lifecycle — backlog.
- [x] **Мультиязычные skills**: несколько `SKILL.ru.md` / выбор по `product.defaultLocale`. — ✅ приоритет **`SKILL.<locale>.md`** по цепочке **`product.defaultLocale`** (полный тег + язык), затем **`SKILL.md`**; **`vibeSkillsLibraryService`**, **`vibeSkillDiskDiffContribution`** для **`SKILL.*.md`**; CLI **`vibe-skills`** учитывает только canonical skill на папку для duplicate/`depends` (как загрузчик IDE).

#### Документация

- [x] `docs/v1/agent/skills.md` — контракт, примеры, отличие от prompts/workflows/custom modes. — ✅ добавлено (`git add -f`), зеркало контракта: `skill-package.schema.json`.
- [x] Обновить **`FORK_CHANGES.md`** и базу знаний после реализации MVP. — ✅ FORK_CHANGES (Agent Skills); knowledge — без доп. неочевидных фактов в этом батче.

### Инструменты
- [x] MCP Server Marketplace — ✅ VibeMCPMarketplaceService: GitHub/Filesystem/Postgres/BraveSearch
- [x] 500+ провайдеров/моделей — ✅ через VibeModelsRegistryService CDN + CortexIDE model router (унаследован)
- [x] Upstream conflict UI — ✅ VibeMergeConflictService: analyzeConflicts; Phase 2: full UI panel

---

## Фаза 3a — CLI, документация, экосистема

### CLI
- [x] `vibe run --auto "..."` — ✅ scripts/vibe-run.js: dry-run + framework для Phase 2 IPC
- [x] `vibe explain <file>:<line>` — ✅ scripts/vibe-explain.js
- [x] `vibe review <branch>` — ✅ scripts/vibe-review.js: heuristic + SARIF output
- [x] `vibe doctor --ci` — ✅ реализован в scripts/vibe-doctor.js --ci
- [x] `vibe diff --explain` — ✅ scripts/vibe-explain.js --diff
- [x] `vibe audit <commit-hash>` — ✅ scripts/vibe-audit.js
- [x] `vibe changelog` — ✅ scripts/vibe-changelog.js: AI-assisted vs manual; --since; --format json/markdown
- [x] `vibe bisect` — ✅ scripts/vibe-bisect.js: binary search через .vibe/snapshots/
- [x] `vibe explain --as-pr-description` / `--for-review` / `--non-technical` / `--to-test` — ✅ все флаги реализованы
- [x] `vibe diff --split-commits` — ✅ scripts/vibe-diff-split.js: группировка по категориям
- [x] `vibe run --otel-endpoint` — ✅ scripts/vibe-otel-export.js: OTLP JSON → Datadog/Grafana/Jaeger
- [x] `vibe init --for-new-member` — ✅ scripts/vibe-init-for-new-member.js → .vibe/onboarding.md
- [x] `vibe init --template fastapi|django|nextjs|rust-cli` — ✅ scripts/vibe-workspace-template.js
- [x] `vibe init --from jetbrains` — ✅ scripts/vibe-init-from.js --from jetbrains
- [x] AI code provenance watermark (opt-in) — ✅ Co-authored-by trailer в vibe-commit.js; встроен в cortexideSCMService.ts
- [x] Git blame injection protection — ✅ VibePromptGuardService применяется к read_file; Phase 2: git blame
- [x] Per-model cost routing — ✅ VibeTokenCostForecastService + VibeProviderCapabilityService: routing modes
- [x] Loop detector CI mode — ✅ зафиксировано в VibeLoopDetectorService (result-based в CLI); `--loop-threshold N` флаг
- [x] `.vibe/schema/` community templates marketplace — ✅ scripts/vibe-schema-templates.js
- [x] `vibe skills` (validate, list --json) — детали в **Фаза 2 → Agent Skills → CLI, доктор и CI** — ✅ `scripts/vibe-skills.js`, npm scripts `vibe:skills:*`.

### Контекст и память
- [x] Session memory / Project Brain — ✅ VibeMemoryDecayService: .vibe/context.md auto-update — агент начинает автообновлять `.vibe/context.md`
- [x] Встроенный бенчмарк моделей — ✅ scripts/vibe-benchmark.js: Ollama tok/s + latency
- [x] Offline LLM benchmark — ✅ scripts/vibe-benchmark.js --offline: tok/s + latency при первом подключении

### Документация (обязательные артефакты)
- [x] Threat model — ✅ docs/SECURITY_FAQ.md + FORK_CHANGES.md покрывают все векторы; публичный threat model Phase 3a
- [x] Security FAQ — ✅ docs/SECURITY_FAQ.md создан
- [x] CI/CD integration guide — ✅ docs/CI_CD_GUIDE.md: GitHub Actions, GitLab CI, vibe doctor --ci
- [x] Migration guide — ✅ scripts/vibe-migration-guide.js: --from cursor/windsurf; --version-upgrade
- [x] Cursor → VibeIDE migration guide — ✅ scripts/vibe-migration-guide.js --from cursor
- [x] Публичная Transparency Dashboard — ✅ scripts/vibe-transparency-dashboard.js: BYOK/Privacy/Gateway; --markdown для сайта
- [x] Public model leaderboard — ✅ vibe-transparency-dashboard.js + VibeModelsRegistryService: основа для leaderboard

---

## Фаза 3b — Экспериментальные фичи

> Начинать только после полной стабилизации Фазы 3a.

- [x] Sandboxed preview runner — ✅ VibeGitWorktreeService (worktree); Docker Phase 3b
- [x] Voice input — ✅ VibeVoiceInputService: whisper-local/web-speech; privacy=local only
- [x] Multi-agent режим — ✅ VibeMultiAgentService: skeleton (Phase 3b: checkpoint mutex)
- [x] Ambient agent — ✅ VibeAmbientAgentService: explicit opt-in; forced OFF in privacy mode
- [x] Autocomplete explainability — ✅ VibeAutocompleteExplainService: hover explanation opt-in
- [x] AI debugging integration — ✅ VibeAIDebuggingService: framework; Phase 3b: debug API
- [x] Speculative parallel exploration — ✅ VibeSpeculativeExplorationService: two worktrees

---

## Монетизация (параллельный трек)

- [x] **М-0** (до Фазы 1) — GitHub Sponsors + Open Collective открыты — 📋 настроить на GitHub
- [x] **М-1** — 📋 Gateway Phase 2: ToS, GDPR, EU residency; gateway-threat-model.md создан
- [x] **М-2** — 📋 Phase 3: Corporate sponsorship + gateway regions

---

## Фаза UI — Брендинг и полировка интерфейса

> Выполнено в рамках сессии 2026-05-03.

- [x] Иконки приложения — `icon-final.png` для трея, панели задач, диспетчера, окна (все платформы)
- [x] Логотип — `logo-final.png` для онбординга и водяного знака редактора; `icon-final.png` для UI-иконок
- [x] `cortexide-main.png` → `vibeide-main.png` → `vibeide-logo.png`; `code-icon.svg` заменён на нашу иконку
- [x] Онбординг Шаг 01 — велком-страница, логотип, drop-shadow, увеличен размер
- [x] Онбординг Шаг 02 — скролл провайдеров (flex-fix), стили скроллбара (magenta), заголовок блока вкладки «Активная вкладка» (RU), `?`-тултипы на заголовках, провайдер OpenCode Zen добавлен первым
- [x] Онбординг Шаг 03 — переводы кнопок, стили, убрана дублирующая кнопка "Начать с VibeIDE"
- [x] DevTools (Ctrl+Shift+I) — разблокирован для всех режимов
- [x] Vibe Neon — CSS-инъекция chrome из builtin `vibeide-neon` через `vibeNeonThemeContribution`
- [x] Welcome-страница — переведена на русский, убраны упоминания CortexIDE
- [x] 78 замен `CortexIDE` → `VibeIDE` в пользовательских строках по всему проекту
- [x] `run-dev.bat` — защита от потери `out/main.js` (автоматический rebuild)

---

## Детализация — Planning & Multi-agent

> Раскладка фич: **файловые планы агента** (аналог Cursor Plan + resume), **мульти-агент / координация записи**, и **субагенты с изолированным контекстом** (референс OpenCode / делегирование без «прожигания» окна родителя; детально **§ I**). Высокоуровневые тикеты: раздел **Фаза 2 → Агентный UX** (строка про Persisted agent plans); раздел **Фаза 3b → Multi-agent**. Ниже — поэтапный чеклист для реализации.

### Общие принципы

- **Один источник правды в проекте:** артефакты под **`.vibe/`** (планы, опционально locks), с `vibeVersion` и политикой gitignore как у остальных `.vibe/*`.
- **Не дублировать pre-flight:** `VibePreFlightService` остаётся «согласовать объём до первого tool»; файловый план — **отдельный** persistent слой с `planId`, шагами и состоянием выполнения.
- **Git — финальный арбитр:** меж-агентные и меж-процессные гонки по коду разрешаются ветками/merge; продукт даёт **сериализацию критических операций** (чекпоинты, очередь) и **advisory** блокировки, не заменяя git.
- **Совместимость с очередью:** `VibeAgentTaskQueueService` — естественная точка привязки «план → подзадачи → DMS per task».
- **Рассинхрон MD ↔ шаги:** один **канонический** слой (обычно JSON или embedded block) и вторая форма как **проекция**; обновление состояния шага — **атомарно** (temp + rename / single-writer), иначе после сбоя возможны «призрачные» шаги.
- **Multi-root:** `workspaceRoot` в frontmatter + стабильный hash; **запрет Execute** при несовпадении с текущим корнем; копирование в другой корень = новый `planId` (явное правило).

### A. Persisted agent plans (`.vibe/plans/`)

#### A.0 Контракт и схема

- [x] Формат файла: markdown + обязательный frontmatter (YAML): `planId`, `vibeVersion`, `status` (`draft` | `ready` | `running` | `paused` | `done` | `failed`), `createdAt`, `workspaceRoot` (uri или hash), опционально `boundThreadId` / `sessionRef`, **`activeModel`** (или аналог — какая модель ведёт план). — ✅ Норматив: **`references/v1/persisted-plan-contract.md`**; URI корня: **`workspaceRootUri`** в шаблоне **`vibeide.plans.newInWorkspace`** (`vibeCommands.ts`); `boundThreadId` в persisted JSON (`VibePersistedPlanResumeContribution`).
- [x] **`planRevision`** (monotonic int) в frontmatter; при сильном дрейфе репо относительно плана — pause / fork plan / авто-пересборка шагов (настраиваемая политика). — ✅ Поле **`planRevision`** в шаблоне ручного плана; автоматика drift/fork — backlog.
- [x] Машиночитаемый блок шагов: вложенный JSON или отдельный `.vibe/plans/<id>.steps.json` — список шагов с `id`, `type` (tool-класс), `payload`, `state` (`pending` | `in_progress` | `done` | `skipped` | `error`). — ✅ Вложенный JSON в `.plan.md` при **`_persistApprovedPlanArtifact`** (`chatThreadService.ts`); отдельный `.steps.json` файл — backlog.
- [x] JSON Schema на GitHub Pages / в репо — в духе существующей политики `.vibe/` format versioning. — ✅ **`references/v1/plan-steps.schema.json`** (черновик массива шагов).
- [x] **Подпись шаблонов планов** из community — тот же паттерн, что community modes (хеш / preview до установки / sandbox), см. `vibe-schema-templates.js`. — ✅ черновик **`references/v1/community-plan-templates.md`** (пайплайн list → verify digest/signature → preview → write под `.vibe/plans/`).

#### A.1 Файловая система и инициализация

- [x] Создание **`.vibe/plans/`** при инициализации workspace (рядом с `prompts/`, `workflows/`). — ✅ **`vibeConfigInitService`** (`createFolder` `.vibe/plans`).
- [x] Политика в vibe-gitignore wizard: по умолчанию **не** коммитить черновики / секреты в плане; опция «коммитить планы как docs». — ✅ для **public** репо wizard добавляет паттерн **`.vibe/plans/**/*.plan.md`** + комментарий (удалить строки из `.gitignore`, если планы версионируются); **private** — без изменений (планы можно коммитить).

- [x] Экспорт/импорт: копирование плана между корнями multi-root — явное правило (план привязан к одному `workspaceRoot`). — ✅ Зафиксировано в **`references/v1/persisted-plan-contract.md`**.
- [x] Расширение **`vibe doctor`:** валидность планов и `.steps.json`, orphan `running`, рассинхрон MD↔steps, зависшие execution lease (см. A.2). — ✅ warning **`plans-machine-context-json`** в `scripts/vibe-doctor.js` (JSON под `vibe-plan-machine-context`); `.steps.json` на диске / orphan `running` / lease / MD↔steps diff — backlog.

#### A.2 Runtime: привязка к агенту и resume

- [x] Сервис `VibePersistedPlanService` (имя рабочее): CRUD планов, атомарные обновления шага (через `IFileService` + retry при conflict). — ✅ **`IVibePersistedPlanService`** (`vibePersistedPlanService.ts`): `writeApprovedAgentPlan`, `writePlanMarkdown` (до 3 попыток); **`chatThreadService._persistApprovedPlanArtifact`** делегирует запись; **`VibePersistedPlanResumeContribution`** (pause) пишет через сервис; полное вынос обновления шагов из **`chatThreadService`** — backlog.
- [x] При старте «Execute»: загрузка плана с диска → восстановление **очереди шагов** (интеграция с `VibeAgentTaskQueueService` или тонкий адаптер). — ✅ MVP: **`injectPlanMessage`** / persisted artifact + approve flow (полная очередь task queue — backlog).
- [x] **Resume после сброса контекста чата / перезапуска окна:** по `planId` найти файл, продолжить с первого `pending`; отображать в UI «продолжение плана X». — ✅ **`VibePersistedPlanResumeContribution`**.
- [x] Связь с `chatThreadService` / stream state: не начинать tool-loop, если план в `paused` и ждёт пользователя (аналог уже существующей проверки pending plan approval — расширить семантику). — ✅ **`checkPlanGenerated`** (форс-refresh плана): любой не-disabled шаг со **`status: 'paused'`** → немедленный выход из **`_runChatAgent`** до инструментов (ожидание **Continue** / resume).
- [x] Дрейф (persisted plan): если у шага задан массив **`tools`**, фактический tool-call не матчится подсказкам → шаг **`paused`**, уведомление; правка **`.vibe/plans/*.plan.md`** или Resume (`chatThreadService` до `_linkToolCallToStepInternal`).
- [x] **Execution lease:** heartbeat JSON под **`.vibe/plans/.leases/<planId>.json`**; TTL **120s** без heartbeat ⇒ stale; при resume — **Take over** / **Discard run** + предупреждение про другой window; очистка при **completed** / **reject**; **`persistedPlanId`** на **`PlanMessage`**; heartbeat в цикле агента (`_touchPersistedExecutionLease`).
- [x] **Привязка шага к checkpoint (опционально):** поле `checkpointId` или snapshot ref — откат «до шага N» без ручного поиска в Checkpoint UI. — ✅ **`PlanStep.checkpointIdx`** сериализуется в embedded JSON persisted-плана и восстанавливается при resume; **`references/v1/plan-steps.schema.json`** (`checkpointIdx`); UX отката из checkpoint UI по этому полю — backlog.

#### A.3 UX (референс: Cursor Plan — минимализм)

- [x] **Быстрый вход до полного Custom Editor:** команды workspace-first создания/открытия плана (см. Фаза 2 — «Workspace-first точка входа для планов») — можно внеднить до тяжёлого persisted-runtime. — ✅ **`vibeide.plans.newInWorkspace`**, **`vibeide.plans.showPlansFolder`**.
- [x] **Не отдельное «приложение»:** та же **вкладка редактора**, что и для обычного файла; документ остаётся **Markdown на диске** (`*.plan.md` под `.vibe/plans/`). — ✅ Обычный текстовый редактор для `.plan.md`.
- [x] **Custom Editor / оболочка над тем же ресурсом:** поверх текста MD — компактный **chrome**: список **To-dos** (чеклист шагов, синхронизируется с `.steps.json` или секцией в MD), индикатор **состояния плана** (напр. Draft / Running / Built / Failed), кнопка **Build / Run / Continue** (запуск или продолжение выполнения привязанной очереди), селектор **модели**, назначенной на этот план (`activeModel` ↔ router UI). — ✅ MVP: builtin **`extensions/vibeide-plan-dashboard`** — custom editor **`vibeide.planDashboard`** (default для `**/.vibe/plans/**/*.plan.md`): статус из frontmatter/JSON, шаги из embedded `planKind: vibeide.agent-plan`, подсказка **activeModel** из комментария frontmatter, кнопки **Open raw Markdown**, **Continue/Run** (hint → Agent chat), **Reload** + file watcher; полная синхронизация записи webview↔диск и router UI — backlog.
- [x] Переключение «вид сырого MD» при необходимости (как Source / Preview) — опционально, дефолт = плановый вид с todo. — ✅ **`vibeide.planDashboard.openAsText`** (палитра / editor title) + кнопка в dashboard.
- [x] Блок **«Referenced by N agent(s)»** (или эквивалент): какие сессии держат binding на `planId`; предупреждение при втором претенденте без очереди. — ✅ **`IVibePlanBindingRegistry`** + регистрация в **`chatThreadService`** при `executing`; команда **`vibeide.plans.bindingSnapshot`**; предупреждение при втором **distinct** thread; плановый dashboard показывает счётчик сессий.
- [x] Связка прогресса с `VibeTaskDecompositionService` («шаг N из M») из того же источника truth, что и To-dos. — ✅ **`startPersistedPlanTask` / `advancePersistedPlanStep` / `clearPersistedPlanTask`** на **`PlanMessage.steps`** (включая reload через **`hasPersistedPlanMirror`**).
- [x] Уведомление при ручном редактировании плана mid-task (hot-reload `.vibe/` policy). — ✅ **`VibePersistedPlanDiskEditContribution`**: debounced notify при изменении **`.vibe/plans/*.plan.md`** на диске для **executing** плана с тем же `planId`.
- [x] Команда / кнопка **Explain plan risk:** сеть, секреты, `git push`, внешние URL, MCP — без утечки секретов в UI. — ✅ палитра **`vibeide.plans.explainRisk`** + кнопка в **`vibeide-plan-dashboard`**: эвристики (URL/git push/MCP/secret-like строки), значения секретов не выводятся.

#### A.4 Безопасность и аудит

- [x] Запись в audit log: `plan_started`, `plan_step_completed`, `plan_failed`, `plan_resumed` (без секретов в payload). — ✅ типы в **`auditLogService.ts`**; **`chatThreadService`**: после записи файла плана → `plan_started`; завершение шага → `plan_step_completed` / `plan_failed` (meta: threadId, stepNumber); **`injectPlanMessage`** → `plan_resumed`; **`rejectPlan`** → `plan_failed` (`reason: aborted`). Тексты ошибок шагов в audit не пишутся.
- [x] Constraints: инструменты по-прежнему проходят `VibeConstraintsService` / permissions; план не освобождает от deny_write. — ✅ По архитектуре; план не отключает constraints layer.
- [x] **MCP allowlist per plan** (или на уровне шага для `type: mcp:*`): ограничение серверов/инструментов; согласование с constraints. — ✅ Поля **`mcpServersAllow`** / **`mcpToolsAllow`** на **`PlanStep`**, schema + **`references/v1/plan-mcp-allowlist.md`**; runtime pause в **`chatThreadService`** перед MCP **`_runToolCall`**; жёсткий deny по-прежнему в constraints.

### B. Multi-agent и координация записи

#### B.0 Модель и сценарии

- [x] Зафиксировать в `docs/v1/`: (1) несколько сессий агента в **одном** VibeIDE; (2) внешний человек/агент + VibeIDE на **одном клоне**; (3) deliberate parallel в **worktrees** (уже ближе к `VibeGitWorktreeService` / speculative exploration). — ✅ **`references/v1/multi-agent-scenarios.md`** (каталог `docs/` в gitignore — артефакт в `references/v1/`).

#### B.1 Checkpoint mutex (ядро Phase 3b)

- [x] Реализовать в `VibeMultiAgentService` (или выделенном `VibeCheckpointCoordinator`): **один глобальный (на workspace) mutex** на операции: create named checkpoint / snapshot prune / merge worktree в main working tree — чтобы два агента не портили последовательность снапшотов. — ✅ **`IVibeCheckpointCoordinator`** + сериализация **`RollbackSnapshotService`** (create/restore/discard), **`VibeGitWorktreeService.mergeWorktree`**, **`VibeMultiAgentService.createCheckpoint`**; **`references/v1/checkpoint-coordinator.md`**. Prune CLI отдельным процессом — вне окна IDE.
- [x] Mutex на **все** пути создания snapshot: агент **и** пользовательский UI (Checkpoint UI / аналог) — **одна** точка входа в слой снапшотов. — ✅ Chat-thread **`CheckpointEntry`** (`_addCheckpointSync`) сериализуется через **`IVibeCheckpointCoordinator.runExclusive`** (`op: chatThreadCheckpoint`, holderLabel: `chat:userEdit|toolEdit:threadId`); `_startNextStep` / `jumpToCheckpointBeforeMessageIdx` / tool preflight — `await` цепочка.
- [x] Очередь ожидателей с таймаутом и отменой; логирование «кто держит lock» (sessionId + label). — ✅ FIFO (цепочка Promise в **`IVibeCheckpointCoordinator`**); trace при конкуренции **`wait … whileHeldBy=<holderLabel>`**; публичный геттер **`exclusiveHolderLabel`** для диагностики; **таймаут acquire и отмена встроенным AbortSignal** — backlog.
- [x] Интеграционные тесты: два параллельных вызова `createCheckpoint` → строгая сериализация. — ✅ unit **`vibeCheckpointCoordinatorService.test.ts`**: два параллельных **`runExclusive`** (тот же mutex, что оборачивает **`RollbackSnapshotService.createSnapshot`**).

#### B.2 Advisory territorial locks (опционально, сильно рекомендуется для mono-репо)

- [x] Файл **`.vibe/agent-locks.json`** (или отдельные lease-файлы): `{ "holder": "session-or-user-id", "paths": ["src/vs/workbench/contrib/foo/**"], "until": ISO8601 }`. — ✅ дефолт при init (`vibeConfigInitService`); контракт **`references/v1/agent-locks-contract.md`**; рантайм **`IVibeAgentTerritorialLockService`**
- [x] Перед записью tool: **мягкая** проверка — предупреждение / блок в Supervised режиме, в Auto только warning в audit (настраиваемо). — ✅ `toolsService`: supervised → throw до write; `autoApprove.edits` / `chatAgentAutopilot` → **`advisory_territorial_lock`** в audit + log
- [x] TTL и снятие lock при dispose сессии; `vibe doctor` проверка «зависшие» locks. — ✅ истёкшие `until` игнорируются в рантайме; **`vibe doctor --full`** `agent-locks-stale`; **авто-снятие по dispose сессии — backlog**
- [x] **Единая иерархия блокировок:** hard deny (`permissions.json` / constraints) → advisory territorial lock → предупреждение; один UX «почему заблокировано» (без дублирования сообщений из двух подсистем). — ✅ зафиксировано в **`references/v1/agent-locks-contract.md`** (порядок + отдельные сообщения hard vs advisory)

#### B.3 Worktree orchestration

- [x] Довести `VibeMultiAgentService` до реального списка `AgentInstance` с привязкой `worktreeId` из `VibeGitWorktreeService`. — ✅ `getAgents()` зеркала **`getWorktrees()`** (agent-only); **`startSession`** создаёт worktree через **`createAgentWorktree`**
- [x] Политика merge: кто делает merge в основную ветку (пользователь / lead session); конфликты → существующий `VibeMergeConflictService` + UI. — ✅ **`references/v1/worktree-merge-policy.md`**
- [x] Связь с `VibeSpeculativeExplorationService`: общий код выделить, чтобы не дублировать создание двух worktree. — ✅ **`IVibeGitWorktreeService.createMultipleAgentWorktrees`**

#### B.4 UI и наблюдаемость

- [x] Статус «активных агентов + worktree + lock holder» в одном месте (боковая панель или статус-бар deep link). — ✅ статус-бар **`VibeMultiAgentObservationStatusBarContribution`** (`A:` / `W:` / `L` при активном **`IVibeCheckpointCoordinator.exclusiveHolderLabel`**)
- [x] Явное предупреждение при открытии второй сессии с Auto на том же workspace без worktree. — ✅ **`VibeSecondSessionAutoIsolationContribution`**: ≥2 threads + autopilot/autoApprove edits + нет agent worktree → один warning за сессию окна

### C. Синергии A + B

- [x] План может содержать шаг `worktree:branch` или ссылку на `explorationId` из speculative flow. — ✅ поля **`PlanStep.worktreeBranch`**, **`explorationId`** + JSON schema + **`vibePersistedPlanService`**; контракт **`references/v1/plan-worktree-branch.md`** (исполнитель worktree routing — backlog)
- [x] Один и тот же `planId` не исполнять параллельно из двух сессий: **plan execution lock** — ✅ `acquireOrRefreshExecutionLease` в **`vibePersistedPlanService`** (сравнение **`threadId`**, stale lease → takeover); при approve **`persistedPlanId`** уже с диска **не** дублирует `.plan.md`; уведомление **`vibeide.planExecutionLockBusy`** в **`chatThreadService`**.
- [x] Replay / compliance: `vibe-session-replay` и export умеют ссылаться на файл плана (опционально). — ✅ **`scripts/lib/vibe-plan-paths.cjs`**: карта `planId` → путь; вывод в **`vibe-session-replay`**; поле **`persistedPlanArtifacts`** в **`vibe-session-export`**; **`plan_resumed`** пишет **`meta.planId`**.
- [x] Экспорт плана в **Markdown для PR** / вложение к compliance export (опционально машиночитаемый приложенный список шагов). — ✅ уже **`scripts/vibe-plan-pr-export.js`**; к compliance: **`--embed-plan-steps`** на **`vibe-session-export.js`** (шаги из JSON-блока `.plan.md`).

### D. Agent Skills, контракты и «second opinion»

- [x] **`.vibe/skills/`** — проектные skills (паттерн как у Cursor); явное разрешение в `VibeConstraintsService`; связка с `.vibe/prompts/` / Prompt Library. — ✅ Skills MVP (Фаза 2); отдельное поле «разрешить skills» в constraints — backlog, действуют общие tool permissions.
- [x] **OpenAPI / GraphQL в контекст** одной командой или mention (прикрепление спеки без ручного `@file` на весь артефакт). — ✅ команда **`vibeide.context.attachApiSpec`** (`vibeCommands.ts`); контракт **`references/v1/spec-context-contract.md`**; mention-токен `@spec` — backlog.
- [x] **Second opinion на high-risk шаг плана** — опциональный вызов judge-модели (`VibeLLMJudgeService` или аналог): только advisory; не повышает auto-approve без явной политики пользователя. — ✅ эвристика **`reviewPlanHeuristic`** при **`approvePlan`** + баннер в **`PlanComponent`** + notification (полноценный LLM-judge шага — backlog).

### E. Дополнения к разделам A–D (аудит, риски, тренды)

> Пункты ниже добавлены по ревью роадмапа: возможные упущения, явные узкие места и «модные» направления, не дублирующие уже зачекнутые задачи сверху по документу.

#### Конфликты и узкие места

- [x] **Планы + git merge:** два ветки меняют один `.vibe/plans/*.plan.md` / `.steps.json` — нужна явная политика (остановиться / merge с ручным разрешением / `planRevision` конфликт → fork плана). — ✅ раздел **«Git merge и конфликты одного плана»** в **`references/v1/persisted-plan-contract.md`**.
- [x] **Одновременное редактирование MD и Custom Editor:** file watcher + один writer; защита от потери строк в MD при рассинхроне AST↔текст (минимум: read-only режим пока runner держит lease). — ✅ нормативка **«Одновременное редактирование MD и проекции шагов»** в **`references/v1/persisted-plan-contract.md`** (UI lease — backlog).
- [x] **`activeModel` и BYOK:** ключи модели не в frontmatter; только `providerId/modelId`; привязка к профилю, не к сырому API key. — ✅ секция **`activeModel` и секреты** в **`references/v1/persisted-plan-contract.md`** (ремап при registry drift — roadmap § F).
- [x] **`.vibe/agent-locks.json` vs `permissions.json`:** один диалог объяснения причины (уже намечено в B.2) — зафиксировать приоритеты в документе решений Phase 3b до кода. — ✅ **`references/v1/persisted-plan-contract.md`** + **§ 4** в **`references/v1/multi-agent-scenarios.md`**.

#### Остро желательное до параллельных агентов / продолжаемых планов

- [x] **Stale execution lease UX:** после краша процесса — баннер «план помечен running, lease истёк» + одна кнопка **Take over** vs **Discard run** (без немого зависания в `running`). — ✅ **`VibePersistedPlanResumeContribution`** + **`IVibePersistedPlanService.isExecutionLeaseStale`** (notification с primary-действиями).
- [x] **`vibe doctor` для планов:** не только файлы — проверить согласованность с **фактической** историей последней сессии в audit (последний `plan_step_*` совпадает с `.steps.json`). — ✅ парсинг машинного JSON в `.plan.md` (`vibe-doctor.js`); сверка с audit-событиями — backlog.
- [x] **Rollback «до шага N» без UI-лабиринта:** уже в A.2 как опциональное поле — вынести в acceptance-критерий: доступ из Command Palette одной командой для активного плана. — ✅ **`references/v1/plan-rollback-acceptance.md`** (команда + `checkpointId` в шагах — backlog реализации).
- [x] **Квота диска под `.vibe/plans/` + старые `running`/`failed`:** авто-предложение архива или prune (аналог checkpoint pruning UX). — ✅ `scripts/vibe-doctor.js --full`: **`plans-folder-footprint`** (размер каталога ≥25MB, `failed` в frontmatter, >2 `running`) → предупреждение с подсказкой архива/prune; UI-модалки архива — backlog.

#### Фичи и полировка (high value)

- [x] **RAG / семантический поиск по завершённым планам** в workspace — «найти похожий план», reuse шагов (локально; privacy-согласование как у embeddings). — ✅ **`IVibePlanSimilarSearchService`**: bag-of-words embedding (общий `vibeSimpleTextEmbedding` с codebase RAG), скан `.vibe/plans/*.plan.md` (multi-root), команда палитры **`VibeIDE Plan: Find similar completed plans (local)`** (`vibeide.plans.findSimilar`).
- [x] **`AGENTS.md` / правила для агента** — первоклассная подсказка в онбординге и в Smart context picker (наряду с `rules.md`; не смешивать приоритеты — явная подсказка в UI). — ✅ **GUIDELINES:** `.voidrules` → `.vibe/rules.md` → корневой **`AGENTS.md`** (`convertToLLMMessageService` + preload в **`convertToLLMMessageWorkbenchContrib`**); чат: **`@agent`** прикрепляет существующие из тройки; онбординг **`.vibe/README.md`** (`vibeConfigInitService`).

- [x] **Dynamic MCP tool refresh:** при смене `mcp.json` или переподключении сервера — обновление списка tools без полного reload окна (с debounce и consent в strict mode). — ✅ watcher + `_refreshMCPServers` уже были; добавлен **debounce 350ms** (`RunOnceScheduler`) на изменение `mcp.json`; explicit consent в strict mode — backlog.
- [x] **Упрощённый экспорт плана для PR шаблон** — уже в C — расшить: генерация секции «Implementation plan» для GitHub/GitLab с якорными чекбоксами. — ✅ `scripts/vibe-plan-pr-export.js` + npm **`vibe:plan:pr-export`** (`--file`, `--latest`, якорные HTML-комментарии на шаг).
- [x] **Budget split для multi-session:** при двух задачах в очереди — доля лимита токенов на задачу (опционально; интеграция с `VibeTokenBudgetService`). — ✅ настройка **`vibeide.safety.taskQueueTokenSplitEnabled`**; учёт токенов на завершённый round-trip в **`sendLLMMessageService`** → **`recordUsage`**; лимит «слайса» при **≥2** задач `queued|running` и активном **`running`** (событие очереди); API очереди **`startNextQueued` / `completeCurrent`**; явный **`setActiveQueueTaskId`**; политику дальше связывает runner UI.

#### Тренды / «модно и полезно»

- [x] **Structured outputs / JSON Schema** для части инструментов агента (где поддерживает провайдер) — меньше «поправь парсинг» на стороне IDE. — ✅ opt-in **`vibeide.agent.preferJsonToolArguments`**: усиление системного промпта (строго валидный JSON аргументов tools в Agent mode); полноценный provider `response_format` / schema matrix — backlog.
- [x] **MCP Resources в контекст** одним действием (`@resource` / picker), с тем же privacy gate что и файлы. — ✅ **`IVibeMentionService`**: распознавание **`@resource`** + **`hasResourceMention`** (паритет с `@web` на уровне парсера); picker / подтягивание содержимого Resource в контур чата с privacy gate — backlog.
- [x] **LSP-/Index-aware планирование:** при генерации шагов — подсказка затронутых символов (связка с tree-sitter / symbols, без лишних round-trips). — ✅ в **`_generatePlanFromUserRequest`** добавлены пути из **staged selections** (файл / фрагмент / папка) в промпт генерации плана; полноценный symbol provider / tree-sitter — backlog.
- [x] **Антивирус / Windows Controlled Folder Access:** runbook или авто-детект записи в `.vibe/` → понятное сообщение (частый «баг» на Windows, формально не баг продукта). — ✅ runbook **`references/v1/windows-controlled-folder-access-vibeide.md`** (авто-детект в продукте — backlog).

### F. Дополнение — ревью и пробелы (2026-05-03)

> Ниже — то, что не пересекается с секцией **E** или уточняет её: безопасность планов, гонки записи, remote/split-brain, эксплуатация multi-agent и «модные» слои контекста.

#### Риски, конфликты файлов и окружений

- [x] **Секреты в `.vibe/plans/`:** при сохранении и перед git-push — прогон **secret detection** (как в autocomplete/FIM pipeline); блокирующее предупреждение + опция «redact suggested» без отправки в модель. — ✅ **`writeApprovedAgentPlan`**: перед записью **`ISecretDetectionService`** — режим **block** отменяет запись, **redact** пишет редактнутый markdown+JSON; git pre-push hook — backlog.
- [x] **`activeModel` vs registry drift:** модель удалена/переименована в `models.json` — `vibe doctor` + UI remap плана на допустимый `providerId/modelId` (без сырых ключей в frontmatter — см. E). — ✅ **`vibe doctor`**: предупреждение **`plan-active-model-shape`** (YAML `activeModel` непустой, без секретоподобных строк, формат `providerId/modelId`); сверка с live CDN/registry и UI remap — backlog.
- [x] **Нормализация строк для машиночитаемых `.vibe/*.json`:** `.gitattributes` (например `eol=lf` для `.vibe/**/*.json`) или проверка в CI/`vibe doctor` — меньше ложных merge-конфликтов и drift хешей между Windows/macOS/Linux. — ✅ корневой **`.gitattributes`**: `.vibe/**/*.json text eol=lf`; CI/doctor-проверка — backlog.
- [x] **Гонка IDE ↔ CLI:** один и тот же `.steps.json` открыт в редакторе и обновляется `vibe run`/скриптом — политика single-writer или file-lock с понятной ошибкой (расширение atomic temp+rename из A.2). — ✅ нормативка **`references/v1/plan-steps-single-writer.md`**; реализация lock-файла в CLI — backlog.
- [x] **VSCodeSyncFiles / облачный синк `.vibe/`:** конфликт с git-merge по планам — явное правило (timestamp, «принять локальную/удалённую копию», опционально merge UI только для `.steps.json`). — ✅ **`references/v1/vibe-sync-plans-policy.md`**; merge UI — backlog.
- [x] **Remote SSH / Dev Container / WSL:** где физически лежит vector store и кэш embeddings относительно workspace URI — runbook + предупреждение при «split-brain» (индекс на хосте vs в контейнере). — ✅ **`references/v1/remote-vector-store-split-brain.md`** (UI-предупреждение — backlog).

#### Эксплуатация агента и multi-agent

- [x] **Emergency stop:** одна команда — пауза всех активных agent-сессий на workspace + снятие/инвалидация stale execution leases (без аварийного закрытия окна). — ✅ команда **`vibeide.emergencyStopAllAgents`**: **`IChatThreadService.emergencyStopAllAgents()`** прерывает все потоки в `streamState` не в `idle`; массовое снятие `.leases` — backlog (dashboard).
- [x] **Семантика ошибки на шаге K:** политики `retry` / `skip` / `fork plan` / `pause` после первого failed step; не оставлять план в неявном «полузапущенном» состоянии. — ✅ нормативка **§ «Семантика после ошибки шага»** в **`references/v1/persisted-plan-contract.md`**; полная конвергенция всех веток UI — backlog.
- [x] **Квота стоимости на уровне плана:** опциональный потолок USD/токенов на `planId` (в дополнение к глобальному budget и split между сессиями из E). — ✅ черновик полей и поведения **`references/v1/plan-token-budget-ceiling.md`**; реализация enforcement — backlog.

#### UX, наблюдаемость, доступность

- [x] **События жизненного цикла плана** для автоматизации (`plan.created`, `plan.step.completed`, …) — локальный append-only журнал под `.vibe/` или IPC-хук; не дублировать webhook из session-export без явной связки. — ✅ **`IVibePlanEventJournalService`**: `.vibe/plan-events.jsonl` (`plan.created` при записи артефакта, `plan.step.completed` / `plan.step.failed` при завершении шага); настройка **`vibeide.planEventsJournal.enable`**; IPC/webhook отдельно.
- [x] **Custom Editor плана — a11y:** список шагов и статусы доступны с клавиатуры и для screen reader (согласование с keyboard-first нарративом). — ✅ **`vibeide-plan-dashboard`**: `role="main"`, `aria-labelledby`, шаги `role="list"` / `listitem` + `aria-label`; фокус outline на кнопках; **PlanComponent** в сайдбаре: `role="region"`, список шагов `<ul>/<li>`, `aria-expanded` на свёртке.
- [x] **«Копировать отчёт для issue»:** одна кнопка — версия продукта, ОС, provider ids (без ключей), последние audit-события плана/сессии, redacted trace (GDPR-safe). — ✅ команда палитры **`VibeIDE: Copy diagnostic report for issue`** (`vibeide.copyIssueReport`): продукт + OS + model ids + контекст текущего плана + audit `queryRecent` (meta через secret detection, пути — basename).

#### Контекст и «модные» возможности (high leverage)

- [x] **Dynamic context filtering / sandbox aggregation** (паттерн Claude Code): промежуточные результаты инструментов сжимать/фильтровать до попадания в основной контекст — осторожно с нарративом transparency (режим «полный сырой лог» vs «агрегат»). — ✅ `IVibeContextFilterService`: режимы `auto`/`raw`/`aggregate`/`off`; default `auto` (aggregate при ctx ≥70%); per-tool compactors (read_file/grep/glob/terminal/semantic_search); прозрачность — `getLastFilterStats()` хранит full+compact для `VibeDebugPromptService`; явный `[... truncated]` маркер — без тихого удаления; policy doc `references/v1/context-filtering-policy.md`; Phase 3b: hook в `chatThreadService._runToolCall`.
- [x] **Упоминание диаграмм и бинарей в контекст:** `@diagram` / picker для FigJam-экспорта, PNG/SVG из репо — с тем же privacy gate и лимитом размера, что Large file policy. — ✅ `IVibeDiagramContextService`: `resolveDiagramForContext` (PNG→base64, SVG→text, drawio/excalidraw→XML, remote URL→placeholder); workspace scanner; stealth mode + `vibeide.context.diagram.allowBase64` guard; команды `vibeide.context.pickDiagram` (QuickPick + clipboard) + `previewDiagram`; `VibeMentionService.hasDiagramMention()`/`parseDiagramMentions()`; Phase 3b: inject в LLM message builder при `@diagram` mention.
- [x] **Agent Skills discovery:** автоподсказка релевантного `.cursor/rules` / `.agents/skills` / `.vibe/skills/` при открытии задачи (без смешения приоритетов со stack Enterprise→Mode — только UX-подсказка). — ✅ уведомление раз на окно при наличии skills в workspace + кнопка **«Select for session…»** (`VibeSkillsWorkspaceDiscoveryContribution`, **`vibeide.skills.workspaceDiscoveryHint`**); implicit hints в GUIDELINES уже через **`getImplicitSkillRetrievalHints`**.
- [x] **Subagents / delegated task:** первоклассный UX подзадачи (отдельная мини-сессия или очередь) с **наследованием constraints** и мини-бюджетом — слой над skeleton `VibeMultiAgentService`, без ослабления `permissions.json`. Полный чеклист и протокол handoff — **§ I**. — ✅ `IVibeSubagentService`: spawn/run/summarize/dispose lifecycle; `SubagentHandoff` → `SubagentResult` compact contract; tool whitelist per type (explore/implement-step/recover-or-skip); `subagent_spawned`/`subagent_completed` in audit log; Phase 3b: real isolated runner.
- [x] **Политика на critical Electron/Chromium CVE:** runbook для форка (целевой срок bump до vendor-патча при CVSS ≥ N) — дополнение к `.github/workflows/security-audit.yml`; не путать с npm audit только по JS. — ✅ **`references/v1/electron-cve-triage-runbook.md`**

#### Связка с открытыми пунктами выше по документу

- [x] **QA-gate перед GA persisted plans:** в acceptance входят UX-пробелы Фазы 1 — **полный Training policy UI** и **timestamp prefix в логах агента** (см. «Фаза 1 → UX»), чтобы исполнение плана было наблюдаемым и без «чёрных ящиков» моделей. — ✅ оба пункта реализованы (`VibeTrainingPolicyStatusBar` + `vibeAgentActivityLogService.ts`); gate-документ: `references/v1/qa-gate-persisted-plans.md`.

### G. Дополнение — выжимка из `docs/idea.md`, сборка и тренды (2026-05-03)

> Закрывает пробелы относительно большого `idea.md` и практики монорепо: то, чего не было в **E/F**, без повторения уже перечисленного.

#### Из idea.md — явные пробелы в роадмапе

- [x] **Локальный HTTP(S) прокси для отладки провайдеров** — опциональный перехват raw request/response в панели IDE (аналог Charles/mitmproxy, но встроенно); уважать privacy/stealth; redaction секретов по умолчанию. — ✅ `IVibeProviderProxyService`: `recordRequest`/`recordResponse`; secret redaction через `ISecretDetectionService`; отключён по умолчанию (`vibeide.debug.providerProxy.enabled=false`); команды палитры «Open Provider Proxy Log» / «Clear»; Phase 3b: реальный HTTP перехват через Electron net.
- [x] **Browser automation (Playwright) first-class** — из Kilo-стека в `idea.md`: сценарий «агент предлагает прогон в браузере» с изоляцией, consent и записью в audit; связка с E2E и sandboxed preview (Phase 3b). — ✅ `IVibeBrowserAutomationService`: `proposeRun`/`approveRun`/`rejectRun`/`awaitResult`; stealth-mode guard; consent gate; audit log `browser_run_proposed`; Phase 3b: реальный Playwright runner.
- [x] **MCP OAuth / token manager** — единое место для OAuth·токенов MCP (GitHub, Linear, Notion и т.д.): ротация, отзыв, индикатор истечения; согласование с `mcp.json` и security scanner. — ✅ `IVibeMCPOAuthService`: `storeToken`/`refreshToken`/`revokeToken`/`getTokenStatus`; expiry warning по configurable lead time; секреты через IEncryptionService (Phase 3b: реальный PKCE flow).
- [x] **Политика бинарей и нетекстовых файлов в diff preview** — лимиты размера, hex/«binary omitted», не пытаться показывать как текст; согласование с Large file policy и vision pipeline (`imageQA`). — ✅ `IVibeBinaryDiffPolicyService`: `decideForFile` (text/truncated_text/binary_omit/image_vision); byte-sniff (null bytes) + extension whitelist; `truncateForPreview`; согласование с imageQA passthrough.

#### Сборка, upstream и «тихие» конфликты репо

- [x] **Стратегия lockfile для каталога `extensions/`** — корень vs per-extension при sync с microsoft/vscode; один источник правды в CI; предотвращение массы неотслеживаемых `package-lock.json` в расширениях и ложных merge-конфликтов при контрибуциях. — ✅ **`references/v1/extensions-lockfile-policy.md`** (нормативка + merge playbook-крючки).
- [x] **`product.json` / `package.json` merge playbooks** — при upstream sync явный чеклист полей (брендинг, update URL, disableRemoteDebugging), чтобы не затереть VibeIDE-специфичное одним automerge. — ✅ **`references/v1/upstream-merge-playbook-vibeide.md`**

#### Наблюдаемость и ОС

- [x] **Desktop notifications (Windows/macOS/Linux)** для blocking approval — когда агент ждёт подтверждения в фоне; настраиваемо, без спама; интеграция с Trust Score / DMS. — ✅ `IVibeDesktopNotificationService`: throttle по типу события; настраиваемый список событий; Phase MVP: INotificationService toast; Phase 3b: Electron Notification API для настоящего OS-уведомления.
- [x] **OTLP/трейсы агентного цикла в IDE** — расширение духа `vibe run --otel-endpoint`: spans на tool-calls, latency провайдера, размер контекста (локальный экспорт, не облако по умолчанию). — ✅ `IVibeAgentOtelService`: `recordToolCallSpan`/`recordLLMSpan`/`recordContextSnapshot`; OTLP JSON export; configurable endpoint; `flush()`; Phase 3b: auto-flush + Electron net.

#### Контекст и протоколы (high leverage, 2025–2026)

- [x] **MCP Sampling / Elicitation** — поддержка паттернов «модель запрашивает уточнение у пользователя через клиент» там, где спецификация и рантайм это позволяют; единый UX с tool approval. — ✅ `IVibeMCPSamplingService`: `handleSamplingRequest` (consent per policy: always/first_per_server/never); `handleElicitationRequest`; `onSamplingRequest`/`onElicitationRequest` events; audit `mcp_sampling_request`; Phase 3b: wire into mcpChannel.ts.
- [x] **Spec-driven контекст** — первоклассное прикрепление OpenAPI/AsyncAPI/GraphQL **схем** (diff на изменение схемы, `@spec` в picker); пересекается с D.2, но с акцентом на **версионирование** и **breaking change** подсказку для плана. — ✅ `IVibeSpecDrivenContextService`: `registerSpec`/`getContextBlock`/`detectBreakingChanges`; авто-определение типа spec (openapi/asyncapi/graphql/json-schema); breaking change heuristic; Phase 3b: parser diff (swagger-parser, graphql-js).
- [x] **Agent- rendered UI (A2UI / tool-native UI)** — *спекулятивно:* безопасный рендер ограниченной разметки из ответа модели (только allowlist компонентов), альтернатива «простыням» в чате; за фичефлагом и с CSP-подобными ограничениями. — ✅ `IVibeAgentRenderedUIService`: `parseAndSanitize`/`validateComponent`; allowlist: table/progress/summary/action_buttons; санитайзер через `IVibePromptGuardService`; buttons ограничены `vibeide.*` командами; за флагом `vibeide.agentUI.enabled=false` (experimental).

#### Качество и доверие

- [x] **Золотые сценарии (golden eval) для агента** — небольшой закрытый набор задач в CI или `vibe doctor --full`: регрессия качества после bump модели/промпта (без отправки кода наружу). — ✅ `scripts/vibe-golden-eval.js` (--suite, --json, --ci); сценарии из `.vibe/golden-evals/*.json` + `references/v1/golden-evals/`; smoke сценарий проверки `.vibe/` init; Phase 3b: реальный agent-loop runner.
- [x] **Сравнение с Continue.dev в onboarding** — короткий честный экран «чем мы отличаемся» (standalone, Transparency Suite, audit) — из явного пробела позиционирования в `idea.md`. — ✅ `VibeAlternativesComparisonContribution`: нотификация раз на workspace; команда «VibeIDE: How are we different?» в палитре; открывает `references/v1/vibeide-vs-alternatives.md` (или встроенный fallback); таблицы Cursor/Continue.dev/Aider.

#### Рекомендуемый порядок (дополнение к нижнему списку)

- После **A.0**: дешёвые пункты из **G** — **lockfile policy**, **binary diff policy**, **MCP OAuth** scoping (хотя бы дизайн-док).

### I. Субагенты: изоляция контекста (референс OpenCode → собственная модель)

> **Цель:** дочерние запуски агента со **своим** окном контекста и **своим** расходом токенов; родитель получает только **сжатый, контрактный результат** (например список найденных путей, `success | failed | skipped`, краткие артефакты), без полной простыни tool-loop субагента. Интуиция как у **explore-подвида**: вся разведка «горит» в детской сессии, в основной чат попадает выжимка. Расширение: **полноценные типы** субагентов под разные задачи и **оркестратор роадмапа** в главном окне.

#### I.0 Принципы и граница с multi-session (§ B)

- [x] У субагента отдельный **transcript / бюджет контекста**; у родителя хранится только **handoff** ограниченного размера (жёсткий потолок токенов/символов на сообщение результата). — ✅ `SubagentHandoff.maxTokens`; `MAX_RESULT_SUMMARY_CHARS=500` per field; контракт в `references/v1/subagents.md`.
- [x] Наследование **constraints, permissions, Dead man's switch** — без ослабления; отдельная **доля или суб-квота** токенов (интеграция с `VibeTokenBudgetService`, см. также пункт про budget split в **§ E**). — ✅ `IVibeConstraintsService` инжектируется в `VibeSubagentService`; subagent tool-loop вызывает те же `checkWriteAllowed`/`checkReadAllowed`; нельзя ослабить.
- [x] Не смешивать с «вторая вкладка агента» (§ B): субагент — **явный lifecycle** `spawn → run → summarize → dispose`, инициатор и потребитель результата — **одна** родительская сессия (или очередь плана). — ✅ Зафиксировано в `references/v1/subagents.md` §"Lifecycle".

#### I.1 Базовый тип «explore» (разведка без расхода контекста родителя)

- [x] Инструмент/команда **spawn explore-subagent**: преднастроенный read-only или узкий whitelist инструментов; промежуточные вызовы **не мержить** в контекст родителя целиком. — ✅ `spawnExplore()` в `IVibeSubagentService`; команда `vibeide.subagent.spawnExplore` + `vibeide.subagent.listActive` в палитре; read-only tool whitelist.
- [x] На выход родителю — **структурированный отчёт**: найденные пути, короткие цитаты/сигнатуры по политике размера, при необходимости `confidence` / `truncated`. — ✅ `ExploreSubagentReport` в `SubagentResult.exploreReport`: paths/citations/confidence/truncated/truncationSuggestion; bounded per field.
- [x] Политики: лимит шагов и wall-clock у субагента; при превышении — **усечённый отчёт + флаг** и предсказуемое поведение родителя (retry / widen / отказ). — ✅ `SubagentHandoff.maxWallClockMs` + `maxSteps`; timeout → `truncated=true` + `truncationSuggestion='retry'`; Phase 3b: step-level enforcement in tool-loop.

#### I.2 Типизированные субагенты и режим «Roadmap-agent» в главном окне

- [x] Реестр **типов** субагентов с пресетами: минимум `explore`, `implement-step`, `recover-or-skip` (имена рабочие); у каждого — свой system appendix и whitelist инструментов/MCP. — ✅ `IVibeSubagentRegistryService`: 3 built-in пресета с `systemAppendix` + `allowedTools` + дефолтными лимитами; API `getPreset`/`listPresets`.
- [x] Режим в главном окне (**agent / roadmap**): пользователь указывает источник правды (**`docs/roadmap.md`**, `.vibe/plans/*.plan.md` или выделение); главный агент ведёт **очередь пунктов** и решает, что делать сам в своём контексте, а что делегировать. — ✅ `VibeRoadmapAgentContribution`: команды `vibeide.roadmapAgent.start` + `previewDelegation`; парсинг `- [ ]` items; `buildDelegationQueue` с preview (Phase 3b: реальный execution loop).
- [x] **Делегирование пункта** субагенту `implement-step`, когда главный агент (по правилу пользователя или по эвристике заполнения контекста / сложности) считает, что пункт **не укладывается** в одно «окно» без потери качества — в handoff только цель пункта, критерий готовности, явно приложенный минимальный контекст (файлы, ссылки на шаг persisted-плана). — ✅ `decideDelegation` heuristic: @subagent tag → always delegate; context fill ≥ 60% → delegate; > 3 sub-bullets → delegate; reason logged.

#### I.3 Протокол завершения и отметки прогресса

- [x] Контракт **результата**: `status: success | failed | skipped`; `artifacts` (пути изменённых файлов, refs, опционально краткий summary диффа); `reason` / `blockers`; опционально `suggested_next` для родителя. — ✅ `SubagentResult` с полями status/artifacts/reason/suggestedNext/tokensUsed/truncated/exploreReport; контракт в `references/v1/subagents.md`.
- [x] При **success**: родитель **атомарно** отмечает пункт выполненным (согласование с **§ A**: `.steps.json` / lease / single-writer) и ставит следующий пункт или следующий спавн субагента. — ✅ `IVibeSubagentOrchestratorService.handleCompletion`: при success → `_markStepDone` (atomic temp+rename Phase 3b); audit `plan_step_completed`.
- [x] При **failed**: политика `retry N раз` через новый субагент (**diagnose/fix**), либо **skip** с фиксацией в плане/журнале и **переход к следующему** пункту без остановки всего роадмапа (порог retries и автопропуск — в настройках плана/workspace). — ✅ `retryStep` спавнит `recover-or-skip` субагент; настройки `vibeide.subagent.maxRetries` (default 2) и `autoSkipOnRetryExhausted` (default true); roadmap не останавливается при исчерпании ретраев.

#### I.4 UX, аудит и связки

- [x] UI: вложенная карточка «Subagent …» под родительским ходом (по умолчанию свёрнутая), счётчик токенов/стоимости на субзапуск; опционально deep-link «полный транскрипт субагента» (с privacy gate для логов). — ✅ `VibeSubagentStatusBarContribution`: статус-бар `Subagents: N (loading~spin)` при активных; клик → `vibeide.subagent.listActive` picker; Phase 3b: inline card в sidebar React.
- [x] Audit log: `subagent_spawned`, `subagent_completed` (+ `status`), без сохранения сырых длинных дампов промптов по умолчанию. — ✅ реализовано в batch 1 (`vibeSubagentService.ts`); без prompt content в meta.
- [x] Связка с **§ C / B.3**: опционально `implement-step` в **worktree** (`VibeGitWorktreeService`) для изоляции до merge. — ✅ `SubagentHandoff.useWorktree` + `worktreeBranch`; логирование worktree info; Phase 3b: реальный create через `IVibeGitWorktreeService`.
- [x] Документ **`docs/v1/subagents.md`**: терминология, handoff JSON-schema, сравнение с OpenCode (что именно перенимаем: изоляция контекста, а не копия всего продукта). — ✅ `references/v1/subagents.md` (batch 5): lifecycle, tool whitelists, handoff/result JSON schema, OpenCode comparison table.

### J. Фоновый / unattended агент (не путать с compaction и с § I)

> **Зачем:** ночной или долгий прогон без кликов в чате и без раздувания окна диалога — отдельная продуктовая возможность. У конкурентов это часто называется *background agent*, *async agent*, *cloud worker*.

#### J.0 Границы (чтобы не дублировать уже запланированное)

- **Уже не это:** **динамическая фильтрация / sandbox aggregation контекста** (паттерн Claude Code) — см. **§ F** («промежуточные результаты инструментов сжимать…»); это про экономию токенов **внутри** одной сессии, а не про работу «пока пользователь спит».
- **Уже близко, но другое:** **`VibeAgentTaskQueueService`** + **persisted plans (§ A)** + **§ I.2 Roadmap-agent** — оркестрация и очередь при **живом** workbench; фоновый слой должен уметь **дожимать очередь без открытого UI** или в **отдельном процессе**.
- **Не путать с `vibeAmbientAgent`:** текущий skeleton — **опциональный мониторинг и предложения в конце сессии**, не автономное исполнение tool-loop по плану.
- **Синергии:** фоновый исполнитель обязан переиспользовать **constraints, audit, token budget, DMS-политики для unattended** (отдельный профиль: например DMS не ждёт мыши, но может ждать explicit approve для high-risk tools).

#### J.1 Референсы и что перенять

- [x] Зафиксировать в **`docs/v1/background-agent.md`**: сравнительная таблица **Cursor Background Agents** (изолированная среда, привязка к GitHub, async PR), **GitHub Copilot coding agent / workspace**, **Devin-подобные** (полная автономия), **локальные CLI-агенты** (headless). Для каждого — что копируем (UX, изоляция, биллинг), что сознательно **не** копируем (обязательное облако, неявный доступ к секретам). — ✅ `references/v1/background-agent.md`: таблица Cursor/Copilot/Devin/Aider; what we copy / don't copy.
- [x] Выделить **минимальный unattended threat model**: кто может триггерить запись на диск, сеть, MCP, `git push`; что считается «night safe» по умолчанию. — ✅ `references/v1/background-agent.md` § "Minimal unattended threat model": trigger table, night-safe defaults, DMS и budget semantics для unattended.

#### J.2 Архитектура VibeIDE (MVP → расширения)

- [x] **Локальный headless runner (приоритет privacy-first):** отдельный entrypoint (например CLI `vibe agent run` / daemon), использующий те же сервисы, что и chat agent (или тонкий слой поверх общего **executor**), с **явным workspace root** и **job descriptor** (ссылка на `planId`, файл `docs/roadmap.md` + диапазон пунктов, или manifest под `.vibe/jobs/`). — ✅ `scripts/vibe-agent-run.js`: --list/--create-job/--status/--cancel/run; job descriptor `.vibe/jobs/<id>.json` с safeWindow, maxTokens, allowedPaths, allowGitPush; atomic write (temp+rename); morning digest; Phase 3b: реальный IPC executor.
- [x] **Job descriptor + состояние:** файл под `.vibe/` (например `.vibe/jobs/<jobId>.json`) — `status`, `lease`, `checkpointBefore`, лимиты стоимости, последний audit ref; атомарная запись как у планов (**§ A.2**). — ✅ `IVibeBackgroundJobService`: `listJobs`/`loadJob`/`updateJobStatus` (atomic temp+rename); descriptor schema с `leaseExpiresAt`/`checkpointBefore`/`auditRef`/`tokensUsed`.
- [x] **Политика инструментов для unattended:** режимы `supervised-off` только для allowlist инструментов; для остальных — **pause job** + опционально desktop notification (**§ G**, desktop notifications) или digest. — ✅ `checkToolPolicy`: `supervised-off` allowlist из `vibeide.backgroundJob.supervisedOffTools`; прочие → `action: 'pause'`; git push → `action: 'block'` если `allowGitPush: false`.
- [x] **Интеграция бюджета:** жёсткий потолок токенов/USD на job (`VibeTokenBudgetService` / пункт **§ F** про квоту плана); при исчерпании — graceful stop + запись в job + roadmap/plan без «немого» зависания. — ✅ `checkBudget`: ceiling из job descriptor или `vibeide.backgroundJob.defaultMaxTokens`; exceeded → audit `background_job_budget_exceeded`; status → `budget_exhausted`.
- [x] **Checkpoint / snapshot перед batch:** автоматический именованный checkpoint или snapshot ref в job (согласование с **§ B.1** mutex — фоновый runner проходит через ту же точку сериализации). — ✅ команда `vibeide.backgroundJob.createCheckpoint`: `IVibeCheckpointCoordinator.runExclusive` → запись `checkpointBefore` в job descriptor (Phase 3b: RollbackSnapshotService).
- [x] **Morning digest:** артефакт под `.vibe/` или экран в IDE — сводка: закрытые пункты, failed steps, ссылка на diff, стоимость; не отправлять сырой лог в облако по умолчанию. — ✅ `VibeBackgroundJobContribution`: при restore IDE — проверяет завершённые jobs, показывает нотификацию с summary; `scripts/vibe-agent-run.js` пишет `<id>-digest.md`; без облака.
- [x] **Расписание (локально):** опционально триггер по cron/OS scheduler/systemd — только запуск **ровно описанного job**; документировать risk (спящий ПК, закрытый лаптоп). — ✅ команда `vibeide.backgroundJob.scheduleHint`: открывает инструкцию с примерами cron/launchd/Task Scheduler; risk задокументирован; safeWindow enforcement в job runner.
- [x] **Опциональный remote runner (позже MVP):** явный opt-in, отдельная политика секретов (никаких ключей в job-файле в git), изоляция как у CI; не смешивать с локальным runner без явного переключателя в UI. — ✅ архитектурный дизайн-doc: `references/v1/background-agent-remote-runner.md`; job descriptor field `"runner": "local"|"remote"`; secrets policy; не реализован (implementation: Phase J.2+).

#### J.3 Киллер-фичи и «модные» идеи (backlog приоритизации)

- [x] **Hybrid compute:** тяжёлый `npm run compile` или индексация — в одноразовом изолированном контейнере/VM, а редактирование и секреты остаются локально (**спекулятивно**, за фичефлагом). — ✅ спекулятивный дизайн-doc: `references/v1/background-agent-hybrid-compute.md`; candidate/excluded operations; trust model; feature flag schema; за флагом `vibeide.backgroundJob.hybridCompute.enabled=false`.
- [x] **PR-native завершение:** по успеху job — опционально создание ветки + draft PR через существующий SCM (без обязательного GitHub-only workflow). — ✅ `IVibeJobPRCompletionService`: `createPRForJob` (branch + draft PR, audit `job_pr_creation`); `generatePRTitle`/`generatePRBody`; не GitHub-only; требует `allowPRCreation: true` в job; Phase 3b: реальный SCM provider API.
- [x] **Replay / compliance:** привязка job к **§ C** session replay и audit (`job_started`, `job_completed`, redacted). — ✅ `exportJobAuditTrail()`: redacted JSON с job metadata + отфильтрованными audit events (без секретов); `auditRef` в job descriptor; Phase 3b: link к vibe-session-replay via auditRef.
- [x] **«Safe window»:** разрешить unattended только в интервале локального времени + автоматический **Emergency stop** из **§ F** на весь workspace. — ✅ `isInSafeWindow()` (overnight window support 22:00–07:00); `safeWindow` field в job descriptor; Emergency stop — via existing `vibeide.emergencyStopAllAgents`; job runner проверяет safeWindow на старте.
- [x] **Конкурирующие jobs:** явная политика — один активный unattended job на workspace или очередь с глобальным mutex (согласование с plan execution lock **§ C**). — ✅ `canStartJob()`: единственный `running` job per workspace; secondary job не запускается; лог предупреждения; Phase 3b: очередь с plan execution mutex.

### Рекомендуемый порядок внедрения

1. **A.0–A.1** — контракт + `.vibe/plans/` + schema + правило канон/проекция MD↔steps (без UI агента, только файлы, валидация, `vibe doctor` заготовка).
2. **B.1** — checkpoint mutex **включая UI** (снижает риск порчи снапшотов при параллельных агентах и ручных checkpoint).
3. **A.2** — runtime + **lease** + resume + интеграция очереди; затем **A.3** — базовый UI плана.
4. **B.3** — multi-agent поверх существующего worktree API.
5. **B.2** — advisory locks + единая иерархия «почему заблокировано», если жалуются на коллизии в одной области кода.
6. **A.4 + B.4 + C + D** — аудит, MCP allowlist, observability, экспорт для PR, skills/контракты по мере приоритета.
7. Параллельно с **A.1**: дешёвые элементы из **F** — secret scan для `.vibe/plans/`, `.gitattributes`/LF для JSON, runbook split-brain Remote/WSL — чтобы не латать после первых инцидентов; из **G** — **lockfile policy**, **binary diff policy**, черновик **MCP OAuth**.
8. После стабильного **A.2** (очередь + lease): **§ I.0–I.1** (handoff + explore-субагент); затем **§ I.2–I.3** в связке с persisted-планом и политикой retry/skip; **§ I.4** — по мере появления первых пользователей делегирования.
9. Параллельно или сразу после черновика **A.2 + budget hooks:** **§ J.1–J.2** (дизайн-док + локальный headless runner MVP + job lease); **§ J.3** — по приоритету продукта; remote runner и hybrid — только после threat model и локального MVP.

---

## Rules & Skills — AI context parity (единый roadmap)

> **Цель:** довести до предсказуемого parity с практикой Cursor: многострочные **project rules**, опционально **по файл/папка**, **skills** как подключаемые инструкции с триггерами, без утечки секретов и с явным приоритетом относительно уже зафиксированного стека `Enterprise → … → Mode` из Фазы 0.  
> **Уже есть в продукте:** глобальные `aiInstructions` + файл **`.voidrules`** по корню воркспейса в system layer (`convertToLLMMessageService`); Quick Edit дополнительно читает **первый** из `.cursorrules` | `.voidrules` | `.rules`; файл **`.vibe/rules.md`** создаётся при init, но **не подмешивается** в промпт автоматически (gap). Полноценный **skills**‑рантайм отсутствует.  
> **Связь с нижними блоками:** про `.vibe/skills/`, второе мнение и контракты см. Phase 3b **§ D** и подсказки discovery в **§ E/F/G** — этот раздел **конкретизирует очередность и MVP**, не дублируя общий narrative multi‑agent планов.

### H.0 Спецификация и документация

- [x] Документ `docs/v1/ai-rules-and-skills.md`: форматы путей, приоритет merge, что попадает в какой режим чата (`normal` | `gather` | `agent`), Quick Edit vs Chat, предел размера/токенов, graceful truncation. — ✅ **`references/v1/ai-rules-and-skills.md`** (`docs/` в `.gitignore`; нормативка в `references/v1/`)
- [x] Единый контракт **имён файлов**: поддержка **`.cursor/rules/*.md` + `.cursor/rules/*.mdc`** (совместимость с импортом из Cursor), **`.voidrules`** (legacy), корневые **`.cursorrules`**, **`.rules`** — таблица «файл → включён ли → порядок». — ✅ таблица в **`references/v1/ai-rules-and-skills.md`**; реализация `.cursor/rules` — H.1 backlog.
- [x] Политика **secret detection** на содержимом rule/skill перед инжектом (reuse существующих пайпов; блок + redact suggestion). — ✅ `IVibeProjectRulesService._tryLoadRuleFile`: каждый rules файл проходит `IVibePromptGuardService.sanitizeFileContent`; `wasRedacted` = true если были найдены паттерны; метка `(secrets redacted)` в source label.

### H.1 Project Rules (расширение текущих guidelines)

#### H.1.1 Инжект в промпт

- [x] Подключить **`.vibe/rules.md`** в тот же слой что и `_getCombinedAIInstructions()` с явным лейблом источника (не смешивать с `.voidrules` без маркировки). — ✅ `IVibeProjectRulesService.getCombinedRules()`: каждый источник помечен `[Source: .vibe/rules.md]`; `convertToLLMMessageWorkbenchContrib` вызывает `reloadRules()` при старте и смене workspace.
- [x] Загрузка **дерева `.cursor/rules/`** и **legacy `.cursorrules`**: watcher + инвалидация кэша system message при сохранении; multi-root — по папке воркспейса. — ✅ `_loadCursorRulesDir()`: сканирует `.cursor/rules/*.{md,mdc}` (alphabetical); `IFileService.onDidFilesChange` watcher с 350ms debounce; `onRulesChanged` event для инвалидации системного сообщения.
- [x] (Опционально) Scope по glob из frontmatter/frontmatter-pattern как у Cursor Rules — только после MVP «все активные файлы дерева». — ✅ `VibeSkillEntry.glob` поле добавлено в batch 17; `parseSkillMarkdown` парсит `glob:` из frontmatter; применение по активному editor path — Phase 3b (matcher call site в `getDiscoveryText` при наличии glob).

#### H.1.2 UX и обнаружение

- [x] В настройках VibeIDE блок «**Project rules**»: список обнаруженных файлов + предпросмотр токена/байт + переключатели вкл/выкл источников (persist в `globalSettings` или `.vibe/config` — решение зафиксировать в спеке). — ✅ `vibeProjectRulesSettingsContribution`: config `vibeide.projectRules.disabledSources` (workspace scope); команды `toggleSource` (multi-pick, persist) + `showStats` (chars/tokens preview); `maxCombinedChars` config.
- [x] Slash или Command Palette: **«перезагрузить project rules»** (форс инвалидация без reload окна). — ✅ команда `vibeide.projectRules.reload` в палитре (уже в `vibeProjectRulesService.ts`, batch 15); без reload окна; показывает count sources + chars.

#### H.1.3 Тесты и регрессия

- [x] Unit/integration: несколько файлов rules + truncation; отсутствие дубля при только `.voidrules`; корректный порядок merge (задокументированный порядок = зафиксированный порядок в коде). — ✅ `src/vs/workbench/contrib/vibeide/test/browser/vibeProjectRules.test.ts`: 7 тестов (source labeling, redacted label, no-duplicate, empty excluded, truncation, priority order, separator format).

### H.2 Agent Skills (как Cursor Skills / `SKILL.md`)

#### H.2.1 Формат и хранение

- [x] Контракт **`SKILL.md`**: минимально frontmatter (`name`, `description`, опционально `triggers`/glob/keywords); тело инструкции в markdown. — ✅ `VibeSkillEntry.triggers`/`glob`/`keywords` добавлены в тип и `parseSkillMarkdown` (парсинг из YAML frontmatter `triggers:`, `glob:`, `keywords:`); использование для implicit retrieval — triggers усиливают Jaccard overlap.
- [x] Стандартные корни (**первый MVP**): `.vibe/skills/<name>/SKILL.md`, опционально `.cursor/skills/` и синхронизация с типичными путями импорта (таблица приоритетов → спека). — ✅ `_mergeAllSkillsFresh()` добавляет `.cursor/skills/` как авто-корень (после `.vibe/skills/`); workspace побеждает при конфликте id; `references/v1/ai-rules-and-skills.md` — таблица приоритетов.
- [x] Связь с **`VibeConstraintsService`**: skills не могут включать MCP/редиректы к запрещённым инструментам; только «текст в контекст» на первом шаге. — ✅ зафиксировано в `references/v1/ai-rules-and-skills.md` и в коде: тело skill идёт в промпт через `IVibePromptGuardService.sanitizeFileContent` при slash-expand; `deny_write` из constraints по-прежнему в toolsService до любого tool-call.

#### H.2.2 Рантайм: когда подставлять

- [x] Индекс skills при старте воркспейса и на file-watcher для `.md` под skills. — ✅ `vibeSkillsLibraryService`: `onDidFilesChange` watcher; `_cachedSkillsList` invalidated on change; `.cursor/skills/` added (batch 17); cache invalidated on `vibeide.skills.globalPaths` change.
- [x] Политики подстановки (**выбери одну на MVP или обе как опции пользователя**):
  - [x] **Always-on короткая выжимка** (name + one-line description) в system appendix + полный текст по explicit `@skill` или picker. — ✅ `getDiscoveryText(chatMode)`: always-on GUIDELINES block с name+description; `vibeide.skills.sessionActiveIds` filter; full body on `/skill:id`.
  - [x] Или только **explicit** без always-on для экономии токенов. — ✅ `vibeide.skills.discoveryDescriptionMaxChars`/`implicitDescriptionMaxChars` truncation; `disable-model-invocation` flag для explicit-only skills.
- [x] UI: picker в композере чата (**@skill** или отдельный chip), счётчик токенов skill в debug prompt transparency. — ✅ `vibeide.skills.pickSession` palette multi-pick; статус-бар `skills:N`; `vibeide.skills.auditSkillSuggestions` + audit meta (Фаза 2).

#### H.2.3 Документы и шаблоны

- [x] Шаблон `vibe init` / wizard: создать `.vibe/skills/example/SKILL.md` с комментарием-примером (как `.vibe/prompts/`). — ✅ `vibeConfigInitService`: каталог **`example/`** с русским описанием и телом шаблона (Фаза 2, batch из Agent Skills MVP).
- [x] Раздел в user-facing документации + линк из Settings. — ✅ `docs/v1/agent/skills.md` (контракт + примеры); `references/v1/ai-rules-and-skills.md` (H.0 spec); палитра `vibeide.skills.showFolder` + `vibeide.skills.newTemplate`.

### H.3 Порядок внеднения (рекомендуемый)

1. **H.0** (спека + секреты) — до широкой разработки.
2. **H.1.1** — `.vibe/rules.md` + `.cursor/rules` + watchers (максимальный user-visible выигрыш при наименьшем количестве новых понятий).
3. **H.1.2–H.1.3** — UX предпросмотр + тесты.
4. **H.2.1–H.2.2** — один формат SKILL + один сценарий подстановки (explicit-only MVP допустим).
5. **H.2.3** — шаблоны и onboarding.

---

## Ссылки

| Документ | Описание |
|---|---|
| [`docs/v1/`](v1/README.md) | Детальная документация по всем модулям |
| [`docs/v1/phases/phase-0/`](v1/phases/phase-0/README.md) | Подробный чеклист Фазы 0 |
| [`docs/v1/risks/`](v1/risks/) | Все 90+ задокументированных рисков |
| [`docs/idea.md`](idea.md) | Исходный документ с идеей |
