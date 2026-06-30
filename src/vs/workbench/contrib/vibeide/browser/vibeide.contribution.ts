/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/



// register inline diffs
import './editCodeService.js';

// register Sidebar pane, state, actions (keybinds, menus) (Ctrl+L)
import './sidebarActions.js';
import './sidebarPane.js';

// register quick edit (Ctrl+K)
import './quickEditActions.js';

// register Quick Actions
import './quickActions.js';


// register Autocomplete
import './autocompleteService.js';

// register Context services
// import './contextGatheringService.js'
// import './contextUserChangesService.js'

// settings pane
import './vibeideSettingsPane.js';

// register css
import './media/vibeide.css';
// Z.12 BISECT — temporarily disable VibeModal CSS to confirm/deny it as the freeze source
import './media/vibeModal.css';

// Builtin Vibe Neon — title-bar glow toggle registration + default theme chrome CSS (extensions/vibeide-neon)
import './vibeNeonGlowTitleBar.js';
import './vibeNeonThemeContribution.js';

// Native workspace bookmarks (Vibe Projects)
import './vibeProjects.contribution.js';

// Local preview server with live reload (Vibe Server)
import './vibeServer/vibeServer.contribution.js';

// Deploy to cloud via the vibe-deploy skill (Vibe Deploy)
import './vibeDeploy.contribution.js';

// Curated agent role routing (Vibe Agents)
import './vibeAgents.contribution.js';

// update (frontend part, also see platform/)
import './vibeideUpdateActions.js';

import './convertToLLMMessageWorkbenchContrib.js';

// tools
import './vibeAgentTerritorialLockService.js';
import './toolsService.js';
import './terminalToolService.js';

// register Thread History
import '../common/vibePlanEventJournalService.js';
import '../common/vibePersistedPlanService.js';
import './vibePlanBindingRegistry.js';
import './chatThreadService.js';

// ping - lazy load after startup
import('./metricsPollService.js').catch(() => { });

// helper services
import './helperServices/consistentItemService.js';

// register selection helper
import './vibeideSelectionHelperWidget.js';

// register tooltip service
import './tooltipService.js';

// register onboarding service - lazy load (only needed on first run)
import('./vibeideOnboardingService.js').catch(() => { });

// register misc service
import './miscWokrbenchContrib.js';

// remove built-in chat surfaces we don't use (1.118+ compatible via data-action-id selectors)
import './hideBuiltinChat.js';

// register IAgentSessionsService without the 70+ chat actions (avoids "UNKNOWN service agentSessions" errors)
import './agentSessionsRegistration.js';

// register file service (for explorer context menu)
import './fileService.js';

// i18n: VibeIDE NLS bundle loader + dev-only live-reload (roadmap §L491/L513)
import './vibeNlsBundleService.js';
import './vibeNlsLiveReload.js';

// register source control management
import './vibeideSCMService.js';

// ---------- common (unclear if these actually need to be imported, because they're already imported wherever they're used) ----------

// llmMessage
import '../common/sendLLMMessageService.js';

// vibeideSettings
import '../common/vibeideSettingsService.js';

// secret detection
import '../common/secretDetectionService.js';

// memories
import '../common/memoriesService.js';
import './memoriesTrackingContribution.js';

// models.dev catalog status (toast on startup if catalog couldn't load from network)
import '../common/modelsDevCatalogStatusService.js';
import './modelsDevCatalogStatusContribution.js';

// model-quirks catalog status (toast once on startup if exe-adjacent override is stale)
import '../common/modelQuirksCatalogStatusService.js';
import './modelQuirksCatalogStatusContribution.js';
// VibeIDE: status-bar indicator for the active model-quirks catalog source (1678)
import './vibeModelQuirksSourceStatusBar.js';

// edit risk scoring
import '../common/editRiskScoringService.js';

// code review
import '../common/codeReviewService.js';
import './codeReviewEditorContribution.js';
import './codeReviewCommands.js';

// notification sounds on agent stop / completion / awaiting-user
import './vibeNotifySoundService.js';
import './vibeNotifySoundCommands.js';
import '../common/vibeNotifySoundsModalService.js';
import './vibeNotifySoundsContribution.js';

// codebase query - lazy load (only needed when user invokes codebase query command)
import('./codebaseQueryCommands.js').catch(() => { });

// NL shell parser - lazy load (only needed when NL shell parsing is used)
import('../common/nlShellParserService.js').catch(() => { });

// error detection
import '../common/errorDetectionService.js';
import './errorDetectionEditorContribution.js';
import './errorDetectionCommands.js';

// performance guardrails
import '../common/performanceGuardrailsService.js';

// AI provenance — decorates @ai-generated blocks (roadmap §L1179)
import '../common/vibeAiProvenanceConfiguration.js';
import './vibeAiProvenanceEditorContribution.js';

// status bar contribution
import './vibeideStatusBar.js';

// dead man's switch — agent idle notification
import './vibeDeadMansSwitchNotification.js';

// first-run validation - lazy load (only needed on first run)
import('./firstRunValidation.js').catch(() => { });
import('../common/secretDetectionConfiguration.js').catch(() => { });

// «Что нового» — changelog modal on first launch after an update
import('./vibeWhatsNewContribution.js').catch(() => { });

// refreshModel
import '../common/refreshModelService.js';

// metrics
import '../common/metricsService.js';

// updates
import '../common/vibeideUpdateService.js';

// model service
import '../common/vibeideModelService.js';

// model warm-up service
import '../common/modelWarmupService.js';

// ollama installer service (main-process proxy) - eager import to register singleton before VibeOllamaOnboardingContribution
import '../common/ollamaInstallerService.js';

// outbound ring buffer (privacy panel + vibe doctor --network) — registers singleton
import '../common/vibeOutboundRingBuffer.js';

// repo indexer
import './repoIndexerService.js';
// repo indexer actions - lazy load (only needed when user invokes indexer actions)
import('./repoIndexerActions.js').catch(() => { });

// Image QA Registry initialization
import './imageQARegistryContribution.js';

// VibeIDE: .vibe/ directory initialization
import './vibeConfigInitService.js';

// VibeIDE: Token budget service
import '../common/vibeTokenBudgetService.js';

// VibeIDE: Dead man's switch service
import './vibeDeadMansSwitchService.js';

// VibeIDE: Loop detector service
import './vibeLoopDetectorService.js';

// VibeIDE: Constraints service
import '../common/vibeConstraintsService.js';

// VibeIDE: Shell-hardening config service (.vibe/shell-hardening.json overrides)
import './shellHardeningService.js';

// VibeIDE: Prompt guard service (injection + context poisoning detection)
import '../common/vibePromptGuardService.js';

// VibeIDE: Privacy fingerprint stripper
import '../common/vibePrivacyStripperService.js';

// VibeIDE: Models registry (CDN-based with ETag caching)
import '../common/vibeModelsRegistryService.js';

// VibeIDE: Startup health check (.vibe/ schema validation)
import './vibeStartupHealthCheck.js';

// VibeIDE: Context guard service (context window limit monitoring)
import './vibeContextGuardService.js';

// VibeIDE: Token cost forecast service
import '../common/vibeTokenCostForecastService.js';

// VibeIDE: Model fingerprint service (Debug my prompt, Reproducible sessions)
import '../common/vibeModelFingerprintService.js';

// VibeIDE: Semantic codebase search
import '../common/vibeSemanticSearchService.js';

// VibeIDE: Similarity search across `.vibe/plans/*.plan.md` (local embeddings)
import '../common/vibePlanSimilarSearchService.js';

// VibeIDE: Terminal output awareness (opt-in)
import './vibeTerminalOutputService.js';

// VibeIDE: Gutter indicators (agent-written lines)
import './vibeGutterIndicatorService.js';

// VibeIDE: AI debugging context adapter (roadmap §L881)
import './vibeAIDebuggingContribution.js';

// VibeIDE: Dependency vulnerability scanner
import '../common/vibeDependencyVulnService.js';

// VibeIDE: Per-file permissions service (.vibe/permissions.json)
import '../common/vibePerFilePermissionsService.js';

// VibeIDE: Debug my prompt service (Debug my prompt, Context diff, Prompt versioning)
import '../common/vibeDebugPromptService.js';

// VibeIDE: Structured output mode (SIEM/Splunk integration)
import '../common/vibeStructuredOutputService.js';

// VibeIDE: Memory decay / Project Brain (.vibe/context.md)
import '../common/vibeMemoryDecayService.js';

// VibeIDE: Agent persona (.vibe/persona.json)
import '../common/vibePersonaService.js';
import './vibePersonasPaletteContribution.js';

// VibeIDE: Prompt library service (.vibe/prompts/)
import '../common/vibePromptLibraryService.js';

// VibeIDE: Tool approval service (Explicit tool approval mode)
import '../common/vibeToolApprovalService.js';

// VibeIDE: Pre-flight plan service (Agent pre-flight plan)
import '../common/vibePreFlightService.js';

// VibeIDE: Git blame in agent context
import '../common/vibeGitBlameService.js';

// VibeIDE: MCP Inspector (visual debugger for MCP requests)
import '../common/vibeMCPInspectorService.js';

// VibeIDE: Cost attribution per file
import '../common/vibeCostAttributionService.js';

// VibeIDE: Prompt versioning service
import '../common/vibePromptVersioningService.js';

// VibeIDE: Agent action history service (Agent Action History Sidebar)
import '../common/vibeAgentHistoryService.js';

// VibeIDE: Provider capability probe service
import '../common/vibeProviderCapabilityService.js';

// VibeIDE: Agent thinking out loud mode (extended thinking)
import '../common/vibeThinkingOutLoudService.js';

// VibeIDE: Run tests after apply hook
import './vibeRunTestsAfterApplyService.js';

// VibeIDE: Profiles service (.vibe/profiles/)
import '../common/vibeProfilesService.js';

// VibeIDE: Agent task queue
import '../common/vibeAgentTaskQueueService.js';

// VibeIDE: Workflow service (.vibe/workflows/)
import '../common/vibeWorkflowService.js';
import './vibeWorkflowChatDispatchContribution.js';

// VibeIDE: Agent Skills library (.vibe/skills/**/SKILL.md)
import '../common/vibeSkillsLibraryService.js';

// VibeIDE: Skill file disk change → notification + optional diff (previous snapshot ↔ disk)
import './vibeSkillDiskDiffContribution.js';
import './vibeSkillsWorkspaceDiscoveryContribution.js';

// VibeIDE: Agent activity log (Output — VibeIDE Agent Activity)
import './vibeAgentActivityLogService.js';

// VibeIDE: Training policy indicator (status bar + model catalog)
import './vibeTrainingPolicyStatusBar.js';

// VibeIDE: Session skill filter (status bar + palette)
import './vibeSkillsSessionStatusBar.js';

// VibeIDE: Chat mode switcher (status bar + cycle command)
import './vibeChatModeStatusBar.js';

// VibeIDE: One-shot cortexide.* → vibeide.* settings migration
import './vibeSettingsMigrationContribution.js';

// VibeIDE: Agent response language setting + helper
import '../common/vibeAgentResponseLanguageConfiguration.js';

// VibeIDE: Agent behaviour knobs (preferJsonToolArguments / terminalOutputAwareness / thinkingOutLoud)
import '../common/vibeAgentBehaviorConfiguration.js';

// VibeIDE: Diagnostic logging settings (vibeide.logging.*) + singleton bridge + palette commands + Output channel
import '../common/vibeLoggingConfiguration.js';
import './vibeLogConfigContribution.js';
import './vibeLogCommands.js';
import './vibeLogOutputChannel.js';

// VibeIDE: Project Commands audit privacy flags (vibeide.commands.audit{,Stdout})
import '../common/commandsAuditPrivacyConfiguration.js';

// VibeIDE: Config Guard settings (vibeide.configGuard.*) — static scan of .vibe/providers.json & mcp.json
import '../common/vibeConfigGuardConfiguration.js';

// VibeIDE: Persisted plan resume (scan .vibe/plans/ on startup, offer to continue interrupted plans)
import './vibePersistedPlanResumeContribution.js';
import './vibePersistedPlanDiskEditContribution.js';

// VibeIDE: Context eviction control
import '../common/vibeContextEvictionService.js';

// VibeIDE: Dependency graph visualization
import '../common/vibeDependencyGraphService.js';

// VibeIDE: Rename/refactor atomic audit
import '../common/vibeRefactorAuditService.js';

// VibeIDE: AI diff summarizer
import '../common/vibeAIDiffSummarizerService.js';

// VibeIDE: Prompt diff on IDE update
import '../common/vibePromptDiffService.js';

// VibeIDE: AI merge conflict resolution
import '../common/vibeMergeConflictService.js';

// VibeIDE: Screenshot → code workflow (privacy warnings)
import '../common/vibeScreenshotCodeService.js';

// VibeIDE: Audit log encryption migration service
import '../common/vibeAuditEncryptionService.js';

// VibeIDE: Diff preview service (confidence score, complexity indicator)
import '../common/vibeDiffPreviewService.js';

// VibeIDE: Unified .vibe/ Config Panel service
import '../common/vibeUnifiedConfigService.js';

// VibeIDE: Keyboard shortcuts registry
import './vibeKeyboardShortcutsService.js';

// VibeIDE: Commands registry (Command Palette entries)
import './vibeCommands.js';

// VibeIDE: Chat group color tokens (registerColor — must load before first theme application)
import './vibeideChatGroupColors.js';

// VibeIDE: Chat editor pane (split tab) + vibeide.chat.open command
import './vibeideChatPane.js';

// VibeIDE: CommandCenter sparkle menu (replaces native Copilot button; adds New Chat / History / Settings / etc.)
import './vibeideCommandCenterMenu.js';

// VibeIDE: Inline diff review service
import '../common/vibeInlineDiffService.js';

// VibeIDE: Slash commands service (/fix, /tests, /my:name, /workflow:name)
import '../common/vibeSlashCommandService.js';

// VibeIDE: @file/@symbol mention service
import '../common/vibeMentionService.js';

// VibeIDE: Provider status widget service
import '../common/vibeProviderStatusService.js';

// VibeIDE: @web/@docs context service (DuckDuckGo search)
import '../common/vibeWebContextService.js';

// VibeIDE: Project Commands runtime (.vibe/commands.json + palette + ITerminalService spawn)
import './vibeCustomCommandsService.js';
import './vibeCustomCommandsContribution.js';
import './vibeCustomCommandsStatusBar.js';
import './vibeCustomCommandsOnboarding.js';
import './vibeProjectCommandsTopBarContribution.js';
import './vibeProjectCommandsMenubarContribution.js';
import './vibeProjectCommandsPopupContribution.js';
import './vibeProjectCommandFormModalContribution.js';
import './vibeAiThinkingStatusBar.js';

// VibeIDE: Plan-lease periodic janitor (.vibe/plans/.leases TTL cleanup)
import './vibePlanLeaseJanitorContribution.js';

// VibeIDE: Multi-window coordinator — .vibe/.window-lock.json ownership + heartbeat (L1032)
import './vibeMultiWindowCoordinatorContribution.js';

// VibeIDE: Idle Watchdog — renderer-side memory sampler + IPC proxy (roadmap W.1)
import '../common/vibeIdleWatchdogProxy.js';
import './vibeIdleWatchdogRendererContribution.js';

// VibeIDE: Idle Watchdog — pre-flight previous-crash notification (roadmap W.14)
import './vibeIdleWatchdogPreFlightContribution.js';

// VibeIDE: Idle Watchdog — bundle crash report Action2 (roadmap W.11)
import './vibeIdleWatchdogBundleAction.js';

// VibeIDE: Idle Watchdog — status bar widget (roadmap W.6/W.29)
import './vibeIdleWatchdogStatusBar.js';

// VibeIDE: Idle Watchdog — Timeline viewer Action2 (roadmap W.7/W.28)
import './vibeIdleWatchdogTimelineCommand.js';

// VibeIDE: Idle Watchdog — AI diagnosis Action2 (roadmap W.36)
import './vibeIdleWatchdogAiDiagnosisAction.js';
import './vibeStallDiagnosticsAction.js';

// VibeIDE: VibeModal — workbench-level themed modal framework
import './vibeModalServiceImpl.js';
import './vibeModalRootContribution.js';
import './modelsDevCatalogRecheckAction.js';

// VibeIDE: Extension host crash UX — EH disconnect → pause/resume/discard notification (L1033)
import './vibeEHCrashRecoveryContribution.js';

// VibeIDE: Unified status-bar service + contribution (L896)
import '../common/vibeUnifiedStatusBarService.js';
import './vibeUnifiedStatusBarContribution.js';

// VibeIDE: Memory snapshot Action2 (dev-only)
import './vibeMemorySnapshotAction.js';

// VibeIDE: Dismiss pending plan in current chat (escape hatch for stuck plan-gate)
import './vibeDismissPlanAction.js';
import './vibeForceResetChatStateAction.js';
import './vibeChatHistoryActions.js';
import './vibeChatPinAction.js';
import './vibeExternalAccessActions.js';
import './vibeRepairWarningContribution.js';

// VibeIDE: Memory dispatcher — routes writes via memoryLayerRouter pure helper
import './vibeMemoryDispatcherService.js';

// VibeIDE: Performance Guardrails JSONL persistence (recordTrip)
import './vibePerfGuardrailsService.js';

// VibeIDE: @search context service (workspace literal grep, no LLM)
import '../common/vibeSearchContextService.js';

// VibeIDE: Session memory per chat thread (DI wrapper over sessionMemoryPerThread.ts)
import '../common/vibeSessionMemoryService.js';

// VibeIDE: @diagram mention + picker + LLM context injection (§ F roadmap @diagram)
import './vibeDiagramContextContribution.js';

// VibeIDE: Dynamic context filtering — compaction of tool results (§ F / § G roadmap)
import '../common/vibeContextFilterService.js';
import './vibeContextFilterCommands.js';
import './vibeContextFilterToastContribution.js';

// VibeIDE: Checkpoint coordinator — register before rollback/worktree consumers
import '../common/vibeCheckpointCoordinatorService.js';

// VibeIDE: Partial rollback service
import '../common/vibePartialRollbackService.js';

// VibeIDE: Trust Score status bar widget
import './vibeTrustScoreStatusBar.js';

// VibeIDE: First-run security wizard
import './vibeFirstRunWizard.js';

// VibeIDE: Provider status statusbar widget + token cost
import './vibeProviderStatusBar.js';

// VibeIDE: Gutter decorations (agent-written lines)
import './vibeGutterDecorations.js';

// VibeIDE: Inline AI explanation hover provider (L929)
import './vibeInlineAiExplanationHoverProvider.js';

// VibeIDE: Context window visualizer statusbar
import './vibeContextWindowStatusBar.js';

// VibeIDE: Context usage report command (vibeide.context.status — opens composition report)
import './vibeContextReportContribution.js';

// VibeIDE: "VibeIDE Команды" resizable command-browser modal (brain menu)
import './vibeCommandsPaletteContribution.js';

// VibeIDE: "Проверка провайдеров" — provider connectivity diagnostics modal (brain menu)
import './vibeProviderDiagnosticsContribution.js';

// VibeIDE: status-bar wrench — one-click «починить связь с провайдерами» (reset transport)
import './vibeProviderFixStatusBar.js';

// VibeIDE: "Установить дефолтную обвязку для агентов" command (.vibe defaults)
import './vibeDefaultsContribution.js';

// VibeIDE: default-setting overrides (editor.wordWrap = on, …)
import './vibeDefaultSettingsOverrides.js';

// VibeIDE: global settings schema registration (vibeide.llm.*, vibeide.skills.*, vibeide.tools.*, …).
// MUST be imported so its `registerConfiguration` runs — otherwise these keys are unregistered and
// writing them (e.g. the repair-tool «Отключить» toast) fails with "not a registered configuration".
import '../common/vibeideGlobalSettingsConfiguration.js';

// VibeIDE: .vibe/providers.json JSON Schema + jsonc association (IntelliSense + comment highlighting)
import './vibeProvidersSchemaContribution.js';

// VibeIDE: dynamic providers service (reads/resolves .vibe/providers.json) + diagnostic command
import './vibeDynamicProvidersService.js';
import './vibeProvidersDiagnosticContribution.js';

// VibeIDE: Config Guard diagnostic command (show findings from .vibe/providers.json & mcp.json scans)
import './vibeConfigGuardDiagnosticContribution.js';

// VibeIDE: Tool-call format indicator statusbar (native FC vs XML fallback + auto-downgrade reason)
import './vibeStatusBarToolFormat.js';

// VibeIDE: Editor actions (Explain this line, Freeze, Pause and explain)
import './vibeEditorActions.js';

// VibeIDE: Keybinding conflict resolver
import './vibeKeybindingConflictResolver.js';

// VibeIDE: Ollama/LM Studio onboarding (auto-detect local models)
import './vibeOllamaOnboarding.js';

// VibeIDE: Stealth mode service
import '../common/vibeStealthModeService.js';

// VibeIDE: Reproducible sessions
import '../common/vibeReproducibleSessionService.js';

// VibeIDE: Explain this decision service
import '../common/vibeExplainDecisionService.js';

// VibeIDE: LLM-as-judge diff review
import '../common/vibeLLMJudgeService.js';

// VibeIDE: Shareable debug link
import '../common/vibeShareableLinkService.js';

// VibeIDE: Offline-first UX
import './vibeOfflineUXContribution.js';

// VibeIDE: Auto-repair loop service
import '../common/vibeAutoRepairLoopService.js';

// VibeIDE: Custom modes (Architect / Coder / Debugger)
import '../common/vibeCustomModesService.js';

// VibeIDE: Task decomposition UI service
import '../common/vibeTaskDecompositionService.js';

// VibeIDE: Project Health Dashboard
import '../common/vibeProjectHealthService.js';

// VibeIDE: Next-edit prediction (Tab completion with task context)
import '../common/vibeNextEditPredictionService.js';

// VibeIDE: FIM runtime context-collection pipeline (prefix/suffix/tabs/edits)
import './vibeFimContextCollector.js';

// VibeIDE: Git worktree isolation
import '../common/vibeGitWorktreeService.js';

// VibeIDE: MCP Server Marketplace
import '../common/vibeMCPMarketplaceService.js';

// VibeIDE: Extension permissions UI
import '../common/vibeExtensionPermissionsService.js';

// VibeIDE: Multi-agent service (Phase 3b skeleton)
import '../common/vibeMultiAgentService.js';

// VibeIDE: Multi-agent / worktree observability (status bar + safety notice)
import './vibeMultiAgentObservationStatusBar.js';

// VibeIDE: Ambient agent (opt-in background monitoring)
import '../common/vibeAmbientAgentService.js';

// VibeIDE: Diff view virtualization (100+ files)
import './vibeDiffVirtualizationService.js';

// VibeIDE: Provider dashboard (cost history)
import './vibeProviderDashboard.js';

// VibeIDE: Speculative parallel exploration (Phase 3b)
import '../common/vibeSpeculativeExplorationService.js';

// VibeIDE: Autocomplete explainability (hover → why suggested)
import '../common/vibeAutocompleteExplainService.js';

// VibeIDE: Voice input (Whisper.cpp / Web Speech, Phase 3b)
import '../common/vibeVoiceInputService.js';

// VibeIDE: Subagent service — isolated context, constraints inheritance, mini-budget (Phase 3b full impl)
import '../common/vibeSubagentService.js';

// VibeIDE: Provider proxy — optional local HTTP debug proxy for raw provider request/response
import './vibeProviderProxyService.js';

// VibeIDE: Browser automation — Playwright consent gate + audit (Phase 3b: real runner)
import '../common/vibeBrowserAutomationService.js';

// VibeIDE: MCP OAuth / token manager — unified OAuth token storage for MCP servers
import '../common/vibeMCPOAuthService.js';

// VibeIDE: Binary diff policy — limits/placeholder for binary/large files in diff preview
import '../common/vibeBinaryDiffPolicyService.js';

// VibeIDE: Desktop notifications for blocking agent approvals (OS-level when window unfocused)
import './vibeDesktopNotificationService.js';

// VibeIDE: OTLP trace export for agent cycle (tool-calls, LLM latency, context size)
import '../common/vibeAgentOtelService.js';

// VibeIDE: MCP Sampling / Elicitation support
import '../common/vibeMCPSamplingService.js';

// VibeIDE: Spec-driven context (OpenAPI/AsyncAPI/GraphQL schema attachment + breaking change detection)
import '../common/vibeSpecDrivenContextService.js';

// VibeIDE: Agent-rendered UI (A2UI) — allowlisted component rendering from agent responses (experimental)
import '../common/vibeAgentRenderedUIService.js';

// VibeIDE: Alternatives comparison — honest "how we differ" onboarding screen (Continue.dev/Cursor/Aider)
import './vibeAlternativesComparisonContribution.js';

// VibeIDE: Subagent commands — spawn explore, list active
import './vibeSubagentCommands.js';

// VibeIDE: Subagent preset registry — typed presets + delegation heuristic
import '../common/vibeSubagentRegistryService.js';

// VibeIDE: Roadmap Agent mode — orchestrates subagents from roadmap/plan source
import './vibeRoadmapAgentContribution.js';

// VibeIDE: Subagent orchestrator — completion protocol, retry/skip policy, atomic step marks
import '../common/vibeSubagentOrchestratorService.js';

// VibeIDE: Subagent status bar — active subagent count + click → list picker
import './vibeSubagentStatusBarContribution.js';

// VibeIDE: Background job service — descriptor, tool policy, budget enforcement (§ J.2)
import '../common/vibeBackgroundJobService.js';

// VibeIDE: Background job contribution — checkpoint before run, morning digest, schedule hint
import './vibeBackgroundJobContribution.js';

// VibeIDE: PR-native job completion — optional draft PR creation after successful job
import '../common/vibeJobPRCompletionService.js';

// VibeIDE: Project rules service — .vibe/rules.md and AGENTS.md only
//   with secret detection + source labeling + file watcher (§ H.0 + H.1.1)
import './vibeProjectRulesService.js';

// VibeIDE: Workspace settings forms — Rules/Agents/Prompts/Skills file IO via IFileService
import './vibeWorkspaceFormsService.js';

// VibeIDE: Project rules settings — toggle per-source, stats preview, config watcher (§ H.1.2)
import './vibeProjectRulesSettingsContribution.js';

// VibeIDE: log full detail of global unexpected errors so "Подробности — в журнале" holds them (C)
import './vibeUnexpectedErrorLoggingContribution.js';

// VibeIDE: GDPR palette commands — export (DSAR) + delete (right to be forgotten) (§ N.2)
import './vibeGdprPaletteContribution.js';

// VibeIDE: Cost confirm settings — vibeide.cost.confirmThreshold / confirmTokenThreshold / alwaysConfirm (§ K.3)
import '../common/costForecastConfiguration.js';

// VibeIDE: MCP OAuth token rotation wrapper — periodic + server-removed revocation (§ K.2/919)
import './vibeMCPTokenRotationContribution.js';

// VibeIDE: Provider auto-failover — processOutcome FSM wired to VibeProviderStatusService (§ N.3/1184)
import './vibeProviderFailoverContribution.js';

// VibeIDE: Network outbound panel — vibeide.network.showOutbound palette → ring buffer → Output channel (§ N.5/1043)
import './vibeNetworkContribution.js';

// VibeIDE: Subagent isolation runtime — real Worker/child_process.fork adapter for decideSubagentIsolation (§ L883)
import './vibeSubagentIsolationRuntime.js';

// VibeIDE: Background agent runtime — fork/spawn + JSON-line stdout protocol driving lifecycle FSM (§ L884)
import './vibeBackgroundAgentRuntime.js';

// VibeIDE: Roadmap-agent executor — delegate-to-subagent pipeline driving transitionLoop FSM (§ L885)
import './vibeRoadmapAgentExecutor.js';

// VibeIDE: Cloud locale sync — runtime adapter for decideLocaleSync + HTTP exchange (§ L517)
import './vibeCloudLocaleSyncService.js';
