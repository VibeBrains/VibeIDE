/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/


// register inline diffs
import './editCodeService.js'

// register Sidebar pane, state, actions (keybinds, menus) (Ctrl+L)
import './sidebarActions.js'
import './sidebarPane.js'

// register quick edit (Ctrl+K)
import './quickEditActions.js'

// register Quick Actions
import './quickActions.js'


// register Autocomplete
import './autocompleteService.js'

// register Context services
// import './contextGatheringService.js'
// import './contextUserChangesService.js'

// settings pane
import './vibeideSettingsPane.js'

// register css
import './media/vibeide.css'

// Builtin Vibe Neon — title-bar glow toggle registration + default theme chrome CSS (extensions/vibeide-neon)
import './vibeNeonGlowTitleBar.js'
import './vibeNeonThemeContribution.js'

// Native workspace bookmarks (Vibe Projects)
import './vibeProjects.contribution.js'

// update (frontend part, also see platform/)
import './vibeideUpdateActions.js'

import './convertToLLMMessageWorkbenchContrib.js'

// tools
import './vibeAgentTerritorialLockService.js'
import './toolsService.js'
import './terminalToolService.js'

// register Thread History
import '../common/vibePlanEventJournalService.js'
import '../common/vibePersistedPlanService.js'
import './vibePlanBindingRegistry.js'
import './chatThreadService.js'

// ping - lazy load after startup
import('./metricsPollService.js').catch(() => { });

// helper services
import './helperServices/consistentItemService.js'

// register selection helper
import './vibeideSelectionHelperWidget.js'

// register tooltip service
import './tooltipService.js'

// register onboarding service - lazy load (only needed on first run)
import('./vibeideOnboardingService.js').catch(() => { });

// register misc service
import './miscWokrbenchContrib.js'

// remove built-in chat surfaces we don't use (1.118+ compatible via data-action-id selectors)
import './hideBuiltinChat.js'

// register IAgentSessionsService without the 70+ chat actions (avoids "UNKNOWN service agentSessions" errors)
import './agentSessionsRegistration.js'

// register file service (for explorer context menu)
import './fileService.js'

// register source control management
import './vibeideSCMService.js'

// ---------- common (unclear if these actually need to be imported, because they're already imported wherever they're used) ----------

// llmMessage
import '../common/sendLLMMessageService.js'

// vibeideSettings
import '../common/vibeideSettingsService.js'

// secret detection
import '../common/secretDetectionService.js'

// memories
import '../common/memoriesService.js'
import './memoriesTrackingContribution.js'

// edit risk scoring
import '../common/editRiskScoringService.js'

// code review
import '../common/codeReviewService.js'
import './codeReviewEditorContribution.js'
import './codeReviewCommands.js'

// codebase query - lazy load (only needed when user invokes codebase query command)
import('./codebaseQueryCommands.js').catch(() => { });

// NL shell parser - lazy load (only needed when NL shell parsing is used)
import('../common/nlShellParserService.js').catch(() => { });

// error detection
import '../common/errorDetectionService.js'
import './errorDetectionEditorContribution.js'
import './errorDetectionCommands.js'

// performance guardrails
import '../common/performanceGuardrailsService.js'

// status bar contribution
import './vibeideStatusBar.js'

// dead man's switch — agent idle notification
import './vibeDeadMansSwitchNotification.js'

// first-run validation - lazy load (only needed on first run)
import('./firstRunValidation.js').catch(() => { });
import('../common/secretDetectionConfiguration.js').catch(() => { });

// refreshModel
import '../common/refreshModelService.js'

// metrics
import '../common/metricsService.js'

// updates
import '../common/vibeideUpdateService.js'

// model service
import '../common/vibeideModelService.js'

// model warm-up service
import '../common/modelWarmupService.js'

// ollama installer service (main-process proxy) - lazy load (only needed when Ollama is accessed)
import('../common/ollamaInstallerService.js').catch(() => { });

// repo indexer
import './repoIndexerService.js'
// repo indexer actions - lazy load (only needed when user invokes indexer actions)
import('./repoIndexerActions.js').catch(() => { });

// Image QA Registry initialization
import './imageQARegistryContribution.js'

// VibeIDE: .vibe/ directory initialization
import './vibeConfigInitService.js'

// VibeIDE: Token budget service
import '../common/vibeTokenBudgetService.js'

// VibeIDE: Dead man's switch service
import './vibeDeadMansSwitchService.js'

// VibeIDE: Loop detector service
import './vibeLoopDetectorService.js'

// VibeIDE: Constraints service
import '../common/vibeConstraintsService.js'

// VibeIDE: Prompt guard service (injection + context poisoning detection)
import '../common/vibePromptGuardService.js'

// VibeIDE: Privacy fingerprint stripper
import '../common/vibePrivacyStripperService.js'

// VibeIDE: Models registry (CDN-based with ETag caching)
import '../common/vibeModelsRegistryService.js'

// VibeIDE: Startup health check (.vibe/ schema validation)
import './vibeStartupHealthCheck.js'

// VibeIDE: Context guard service (context window limit monitoring)
import './vibeContextGuardService.js'

// VibeIDE: Token cost forecast service
import '../common/vibeTokenCostForecastService.js'

// VibeIDE: Model fingerprint service (Debug my prompt, Reproducible sessions)
import '../common/vibeModelFingerprintService.js'

// VibeIDE: Semantic codebase search
import '../common/vibeSemanticSearchService.js'

// VibeIDE: Similarity search across `.vibe/plans/*.plan.md` (local embeddings)
import '../common/vibePlanSimilarSearchService.js'

// VibeIDE: Terminal output awareness (opt-in)
import './vibeTerminalOutputService.js'

// VibeIDE: Gutter indicators (agent-written lines)
import './vibeGutterIndicatorService.js'

// VibeIDE: Dependency vulnerability scanner
import '../common/vibeDependencyVulnService.js'

// VibeIDE: Per-file permissions service (.vibe/permissions.json)
import '../common/vibePerFilePermissionsService.js'

// VibeIDE: Debug my prompt service (Debug my prompt, Context diff, Prompt versioning)
import '../common/vibeDebugPromptService.js'

// VibeIDE: Structured output mode (SIEM/Splunk integration)
import '../common/vibeStructuredOutputService.js'

// VibeIDE: Memory decay / Project Brain (.vibe/context.md)
import '../common/vibeMemoryDecayService.js'

// VibeIDE: Agent persona (.vibe/persona.json)
import '../common/vibePersonaService.js'

// VibeIDE: Prompt library service (.vibe/prompts/)
import '../common/vibePromptLibraryService.js'

// VibeIDE: Tool approval service (Explicit tool approval mode)
import '../common/vibeToolApprovalService.js'

// VibeIDE: Pre-flight plan service (Agent pre-flight plan)
import '../common/vibePreFlightService.js'

// VibeIDE: Git blame in agent context
import '../common/vibeGitBlameService.js'

// VibeIDE: MCP Inspector (visual debugger for MCP requests)
import '../common/vibeMCPInspectorService.js'

// VibeIDE: Cost attribution per file
import '../common/vibeCostAttributionService.js'

// VibeIDE: Prompt versioning service
import '../common/vibePromptVersioningService.js'

// VibeIDE: Agent action history service (Agent Action History Sidebar)
import '../common/vibeAgentHistoryService.js'

// VibeIDE: Provider capability probe service
import '../common/vibeProviderCapabilityService.js'

// VibeIDE: Agent thinking out loud mode (extended thinking)
import '../common/vibeThinkingOutLoudService.js'

// VibeIDE: Run tests after apply hook
import '../common/vibeRunTestsAfterApplyService.js'

// VibeIDE: Profiles service (.vibe/profiles/)
import '../common/vibeProfilesService.js'

// VibeIDE: Agent task queue
import '../common/vibeAgentTaskQueueService.js'

// VibeIDE: Workflow service (.vibe/workflows/)
import '../common/vibeWorkflowService.js'

// VibeIDE: Agent Skills library (.vibe/skills/**/SKILL.md)
import '../common/vibeSkillsLibraryService.js'

// VibeIDE: Skill file disk change → notification + optional diff (previous snapshot ↔ disk)
import './vibeSkillDiskDiffContribution.js'
import './vibeSkillsWorkspaceDiscoveryContribution.js'

// VibeIDE: Agent activity log (Output — VibeIDE Agent Activity)
import './vibeAgentActivityLogService.js'

// VibeIDE: Training policy indicator (status bar + model catalog)
import './vibeTrainingPolicyStatusBar.js'

// VibeIDE: Session skill filter (status bar + palette)
import './vibeSkillsSessionStatusBar.js'

// VibeIDE: Chat mode switcher (status bar + cycle command)
import './vibeChatModeStatusBar.js'

// VibeIDE: One-shot cortexide.* → vibeide.* settings migration
import './vibeSettingsMigrationContribution.js'

// VibeIDE: AI provenance marker setting + helper
import '../common/vibeAiProvenanceConfiguration.js'

// VibeIDE: Persisted plan resume (scan .vibe/plans/ on startup, offer to continue interrupted plans)
import './vibePersistedPlanResumeContribution.js'
import './vibePersistedPlanDiskEditContribution.js'

// VibeIDE: Context eviction control
import '../common/vibeContextEvictionService.js'

// VibeIDE: Dependency graph visualization
import '../common/vibeDependencyGraphService.js'

// VibeIDE: Rename/refactor atomic audit
import '../common/vibeRefactorAuditService.js'

// VibeIDE: AI diff summarizer
import '../common/vibeAIDiffSummarizerService.js'

// VibeIDE: Prompt diff on IDE update
import '../common/vibePromptDiffService.js'

// VibeIDE: AI merge conflict resolution
import '../common/vibeMergeConflictService.js'

// VibeIDE: Screenshot → code workflow (privacy warnings)
import '../common/vibeScreenshotCodeService.js'

// VibeIDE: Audit log encryption migration service
import '../common/vibeAuditEncryptionService.js'

// VibeIDE: Diff preview service (confidence score, complexity indicator)
import '../common/vibeDiffPreviewService.js'

// VibeIDE: Unified .vibe/ Config Panel service
import '../common/vibeUnifiedConfigService.js'

// VibeIDE: Keyboard shortcuts registry
import './vibeKeyboardShortcutsService.js'

// VibeIDE: Commands registry (Command Palette entries)
import './vibeCommands.js'

// VibeIDE: Chat group color tokens (registerColor — must load before first theme application)
import './vibeideChatGroupColors.js'

// VibeIDE: Chat editor pane (split tab) + vibeide.chat.open command
import './vibeideChatPane.js'

// VibeIDE: CommandCenter sparkle menu (replaces native Copilot button; adds New Chat / History / Settings / etc.)
import './vibeideCommandCenterMenu.js'

// VibeIDE: Inline diff review service
import '../common/vibeInlineDiffService.js'

// VibeIDE: Slash commands service (/fix, /tests, /my:name, /workflow:name)
import '../common/vibeSlashCommandService.js'

// VibeIDE: @file/@symbol mention service
import '../common/vibeMentionService.js'

// VibeIDE: Provider status widget service
import '../common/vibeProviderStatusService.js'

// VibeIDE: @web/@docs context service (DuckDuckGo search)
import '../common/vibeWebContextService.js'

// VibeIDE: @diagram mention + picker + LLM context injection (§ F roadmap @diagram)
import './vibeDiagramContextContribution.js'

// VibeIDE: Dynamic context filtering — compaction of tool results (§ F / § G roadmap)
import '../common/vibeContextFilterService.js'

// VibeIDE: Checkpoint coordinator — register before rollback/worktree consumers
import '../common/vibeCheckpointCoordinatorService.js'

// VibeIDE: Partial rollback service
import '../common/vibePartialRollbackService.js'

// VibeIDE: Trust Score status bar widget
import './vibeTrustScoreStatusBar.js'

// VibeIDE: First-run security wizard
import './vibeFirstRunWizard.js'

// VibeIDE: Provider status statusbar widget + token cost
import './vibeProviderStatusBar.js'

// VibeIDE: Gutter decorations (agent-written lines)
import './vibeGutterDecorations.js'

// VibeIDE: Context window visualizer statusbar
import './vibeContextWindowStatusBar.js'

// VibeIDE: Editor actions (Explain this line, Freeze, Pause and explain)
import './vibeEditorActions.js'

// VibeIDE: Keybinding conflict resolver
import './vibeKeybindingConflictResolver.js'

// VibeIDE: Ollama/LM Studio onboarding (auto-detect local models)
import './vibeOllamaOnboarding.js'

// VibeIDE: Stealth mode service
import '../common/vibeStealthModeService.js'

// VibeIDE: Reproducible sessions
import '../common/vibeReproducibleSessionService.js'

// VibeIDE: Explain this decision service
import '../common/vibeExplainDecisionService.js'

// VibeIDE: LLM-as-judge diff review
import '../common/vibeLLMJudgeService.js'

// VibeIDE: Shareable debug link
import '../common/vibeShareableLinkService.js'

// VibeIDE: Offline-first UX
import './vibeOfflineUXContribution.js'

// VibeIDE: Auto-repair loop service
import '../common/vibeAutoRepairLoopService.js'

// VibeIDE: Custom modes (Architect / Coder / Debugger)
import '../common/vibeCustomModesService.js'

// VibeIDE: Task decomposition UI service
import '../common/vibeTaskDecompositionService.js'

// VibeIDE: Project Health Dashboard
import '../common/vibeProjectHealthService.js'

// VibeIDE: Next-edit prediction (Tab completion with task context)
import '../common/vibeNextEditPredictionService.js'

// VibeIDE: Git worktree isolation
import '../common/vibeGitWorktreeService.js'

// VibeIDE: MCP Server Marketplace
import '../common/vibeMCPMarketplaceService.js'

// VibeIDE: Extension permissions UI
import '../common/vibeExtensionPermissionsService.js'

// VibeIDE: Multi-agent service (Phase 3b skeleton)
import '../common/vibeMultiAgentService.js'

// VibeIDE: Multi-agent / worktree observability (status bar + safety notice)
import './vibeMultiAgentObservationStatusBar.js'

// VibeIDE: Ambient agent (opt-in background monitoring)
import '../common/vibeAmbientAgentService.js'

// VibeIDE: Diff view virtualization (100+ files)
import './vibeDiffVirtualizationService.js'

// VibeIDE: Provider dashboard (cost history)
import './vibeProviderDashboard.js'

// VibeIDE: Extension security scanner (socket.dev)
import './vibeExtensionSecurityScanner.js'

// VibeIDE: Speculative parallel exploration (Phase 3b)
import '../common/vibeSpeculativeExplorationService.js'

// VibeIDE: Autocomplete explainability (hover → why suggested)
import '../common/vibeAutocompleteExplainService.js'

// VibeIDE: AI debugging integration (Phase 3b)
import '../common/vibeAIDebuggingService.js'

// VibeIDE: Voice input (Whisper.cpp / Web Speech, Phase 3b)
import '../common/vibeVoiceInputService.js'

// VibeIDE: Subagent service — isolated context, constraints inheritance, mini-budget (Phase 3b full impl)
import '../common/vibeSubagentService.js'

// VibeIDE: Provider proxy — optional local HTTP debug proxy for raw provider request/response
import './vibeProviderProxyService.js'

// VibeIDE: Browser automation — Playwright consent gate + audit (Phase 3b: real runner)
import '../common/vibeBrowserAutomationService.js'

// VibeIDE: MCP OAuth / token manager — unified OAuth token storage for MCP servers
import '../common/vibeMCPOAuthService.js'

// VibeIDE: Binary diff policy — limits/placeholder for binary/large files in diff preview
import '../common/vibeBinaryDiffPolicyService.js'

// VibeIDE: Desktop notifications for blocking agent approvals (OS-level when window unfocused)
import './vibeDesktopNotificationService.js'

// VibeIDE: OTLP trace export for agent cycle (tool-calls, LLM latency, context size)
import '../common/vibeAgentOtelService.js'

// VibeIDE: MCP Sampling / Elicitation support
import '../common/vibeMCPSamplingService.js'

// VibeIDE: Spec-driven context (OpenAPI/AsyncAPI/GraphQL schema attachment + breaking change detection)
import '../common/vibeSpecDrivenContextService.js'

// VibeIDE: Agent-rendered UI (A2UI) — allowlisted component rendering from agent responses (experimental)
import '../common/vibeAgentRenderedUIService.js'

// VibeIDE: Alternatives comparison — honest "how we differ" onboarding screen (Continue.dev/Cursor/Aider)
import './vibeAlternativesComparisonContribution.js'

// VibeIDE: Subagent commands — spawn explore, list active
import './vibeSubagentCommands.js'

// VibeIDE: Subagent preset registry — typed presets + delegation heuristic
import '../common/vibeSubagentRegistryService.js'

// VibeIDE: Roadmap Agent mode — orchestrates subagents from roadmap/plan source
import './vibeRoadmapAgentContribution.js'

// VibeIDE: Subagent orchestrator — completion protocol, retry/skip policy, atomic step marks
import '../common/vibeSubagentOrchestratorService.js'

// VibeIDE: Subagent status bar — active subagent count + click → list picker
import './vibeSubagentStatusBarContribution.js'

// VibeIDE: Background job service — descriptor, tool policy, budget enforcement (§ J.2)
import '../common/vibeBackgroundJobService.js'

// VibeIDE: Background job contribution — checkpoint before run, morning digest, schedule hint
import './vibeBackgroundJobContribution.js'

// VibeIDE: PR-native job completion — optional draft PR creation after successful job
import '../common/vibeJobPRCompletionService.js'

// VibeIDE: Project rules service — .vibe/rules.md and AGENTS.md only
//   with secret detection + source labeling + file watcher (§ H.0 + H.1.1)
import './vibeProjectRulesService.js'

// VibeIDE: Workspace settings forms — Rules/Agents/Prompts/Skills file IO via IFileService
import './vibeWorkspaceFormsService.js'

// VibeIDE: Project rules settings — toggle per-source, stats preview, config watcher (§ H.1.2)
import './vibeProjectRulesSettingsContribution.js'
