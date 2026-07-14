# Persisted plans, subagents, background agents

← [Knowledge Index](../README.md)

Записи про жизненный цикл планов, lease, subagents, background agents, agent skills, project rules.

---

## [vscode] Persisted plan dashboard — builtin `extensions/vibeide-plan-dashboard`

**Контекст:** roadmap §A.3 «Custom Editor» для `.vibe/plans/*.plan.md`; ранее ожидали регистрацию только из `vibeide.contribution.ts`.

**Суть:** Custom editor оформлен как **встроенное расширение** (как темы): **`extensions/vibeide-plan-dashboard`**, viewType **`vibeide.planDashboard`**, `priority: default`, selector **`**/.vibe/plans/**/*.plan.md`**. Шаблон нового плана (**`vibeide.plans.newInWorkspace`**) открывается через **`vscode.openWith`** → `vibeide.planDashboard`. Raw Markdown — команда **`vibeide.planDashboard.openAsText`** / кнопка в webview. Счётчик **Referenced by N agent session(s)** приходит из core-команды **`vibeide.plans.bindingSnapshot`** (**`IVibePlanBindingRegistry`** в **`chatThreadService`** при `executing`). Кнопка **Explain risk** вызывает **`vibeide.plans.explainRisk`** (эвристический скан текста плана без вывода секретов).

**Применение:** менять chrome/шаги/UI плана — править **`extension.js`**; при смене протокола привязок — **`vibePlanBindingRegistry.ts`** + **`vibeCommands.ts`** (`bindingSnapshot`).

---

## [архитектура] Persisted plan execution lease (`.vibe/plans/.leases/`)

**Контекст:** roadmap § A.2 execution lease и stale UX при resume.

**Суть:** при **`approvePlan`** на **`PlanMessage`** ставится **`persistedPlanId`**, JSON-lease **`planId.json`** лежит под **`.vibe/plans/.leases/`** (`IVibePersistedPlanService.touchExecutionLease`); цикл агента обновляет heartbeat; без heartbeat дольше **`PLAN_EXECUTION_LEASE_STALE_AFTER_MS`** (120s) lease считается stale; **`VibePersistedPlanResumeContribution`** для файла плана со статусом **`running`** показывает **Take over** / **Discard run** при stale и предупреждает про активный lease в другом window; **`rejectPlan`** и завершение плана очищают lease. Параллельно **`IVibePlanBindingRegistry`** фиксирует executor-thread'ы по **`planId`** (workspace folder[0]); второй **distinct** thread → warning notification. Изменение **`.vibe/plans/*.plan.md`** на диске при **`executing`** → **`VibePersistedPlanDiskEditContribution`** (debounced info). Зеркало шагов для **`IVibeTaskDecompositionService`** — **`startPersistedPlanTask`** / **`advancePersistedPlanStep`** из **`PlanMessage.steps`**.

**Применение:** отладка resume после crash; ручная проверка «держателя» исполнения; multi-session collision и mid-edit плана.

---

## [vscode] Plan lifecycle JSONL (`.vibe/plan-events.jsonl`)

**Контекст:** roadmap § F «События жизненного цикла плана» для автоматизации.

**Суть:** **`IVibePlanEventJournalService`** дописывает строки JSON в **`.vibe/plan-events.jsonl`** (append через read+concat+write): **`plan.created`** после успешной записи артефакта **`writeApprovedAgentPlan`**, **`plan.step.completed`** / **`plan.step.failed`** из **`chatThreadService._markStepCompletedInternal`** при наличии **`persistedPlanId`**. Флаг **`vibeide.planEventsJournal.enable`** (по умолчанию true). Это не замена **`vibeide.audit`** / **`audit.jsonl`**.

**Применение:** внешние скрипты и наблюдаемость без включения полного audit.

---

## [архитектура] Субагенты (§ I roadmap) — изоляция контекста и compact handoff

**Контекст:** ночной прогон 2026-05-04, roadmap § I полностью закрыт.

**Суть:** `IVibeSubagentService` реализует lifecycle `spawn → run → summarize → dispose`. Контракт:
- `SubagentHandoff` → `SubagentResult` (max 500 chars/field, `MAX_RESULT_SUMMARY_CHARS`)
- Промежуточные tool-calls **не** попадают в контекст родителя — только компактный `SubagentResult`
- `IVibeConstraintsService` инжектируется в subagent — наследование без ослабления
- `ExploreSubagentReport`: paths/citations/confidence/truncated/truncationSuggestion (для `explore` type)
- `SubagentHandoff.maxWallClockMs` + `maxSteps` → wall-clock timeout enforces `truncated=true`
- `SubagentHandoff.useWorktree=true` → implement-step в git worktree (Phase 3b: `IVibeGitWorktreeService`)
- `IVibeSubagentRegistryService`: 3 built-in пресета (explore/implement-step/recover-or-skip) с `systemAppendix` + tool whitelist
- `IVibeSubagentOrchestratorService`: retry policy (`maxRetries`, `recover-or-skip` spawn), `autoSkipOnRetryExhausted`, atomic `_markStepDone`
- Статус-бар `Subagents: N (spin)` при активных; клик → `vibeide.subagent.listActive`
- Roadmap-agent mode: `vibeide.roadmapAgent.start` + `decideDelegation` heuristic (контекст ≥60%, >3 sub-bullets, `@subagent` tag)

**Применение:** при реализации Phase 3b (реальный isolated runner) — добавить context window fork в chatThreadService executor; worktree create перед spawn implement-step.

---

## [архитектура] Background agent (§ J roadmap) — job descriptor и unattended runner

**Контекст:** ночной прогон 2026-05-04, roadmap § J полностью закрыт.

**Суть:**
- Job descriptor: `.vibe/jobs/<id>.json` — `status`/`lease`/`checkpointBefore`/`safeWindow`/`maxTokens`/`allowedPaths`/`allowGitPush`; атомарная запись temp+rename как у `.plan.md`
- CLI runner: `scripts/vibe-agent-run.js` (--list/--create-job/--status/--cancel/run); проверяет `safeWindow` на старте; morning digest в `<id>-digest.md`
- `IVibeBackgroundJobService`: `listJobs/loadJob/updateJobStatus/checkToolPolicy/checkBudget/touchLease/isInSafeWindow/canStartJob/exportJobAuditTrail`
- Tool policy: `vibeide.backgroundJob.supervisedOffTools` allowlist; остальные → `action: 'pause'`; git push → `block` если `allowGitPush: false`
- Budget: hard ceiling per job, exceeded → `status: budget_exhausted` + audit `background_job_budget_exceeded`
- Single-active-job policy: `canStartJob()` блокирует второй `running` job на workspace
- Safe window: `isInSafeWindow()` поддерживает overnight (22:00–07:00)
- Morning digest: `VibeBackgroundJobContribution` показывает notification при restore IDE для завершённых jobs
- Remote runner, hybrid compute: design docs в `references/v1/background-agent-remote-runner.md` / `background-agent-hybrid-compute.md`
- PR completion: `IVibeJobPRCompletionService` — не GitHub-only; только при `allowPRCreation: true`

**Применение:** Phase J.2 full impl — wire `vibe-agent-run.js` к реальному agent executor через IPC.

---

## [архитектура] Фоновый агент vs compaction (Claude) vs Roadmap-agent

**Контекст:** обсуждение «ночного» автономного прогона и путаницы с паттернами Claude/Cursor в роадмапе.

**Суть:** три разных слоя.
- **Compaction / sandbox aggregation** (§ F roadmap) — ужимание промежуточных tool-результатов **внутри** одной открытой сессии.
- **Roadmap-agent + очередь + persisted plans** (§ A, § I, `VibeAgentTaskQueueService`) — оркестрация задач при **работающем** IDE.
- **Фоновый / unattended агент** (§ J roadmap) — исполнение job без активного UI или в отдельном процессе (CLI/daemon), с lease/budget/checkpoint; не то же самое, что skeleton **`vibeAmbientAgent`** (пассивные подсказки в конце сессии).

**Применение:** проектирование headless runner, threat model и UX digest; не смешивать с контекст-компакшеном в промпте.

---

## [архитектура] Project rules loading (§ H.1 roadmap) — `VibeProjectRulesService` vs чат GUIDELINES

**Контекст:** ночной прогон 2026-05-04, roadmap § H.0 + H.1; позже упрощён список файлов правил и добавлен playbook.

**Суть:** **`IVibeProjectRulesService`** (**`vibeProjectRulesService.ts`**) загружает **только**: **`.vibe/rules.md`** и **`AGENTS.md`** (порядок в **`RULE_FILE_NAMES`**), асинхронно с диска, с **`sanitizeFileContent`**, префикс **`[Source: …]`**, watcher + debounce, команды **`vibeide.projectRules.*`**, исключения **`vibeide.projectRules.disabledSources`**. Поток **чата** отдельно: **`convertToLLMMessageService._getCombinedAIInstructions()`** подмешивает текст из **открытых текстовых моделей** того же содержимого (**`_getVibeRulesFileContents`**) плюс глобальные инструкции и **`VIBE_DOTVIBE_AGENT_PLAYBOOK`** — см. [vibeDotfolder/templateAndRules.md](../vibeDotfolder/templateAndRules.md). Импорт/слияние правил Cursor и прочих путей в чате описаны в playbook, не в расширяемой цепочке **`VibeProjectRulesService`** (нет автозагрузки **`.cursorrules`** / **`.cursor/rules`** в этом сервисе).

**Применение:** добавить тип rule file для UI-stats и санитизации — только **`RULE_FILE_NAMES`** и тест **`vibeProjectRules.test.ts`**; не смешивать с inject в LLM без проверки **`convertToLLMMessageService`**.

---

## [архитектура] Agent Stall Watchdog в chatThreadService

**Контекст:** агент молчал без уведомления пока пользователь не «подтолкнул» его вручную (2026-05-04).

**Суть:** `chatThreadService.ts` имеет двойной цикл (`while shouldSendAnotherMessage` / `while shouldRetryLLM`). Состояние `'idle'` — кратковременное переходное между LLM/tool вызовами, не индикатор зависания. Реальная проблема — нет UX-уведомления когда LLM долго не возвращает токены. Существующий `networkTimeout` (30s) писал только метрики. Добавлены две константы и два stall-таймера в LLM-секции:
- `FIRST_TOKEN_STALL_MS = 30_000` — нет первого токена → `_notificationService.notify(Warning)`
- `MID_STREAM_STALL_MS = 45_000` — нет нового токена во время стриминга → Warning
- Таймеры сбрасываются в `onText`, `onFinalMessage`, `onError`. Не прерывают сессию.
- `INotificationService` уже был инъецирован в конструктор (строка 410).

**Применение:** при отладке молчащего агента — проверить стало ли появляться уведомление через 30s; настроить пороги через константы в начале файла.

---

## [vscode] Agent Skills (.vibe/skills) и Output лог активности

**Контекст:** roadmap: `.vibe/skills/`, training UI, timestamp в логах агента.

**Суть:** **`IVibeSkillsLibraryService`** рекурсивно читает **`SKILL.md`** / **`SKILL.<locale>.md`** (primary по **`product.defaultLocale`**, см. **`_pickSkillPrimaryFile`**) / **`*.skill.md`**; YAML **`precheck`** — относительный путь внутри каталога навыка (без **`..`**): парсер + **`vibe-skills validate`**; исполнение hook — backlog; при наличии YAML нужны **`name`** и **`description`**; поддержаны расширенные поля frontmatter и **`disable-model-invocation`** (отдельный блок в discovery); **`depends`** — skill packs (DAG без циклов, проверка **`vibe skills validate`**); **`resolveDependencies()`** / **`orderedTransitiveDependencySkillIds`** задают порядок; **`/skill:id`** — **`vibeSlashCommandService`** (тело навыка + зависимости от **`---`** separator). **`vibeide.skills.globalPaths`** подмешивает глобальные корни; workspace перекрывает id. Кэш списка навыков сбрасывается при изменениях под **`.vibe/skills`**, этой настройке и смене workspace folders.

Локальный опциональный аудит подсказок: **`vibeide.skills.auditSkillSuggestions`** при включённом **`vibeide.audit.enable`** → **`skill_suggestion`** в **`auditLogService`**. Изменения skill на диске под **`.vibe/skills/**`**: **`vibeide.skills.notifyDiskDiff`** + **`vibeSkillDiskDiffContribution`** (снимок baseline, уведомление, кнопка **Open diff**).

**Community skills (MVP):** форматы каталога/манифеста (`references/v1/community-*.example.json`), палитра **`vibeide.skills.importCommunityUrl`** / **`vibeide.skills.browseCommunityCatalog`**, **`vibeide.skills.communityCatalogUrl`**, CLI **`scripts/vibe-skills-catalog.js`**; **`vibeide.skills.saveAsFromChat`** — последний assistant + redaction **`detectSecrets`**.

**Лимиты описаний в промпт:** **`vibeide.skills.discoveryDescriptionMaxChars`**, **`vibeide.skills.implicitDescriptionMaxChars`** (truncate в **`getDiscoveryText`** / **`getImplicitSkillRetrievalHints`**).

Жизненный цикл persisted-плана в audit (при **`vibeide.audit.enable`**): **`plan_started`**, **`plan_step_completed`**, **`plan_failed`**, **`plan_resumed`** из **`chatThreadService`** (meta без текстов ошибок шагов).

**Persisted Agent plans:** на **`approvePlan`** пишется **`agent-plan-*.plan.md`** в **`.vibe/plans/`** (**`IVibePersistedPlanService.writeApprovedAgentPlan`**); палитра **`vibeide.plans.newInWorkspace`**, **`vibeide.plans.showPlansFolder`**. При шаге плана **`status: 'paused'`** **`checkPlanGenerated`** в **`chatThreadService`** блокирует tool-loop до **Continue** / resume.

**`IVibeAgentActivityLogService`** регистрирует Output **«VibeIDE Agent Activity»**; **`chatThreadService._runToolCall`** пишет **Started / Finished / Error** с префиксом **`vibeAgentLogUtil`**. Поток shell для `run_command` не модифицируется. Политика обучения: **`getTrainingPolicyForSelection`** в registry + статусбар **`vibeTrainingPolicyStatusBar`** + бейдж **`ChatTrainingPolicyBadge`** у model picker. Блок в **GUIDELINES** для discovery — **`convertToLLMMessageService`** / **`getDiscoveryText()`**.

**Применение:** расширение skills, отладка catalog match для `trainingPolicy`.

---

## [архитектура] Agent Skills (§ H.2 roadmap) — новые поля + `.cursor/skills/`

**Контекст:** ночной прогон 2026-05-04, roadmap § H.2.1 закрыт.

**Суть:**
- `VibeSkillEntry` расширен полями `triggers`, `glob`, `keywords` (парсинг из YAML frontmatter)
- `triggers` — explicit keyword triggers для implicit retrieval (Jaccard enhancement)
- `glob` — optional glob pattern для scope по активному файлу (применение — Phase 3b)
- `keywords` — дополнительные слова для поиска помимо description
- `.cursor/skills/` добавлен в `_mergeAllSkillsFresh()` как авто-корень (после `.vibe/skills/`; workspace-wins при конфликте id)
- Таблица приоритетов корней: globalPaths < .cursor/skills/ < .vibe/skills/ (последний загружается, побеждает при дубле id)

**Применение:** при добавлении skill из cursor-проекта — положить в `.cursor/skills/<id>/SKILL.md`; VibeIDE подберёт автоматически.

---

## [vscode] IVibeCheckpointCoordinator и коммит `docs/` / `references/`

**Контекст:** ночной прогон — MCP allowlist на шагах плана + mutex для rollback-снапшотов / merge worktree.

**Суть:** **`IVibeCheckpointCoordinator`** (`vibeCheckpointCoordinatorService.ts`) — одна FIFO-цепочка **`Promise`** на окно; через неё идут **`RollbackSnapshotService`** create/restore/discard, **`VibeGitWorktreeService.mergeWorktree`**, **`VibeMultiAgentService.createCheckpoint`**. Void **`CheckpointEntry`** в **`chatThreadService`** пока вне coordinator — см. **`references/v1/checkpoint-coordinator.md`**. Плановые MCP поля **`mcpServersAllow`** / **`mcpToolsAllow`** — **`references/v1/plan-mcp-allowlist.md`**. В корневом **`.gitignore`** игнорируются **`docs/`** и **`references/`**; изменения в **`docs/roadmap.md`** и normative файлах под **`references/v1/`** коммитятся через **`git add -f <path>`**.

**Применение:** расширение mutex на UI checkpoints; правки дорожной карты из AI без «не добавился файл».

---

## [инструмент] Новые скрипты ночного прогона 2026-05-04

**Контекст:** ночной прогон, закрытие § G, § J, § I roadmap.

**Суть:** добавлены в `scripts/`:
- `vibe-golden-eval.js` — golden scenario runner (--suite/--json/--ci); сценарии из `.vibe/golden-evals/*.json` + `references/v1/golden-evals/`
- `vibe-agent-run.js` — headless unattended agent runner (--list/--create-job/--status/--cancel/run); job descriptor `.vibe/jobs/<id>.json`

**Применение:** golden eval — перед bump модели; agent-run — ночной job без открытого IDE.

---

## [архитектура] Phase 3b: headless-раннер ролей-субагентов (2026-07-06)

**Контекст:** до 3b `_runSubagent` был MVP-заглушкой (50мс setTimeout) — роли Vibe Agents «исполнялись» симуляцией, LLM не вызывался. Реализован настоящий изолированный tool-loop.

**Суть:**
- **Слои:** контракт `common/vibeSubagentRunner.ts` (`IVibeSubagentRunner`; в common, чтобы `vibeSubagentService` мог DI-ить без нарушения слоёв) → реализация `browser/vibeSubagentRunnerService.ts` → pure-решения в `common/subagentLoopPolicy.ts` (тестируемы). Реестр пресетов DI-ится в раннер, НЕ в сервис (у реестра value-импорт типа из сервиса — избегаем цикла).
- **Изоляция по I.0 = транскрипт + бюджет, НЕ процесс:** петля живёт в renderer на собственном in-memory `ChatMessage[]`; `vibeSubagentIsolationRuntime` (воркеры) для LLM-цикла осознанно не используется — петле нужны renderer-сервисы (LLM IPC, тулы, конвертер), тащить их в воркер = второй IPC-слой.
- **Инструменты — двойной гейт:** prompt-side через ChatMode (read-only роли → `gather`: approval-тулы отсутствуют в промпте by-design; full-роли → `agent`) + runtime-side whitelist роли на каждом вызове (запрещённый тул = корректирующий `invalid_params` в контекст, до 5 отказов). Approval-тулы full-ролей — явный `IDialogService.confirm` (раннер обходит approval-поток chatThreadService, поэтому гейтит сам; авто-одобрение — отдельная фича, секция J).
- **Завершение:** `vibe_complete` или проза без tool-call = success; лимиты (шаги/дедлайн/токен-оценка/отказы) = failed + truncated. `tokensUsed` — оценка chars/4 (провайдерский usage — будущее уточнение). Дедлайн прерывает и in-flight LLM-запрос через `llm.abort(requestId)`.
- **ГОЧА, вскрытая раннером:** whitelist-таблицы ролей несли несуществующие имена тулов (`list_dir`/`write_file`/`semantic_search`/`run_terminal_command`) — заглушка не проверяла; исправлены на реальные builtin-ids (`ls_dir`/`rewrite_file`+`create_file_or_folder`/`search_for_files`/`run_command`). Урок: имена в whitelist'ах сверять с `builtinToolDefs`.

**Применение:** «модель на роль» разблокирована — `SubagentRunRequest.modelSelection` готово, осталось `modelSelectionOfRole` в settings-state + UI. Следующие фазы: worktree для implement-step, inline-карточки прогресса, unattended-режим (J). Live-smoke: маршрут ролей на реальной задаче через «Показать маршрут ролей»/оркестратор.
