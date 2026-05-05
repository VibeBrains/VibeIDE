# FORK_CHANGES.md

> Документ всех отклонений VibeIDE от upstream VibeIDE и microsoft/vscode.  
> Обновлять при каждом PR. Упрощает upstream sync и переход на прямой форк при необходимости.

---

## Источник форка

| Remote | URL | Назначение |
|---|---|---|
| `origin` | `https://github.com/VibeIDETeam/VibeIDE` | VibeIDE репо |
| `cortexide` | `https://github.com/OpenCortexIDE/cortexide` | Исторический базовый форк (только для просмотра/порта кода, **не** для `git merge` в основную линию) |
| `upstream` | `https://github.com/microsoft/vscode` | VS Code upstream для sync |

---

## Аудит VibeIDE — Фаза 0 (результаты)

Проведён: 2026-05-02. Базовый коммит: `079043b`

### ✅ Хорошие новости

| Компонент | Файл | Статус |
|---|---|---|
| Телеметрия | `common/telemetry/telemetryStorage.ts` | ✅ Локальная. Комментарий: «privacy-first, never send to cloud unless user opts in» |
| Audit log | `common/auditLogService.ts` | ✅ Асинхронный. `RunOnceScheduler` с 100ms debounce. `_pendingWrites` queue. НЕ блокирует UI |
| Crash reporting | `product.json` | ✅ Не настроен. Поля `crashReporter` и Sentry DSN отсутствуют |
| Privacy gate | `common/offlinePrivacyGate.ts` | ✅ Существует. Проверяет `navigator.onLine` |
| API key encryption | `common/vibeideSettingsService.ts` | ✅ Использует `IEncryptionService` (VS Code platform) |
| MCP SDK | `electron-main/mcpChannel.ts` | ✅ Официальный `@modelcontextprotocol/sdk` |

### ⚠️ Требуют внимания в Фазе 1

| # | Компонент | Файл | Проблема | Действие |
|---|---|---|---|---|
| 1 | **Vector store** | `common/vectorStore.ts` + `common/vibeideSettingsTypes.ts` | Дефолт `none`, но Qdrant/Chroma — **внешние сервисы** по URL. В privacy-режиме может уходить код наружу при индексировании | Добавить встроенный sqlite-vec или LanceDB как дефолт. Qdrant/Chroma — опция |
| 2 | **Secret detection pipeline** | `browser/toolsService.ts:1127` | `secretDetectionService.detectSecrets()` вызывается на **результатах** tool calls, не перед сборкой контекста для LLM | Добавить вызов `secretDetectionService` перед отправкой контекста в `contextGatheringService` и перед MCP |
| 3 | **Rollback snapshots** | `common/rollbackSnapshotService.ts` | Хранится **в памяти** (`Map<string, Snapshot>`). Лимит 5MB на снапшот. Теряется при перезапуске IDE | Добавить persistence через `IFileService`. Рассмотреть git refs для тяжёлых снапшотов |
| 4 | **API key storage** | `common/vibeideSettingsService.ts` | Использует `IEncryptionService` + `StorageService`. `ISecretStorageService` закомментирован. Нужно проверить что `IEncryptionService` использует OS keychain (safeStorage), а не просто XOR | Проверить реализацию `IEncryptionService` в Electron контексте |
| 5 | **MCP allowlist** | `electron-main/mcpChannel.ts` | Нет allowlist доменов для MCP серверов. Любой MCP сервер может сделать произвольные network calls | Добавить allowlist и sandbox-модель для MCP серверов в Фазе 1 |
| 6 | **Privacy gate scope** | `common/offlinePrivacyGate.ts` | Gate проверяет только `navigator.onLine`. Privacy mode обрабатывается «на уровне model router». Embedding pipeline (RAG) не покрыт явно | Расширить gate на embedding pipeline. В privacy-режиме принудительно локальная embedding-модель |

### ✅ Дополнительные результаты (раунд 2)

| Компонент | Файл | Статус |
|---|---|---|
| **API key encryption** | `platform/encryption/electron-main/encryptionMainService.ts` | ✅ Использует Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux libsecret). Безопасно |
| **imageQA security** | `common/imageQA/securityGuardrails.ts` | ✅ `checkRemoteModelCall()` блокирует отправку изображений наружу при `allowRemoteModels: false`. Есть лимит 50MB |
| **Microsoft telemetry** | `product.json` | ✅ Поле `enableTelemetry` отсутствует → Microsoft телеметрия отключена в VibeIDE |
| **Debug ports (dev)** | `.vscode/launch.json` | ✅ Порты 9222 и 5875 только в dev launch configs. Не в production |

### ⚠️ npm audit — 53 уязвимости

| Severity | Кол-во |
|---|---|
| 🔴 Critical | 1 |
| 🟠 High | 27 |
| 🟡 Moderate | 22 |
| Low | 3 |

**Critical:** `next` — RCE в React flight protocol (CVSS 10.0, CVE GHSA-9qr9-h5gf-34mp)  
**High:** `@modelcontextprotocol/sdk`, `@vscode/sqlite3`, `axios`, `braces` и другие

> ⚠️ `next` как зависимость в IDE — неожиданно. Нужно выяснить откуда. Возможно из React-части VibeIDE UI (`browser/react/`).

### ⚠️ Autocomplete FIM pipeline — без secret detection

`autocompleteService.ts` собирает `prefixAndSuffix` из файла вокруг курсора и отправляет провайдеру без вызова `secretDetectionService`. Если файл содержит API-ключ — он попадёт в FIM-запрос.

**Действие (Фаза 1):** добавить вызов `secretDetectionService` в autocomplete pipeline перед отправкой.

### ⚠️ `next` — Critical CVE, неиспользуемая зависимость

`"next": "^15.3.1"` в корневом `package.json`. Нет `next.config.js`, нет импортов в коде. Случайная/заброшенная зависимость.

**CVE:** GHSA-9qr9-h5gf-34mp — RCE в React flight protocol, CVSS 10.0.

**Действие (Фаза 1):** `npm uninstall next` — удалить зависимость.

---

## Изменённые файлы VibeIDE (изменения поверх VibeIDE)

### `.gitignore`
- **Причина:** Добавлены строки для игнорирования локальных рабочих файлов VibeIDE
- **Добавлено:**
  ```
  # VibeIDE local workspace files
  docs/
  references/
  CLAUDE.md
  .cursor/
  builds/
  ```

### `product.json` — ребрендинг VibeIDE
- **Причина:** Полный ребрендинг с VibeIDE на VibeIDE
- **Изменено:**
  - `nameShort` / `nameLong`: `VibeIDE` → `VibeIDE`
  - `applicationName`: `cortexide` → `vibeide`
  - `dataFolderName`: `.cortexide` → `.vibeide`
  - `darwinBundleIdentifier`: `com.vibeide.code` → `io.vibeide.app`
  - `urlProtocol`: `cortexide` → `vibeide`
  - `extensionsGallery`: VS Code Marketplace → **Open VSX Registry**
  - `licenseUrl` / `reportIssueUrl`: обновлены на VibeIDETeam/VibeIDE
  - `linkProtectionTrustedDomains`: добавлены `vibeide.io` и `open-vsx.org`
  - `cortexVersion` → `vibeVersion: "0.1.0"`

### `package.json` — удалена Critical CVE зависимость
- **Причина:** `next@^15.3.1` в devDependencies — неиспользуемая зависимость с Critical RCE CVE (CVSS 10.0, GHSA-9qr9-h5gf-34mp)
- **Удалено:** `"next": "^15.3.1"` из `devDependencies`

### `FORK_CHANGES.md` (этот файл)
- **Причина:** Документирование изменений форка согласно best practices для VS Code форков

---

## Запланированные изменения (Фаза 1)

Когда будут реализованы — добавлять сюда:

- [ ] `product.json` — ребрендинг (имя, иконки, идентификаторы)
- [ ] Телеметрия — отключить/задокументировать оба слоя (Microsoft + VibeIDE)
- [ ] `product.json` — добавить `updateUrl` для GitHub Releases API (сейчас auto-update отключён)
- [ ] `common/vectorStore.ts` — добавить sqlite-vec / LanceDB как встроенный дефолт
- [ ] `common/secretDetectionService.ts` — добавить в pipeline перед сборкой контекста
- [ ] `common/rollbackSnapshotService.ts` — добавить persistence
- [x] `electron-main/mcpChannel.ts` — добавлена `_validateMCPServer()`: блокирует non-HTTPS remote URLs; предупреждает об опасных stdio командах; фундамент для Phase 2 configurable allowlist

---

## Инструкция по upstream sync

**Текущая база VS Code OSS:** версия **`1.118.1`**, апстрим-тег **`1.118.1`**, commit **`034f571df509819cc10b0c8129f66ef77a542f0e`** (`microsoft/vscode`).  
У форка с VibeIDE исторически **нет общего предка** с `microsoft/vscode` — использовался **`git merge <tag> --allow-unrelated-histories`** с последующим выравниванием `src/` под апстрим и оверлеем **`src/vs/workbench/contrib/vibeide/**`**, **`product.json`**, скриптов Vibe (`scripts/vibe-*`, workflows).  
При `git fetch upstream --tags` на машинах без полного Git LFS: **`GIT_LFS_SKIP_SMUDGE=1`**, если fetch падает на LFS объекте расширения Copilot.

```bash
# Получить изменения из VS Code upstream (единственный целевой merge)
git fetch upstream
git checkout -b upstream-sync
git merge upstream/main   # или merge на конкретный тег релиза
# Разрешить конфликты (сохранить product.json, contrib/vibeide/, точечные правки ядра из FORK_CHANGES)
git checkout main
git merge upstream-sync
```

**Политика:** не выполнять `git merge cortexide/main` в основную линию. Код из репозитория CortexIDE переносить **вручную** или скриптами сравнения, с коммитами `port: … (cortexide@sha, no merge)`.

Дополнительные корневые зависимости после синка на **1.118.1** (сохранять при следующих апдейтах или пересмотреть): **LLM SDK** для `electron-main` — `@anthropic-ai/sdk`, `ollama`, `openai`, `@mistralai/mistralai`, `@google/genai`, `google-auth-library`; **VibeIDE React** (`npm run buildreact`) — `tailwindcss@3`, `tsup`, `nodemon`, `@tailwindcss/typography`, `react`, `react-dom`, `lucide-react`, `marked`, `@floating-ui/react`, `react-tooltip`. В **`package.json` → `overrides`** зафиксирован **`postcss": "8.5.13"`** для совместимости Tailwind CLI и tsup.

**Windows (`@vscode/policy-watcher`):** если при запуске **`Could not locate the bindings file`** или сборка addon падает с **MSB8040** (нет Spectre‑mitigated CRT), в репозитории включён **`patch-package`**-патч `patches/@vscode+policy-watcher+1.3.7.patch` (убирает обязательный Spectre в `binding.gyp` для локальной dev‑сборки) и после `patch-package` — **`scripts/postinstall-rebuild-policy-watcher-win.mjs`** при отсутствии `build/Release/*.node`. Боевую/релизную сборку можно вести с установленными библиотеками Spectre ([MSB8040](https://aka.ms/Ofhn4c)).

### Пост-merge чистка (обязательно проверять)

`git checkout <tag> -- <dir>` **не удаляет** файлы, которых уже нет в апстриме — в дереве остаются **дубликаты и фантомы**, ломающие `tsc` (двойные `chatService`, лишние `vscode.proposed.*`, старый `inlineCompletions/browser/view/*`, дубли terminal initial hint под `terminalContrib/chat`, `workbench/services/accounts/common/defaultAccount.ts` вне OSS). Надёжно: **`rm -rf <dir> && git checkout <tag> -- <dir>`** для затронутых корней. Сборка **1.118.x**: в корне только **`gulpfile.mjs`** (не держать наследуемый **`gulpfile.js`**); в **`build/`** не оставлять рядом устаревшие **`.js`** от старого пайплайна, если рядом есть **`.ts`** и в **`build/package.json`** указано **`"type": "module"`**.

---

## Сводка изменений VibeIDE (Phase 0/1/2/3a, 41 коммит)

### Новые TypeScript сервисы (src/vs/workbench/contrib/vibeide/)

#### common/ (44 файла vibe*.ts)
- **vibeTokenBudgetService** — лимит 500k токенов/сессию, включён по умолчанию
- **vibeDeadMansSwitchService** — пауза агента при отсутствии Approve N минут
- **vibeLoopDetectorService** — автопауза при 3+ одинаковых действиях
- **vibeConstraintsService** — детерминированная блокировка по .vibe/constraints.json
- **vibePerFilePermissionsService** — .vibe/permissions.json allow/deny_write
- **vibePromptGuardService** — injection patterns + zero-width chars + Bidi overrides
- **vibePrivacyStripperService** — strip workspace paths/usernames из промптов
- **vibeContextGuardService** — live-индикатор заполнения context window
- **vibeModelsRegistryService** — CDN models.json + ETag caching + offline fallback
- **vibeTokenCostForecastService** — cost forecast: worst case / с кэшем
- **vibeModelFingerprintService** — audit модели, temperature, seed per request
- **vibeDebugPromptService** — exact system prompt + context diff
- **vibePromptVersioningService** — diff системного промпта между версиями IDE
- **vibeAgentHistoryService** — хронология действий агента per session
- **vibeCostAttributionService** — стоимость per file в сессии
- **vibeMCPInspectorService** — visual debugger MCP requests
- **vibeSemanticSearchService** — natural language search через vectorStore
- **vibeDependencyVulnService** — scan при изменении package.json/requirements.txt
- **vibeMemoryDecayService** — Project Brain: .vibe/context.md auto-update
- **vibePersonaService** — .vibe/persona.json verbosity/formality
- **vibePromptLibraryService** — .vibe/prompts/*.md с $VARIABLE substitution
- **vibeWorkflowService** — .vibe/workflows/*.json structured steps
- **vibeContextEvictionService** — evict/autoCompress context items
- **vibeDependencyGraphService** — why this file is in context
- **vibeRefactorAuditService** — N-file rename = 1 audit entry
- **vibeAIDiffSummarizerService** — git stats + LLM summary
- **vibeProfilesService** — .vibe/profiles/ named settings presets
- **vibeAgentTaskQueueService** — queue N tasks for sequential execution
- **vibeToolApprovalService** — Explicit tool approval mode per Trust Score
- **vibePreFlightService** — agent pre-flight plan + drift detection
- **vibeGitBlameService** — git blame с isAgentWritten() detection
- **vibeStructuredOutputService** — NDJSON to stdout opt-in (SIEM/Splunk)
- **vibeAuditEncryptionService** — opt-in шифрование + recovery phrase
- **vibeDiffPreviewService** — confidence 🟢🟡🔴 + complexity indicator
- **vibeUnifiedConfigService** — агрегация всех .vibe/ настроек
- **vibePromptDiffService** — diff системного промпта при обновлении IDE
- **vibeMergeConflictService** — AI parse conflict markers
- **vibeScreenshotCodeService** — privacy warning для vision pipeline
- **vibeSlashCommandService** — /fix /tests /explain /my:name /workflow:name
- **vibeMentionService** — @file/@symbol mentions parsing
- **vibeProviderStatusService** — real-time health status провайдеров
- **vibeWebContextService** — @web context via DuckDuckGo
- **vibePartialRollbackService** — partial rollback с audit trail
- **vibeInlineDiffService** — chunk-level accept/reject

#### browser/ (9 файлов vibe*.ts)
- **vibeConfigInitService** — создаёт .vibe/ при открытии workspace
- **vibeStartupHealthCheck** — валидация .vibe/ схем при старте
- **vibeTerminalOutputService** — terminal output awareness opt-in
- **vibeGutterIndicatorService** — agent-written lines tracking
- **vibeContextGuardService** — live context monitoring
- **vibeDeadMansSwitchService** — DMS service
- **vibeLoopDetectorService** — Loop detector service
- **vibeKeyboardShortcutsService** — 15 keyboard shortcuts + conflict check
- **vibeCommands** — command palette entries для всех VibeIDE actions

### CLI инструменты (scripts/vibe-*.js, 22 файла)
vibe-doctor, vibe-checkpoint-prune, vibe-commit, vibe-init-from, vibe-gitignore-wizard,
vibe-explain, vibe-changelog, vibe-review, vibe-audit, vibe-bisect, vibe-snapshot,
vibe-session-export, vibe-session-replay, vibe-diff-split, vibe-init-for-new-member,
vibe-otel-export, vibe-run, vibe-workspace-template, vibe-schema-templates,
vibe-benchmark, vibe-migration-guide, vibe-transparency-dashboard

### GitHub Actions Workflows
- upstream-lag-check.yml — алерт при отставании > 14 дней
- security-audit.yml — npm audit + Electron CVE мониторинг
- sbom.yml — SBOM с AI models + bundled extensions при каждом релизе
