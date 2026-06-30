/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { recordChatTrace } from './vibeChatRunTrace.js';
import { availableTools, builtinTools, builtinToolNames, chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { TOOL_NAME_ALIASES, applyParamAliases, detectToolByParamShape } from '../common/prompt/toolAliases.js';
import { toolCallSignature, resolveAntiLoopThreshold, endsWithQuestion, looksLikeCompletionText, QUESTION_AUTO_CONTINUE_DEFAULT } from '../common/agentLoopHeuristics.js';
import { IVibeTokenBudgetService } from '../common/vibeTokenBudgetService.js';
import type { AutoDowngradeReason } from '../common/modelCapabilities.js';
import { AnthropicReasoning, getErrorMessage, GeminiLLMChatMessage, LLMChatMessage, LLMTokenUsage, parseContextOverflowError, parseEmptyResponseError, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { ModelHealthTracker, HEALTH_FAILURE_THRESHOLD, HEALTH_WINDOW_MS, classifyProviderError } from '../common/modelHealthTracker.js';
import { translateProviderError } from '../common/providerErrorTranslator.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { autoModelFallbackProviderOrder, ChatMode, FeatureName, ModelSelection, ModelSelectionOptions, ProviderName } from '../common/vibeideSettingsTypes.js';
import { isVisionByNameHeuristic } from '../common/modelVisionHeuristics.js';
import { detectVisionDropResponse } from '../common/visionDropDetector.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { BuiltinToolCallParams, BuiltinToolResultType, TerminalResolveReason, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { approvalTypeOfBuiltinToolName } from '../common/prompt/tools/index.js';
import { IToolsService } from './toolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, ChatImageAttachment, ChatPDFAttachment, CheckpointEntry, CodespanLocationLink, StagingSelectionItem, ToolMessage, PlanMessage, PlanStep, StepStatus, ReviewMessage } from '../common/chatThreadServiceTypes.js';
import { trimThreadMessages, capToolResultSizes } from '../common/chatThreadTrim.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVibeideModelService } from '../common/vibeideModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { IVibeNotifySoundService, NotifySoundEvent } from './vibeNotifySoundService.js';
import { IVibeDesktopNotificationService } from './vibeDesktopNotificationService.js';
import { VibeideFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY, OPEN_TAB_IDS_KEY } from '../common/storageKeys.js';
import { HISTORY_SHOW_ALL_PROJECTS_KEY, HISTORY_DEFAULT_SHOW_ALL_KEY, threadOwnedBy } from '../common/chatHistoryScope.js';
import { IVibeExternalAccessService, ExternalAccessRequiredError } from '../common/vibeExternalAccessService.js';
import { unclaimedToolTagPlaceholder } from '../common/xmlToolNormalize.js';
import { IConvertToLLMMessageService, ContextOverflowError } from './convertToLLMMessageService.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { preprocessImagesForQA } from './imageQAIntegration.js';
import { ITaskAwareModelRouter, TaskContext, TaskType, RoutingDecision } from '../common/modelRouter.js';
import { chatLatencyAudit } from '../common/chatLatencyAudit.js';
import { suggestAlternateTool as suggestAlternateToolPure } from '../common/toolSchemaSuggest.js';
import { IEditRiskScoringService, EditContext, EditRiskScore } from '../common/editRiskScoringService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { TextEdit } from '../../../../editor/common/core/edits/textEdit.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { QueryMetrics } from './repoIndexerService.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';

import { AuditEvent, IAuditLogService } from '../common/auditLogService.js';
import { IVibeAgentActivityLogService } from './vibeAgentActivityLogService.js';
import { IVibeLLMJudgeService } from '../common/vibeLLMJudgeService.js';
import { IVibePersistedPlanService } from '../common/vibePersistedPlanService.js';
import { IVibePlanEventJournalService } from '../common/vibePlanEventJournalService.js';
import { IVibePlanBindingRegistry } from './vibePlanBindingRegistry.js';
import { IVibeTaskDecompositionService } from '../common/vibeTaskDecompositionService.js';
import { IVibeCheckpointCoordinator } from '../common/vibeCheckpointCoordinatorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVibeTokenCostForecastService } from '../common/vibeTokenCostForecastService.js';
import {
	CostForecast,
	CostForecastConfig,
	COST_FORECAST_DEFAULTS,
	decideCostConfirm,
	describeCostDecision,
} from '../common/costForecastConfirm.js';
import {
	transitionWatchdog,
	WatchdogState,
	WatchdogSideEffect,
} from '../common/streamingGapWatchdog.js';
import { classifyAndBuildToast } from '../common/agentErrorClassifier.js';
import { decideResume, appendChunk, PartialResponse } from '../common/responseRetryCache.js';
import { IVibeSessionMemoryService } from '../common/vibeSessionMemoryService.js';
import { IVibeAgentTerritorialLockService } from './vibeAgentTerritorialLockService.js';
import { resolveModelForPath, decodeRoutingRules } from '../common/modelRoutingByPath.js';
import { IVibeMentionService } from '../common/vibeMentionService.js';
import { IVibeSearchContextService } from '../common/vibeSearchContextService.js';
import { IVibeAIDebuggingService } from './vibeAIDebuggingContribution.js';
import { IVibeContextGuardService } from './vibeContextGuardService.js';

// Type predicates for the LLMChatMessage union. The `in` operator is permitted
// inside type-predicate functions (see local/code-no-in-operator), and these give
// the narrowing the structural `parts` vs `content` discriminator requires.
type GeminiPart = GeminiLLMChatMessage['parts'][number];

/** True when the prepared message is in Gemini shape (uses `parts`). */
function isGeminiLLMChatMessage(m: LLMChatMessage): m is GeminiLLMChatMessage {
	return 'parts' in m;
}

/** True when a Gemini part carries plain text. */
function isGeminiTextPart(part: GeminiPart): part is { text: string } {
	return 'text' in part;
}

/** True when a Gemini part carries inline (image) data. */
function isGeminiInlineDataPart(part: GeminiPart): part is { inlineData: { mimeType: string; data: string } } {
	return 'inlineData' in part;
}

// related to retrying when LLM message has error
// Optimized retry logic: faster initial retry, exponential backoff
const STOP_SOUND_SUPPRESS_MS = 2500; // After a user abort / non-terminal clear, suppress run-end notification sounds for this window (covers multiple undefined-transitions from one abort).
const CHAT_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // Start with 1s for faster recovery
const MAX_RETRY_DELAY = 5000; // Cap at 5s
const DEFAULT_MAX_AGENT_LOOP_ITERATIONS = 30; // Default cap; overridable via `vibeide.agent.maxLoopIterations`. 0 in the setting disables the cap.
const MAX_AGENT_LOOP_ITERATIONS_UPPER_BOUND = 200; // Hard ceiling for user-supplied values to avoid runaway loops via accidental large input.
const MAX_CONSECUTIVE_TOOL_ERRORS = 15; // Circuit-breaker: abort agent loop after this many back-to-back tool failures. opencode CLI has no breaker — model just keeps iterating until it succeeds. 15 gives breathing room (some models recover after 5-10 attempts before finding the right tool format) while still preventing infinite loops on truly broken combos.
const AUTO_DOWNGRADE_THRESHOLD = 6; // After this many consecutive tool failures per-(provider×model), CONSIDER an `_autoDetected` override switching the model to XML-fallback — but only for the `numeric-tool-name` quirk (see the gate at the downgrade trigger). Other reasons (missing-required-field / wrong-tool-name / other) are transient, self-correcting failures that opencode just retries through on native FC, so we no longer shove the model into XML for them (that was the root cause of capable models like deepseek-v4-pro getting stuck — see model-stalls #008). Raised 3→6: 3 was trigger-happy on transient failures. Counter resets on `success`. See roadmap O.2.
const ANTI_LOOP_SIGNATURE_RING = 50; // Anti-loop guard: how many recent tool-call signatures to retain per request. Bounds memory while spanning enough history to catch slow re-read cycles. See roadmap F (aggregator-failures section).
const ANTI_LOOP_MAX_BLOCKS = 8; // Anti-loop guard: after this many TOTAL short-circuited (blocked) calls in one request, the model is clearly ignoring the hint — abort the loop with a hard message instead of spinning to maxLoopIterations. Last-resort escalation; the per-signature threshold (`vibeide.chat.antiLoopRepeatThreshold`) is the first line.
const ANTI_LOOP_MAX_CONSECUTIVE_SAME_BLOCKS = 3; // Tighter escalation for the SAME signature blocked back-to-back with no executed call in between: the model is verbatim-replaying one call (observed: get_dir_tree on the same dir ×4 after the guard hint, each costing a full LLM round-trip). Three identical consecutive blocks ≈ zero chance the next nudge lands — abort early instead of burning turns to the total cap.

// Classify the last tool failure into a coarse reason code stored as
// `_reason` on auto-detected overrides (roadmap O.7). Drives toast wording and
// future selectivity rules (e.g. only downgrade on `numeric-tool-name`).
//   - `numeric-tool-name`: tool name is purely digits ("0", "1", "5") — the
//      classic minimax/qwen training-set quirk (training data used numbered
//      tool lists; model emits the index instead of the identifier).
//   - `missing-required-field`: validator complained that a required param
//      came in as `undefined` — schema doesn't enforce required at the SDK
//      layer for this model, so the model emitted an empty `{}`.
//   - `wrong-tool-name`: tool name is non-numeric but not in our registry
//      and not resolvable via TOOL_NAME_ALIASES — hallucination or cross-
//      ecosystem name (`view`, `cat`, etc., minus the ones aliased).
//   - `other`: anything else.
const classifyToolErrorReason = (toolName: string, content: string): AutoDowngradeReason => {
	if (/^\d+$/.test(toolName)) { return 'numeric-tool-name'; }
	if (/must be a string, but it's a\(n\) undefined/i.test(content)) { return 'missing-required-field'; }
	if (/must be a string, but its type is "undefined"/i.test(content)) { return 'missing-required-field'; }
	if (/Unknown tool name "([^"]+)"/.test(content)) { return 'wrong-tool-name'; }
	return 'other';
};

// Build a concrete schema hint for an `invalid_params` error message. Models
// (especially via aggregators that mangle system prompts) often see only the
// validator's terse "X must be a string, but it's a(n) undefined" and don't
// know which fields the tool expects or in what shape. This helper produces:
//
//   The tool "read_file" expects these parameters:
//     - uri (required): The FULL path to the file.
//     - start_line (optional): 1-based. ...
//     ...
//   Example XML call: <read_file><uri>VALUE</uri></read_file>
//
// Required vs optional is detected via the same heuristic used by the AI SDK
// schema builder (description starts with "Optional." → optional).
/**
 * Classify a tool's params into (required, optional). Reused by both
 * `buildToolSchemaHint` (for the SPECIFIC tool the model failed at) and
 * `suggestAlternateTool` (cross-tool matching for confused calls).
 */
const classifyParams = (canonicalToolName: string): { required: string[]; optional: string[] } | null => {
	if (!isABuiltinToolName(canonicalToolName)) { return null; }
	const def = (builtinTools as Record<string, { params?: Record<string, { description: string }> }>)[canonicalToolName];
	if (!def?.params) { return null; }
	const required: string[] = [];
	const optional: string[] = [];
	for (const [k, v] of Object.entries(def.params)) {
		const desc = v.description ?? '';
		if (desc.trimStart().toLowerCase().startsWith('optional')) { optional.push(k); }
		else { required.push(k); }
	}
	return { required, optional };
};

/**
 * X.11.4 / X.13.7 smart-suggest: when the model calls `read_file` with args
 * shaped like `{nl_input: ...}` (observed minimax-m2.7 incident 2026-05-23),
 * we can recognize that `nl_input` is `run_nl_command`'s required param and
 * suggest the model meant that tool. Recovery is faster than blind retry.
 *
 * Heuristic: score each candidate tool by `|rawKeys ∩ candidateRequired| /
 * |candidateRequired|`. A perfect match (every required param present in
 * rawKeys) → score 1.0. Return the best candidate if its score >= 0.6 AND
 * it's strictly better than the called tool's score against itself (avoids
 * suggesting the same tool back when 1 of N required params is wrong).
 *
 * Returns null if no plausible suggestion — most invalid_params are genuine
 * one-field bugs in the same tool, not cross-tool confusion.
 */
const suggestAlternateTool = (calledTool: string, rawParamKeys: readonly string[]): string | null => {
	const calledClassified = classifyParams(calledTool);
	if (!calledClassified) { return null; }
	const candidates: { name: string; params: { required: string[] } }[] = [];
	for (const candidate of Object.keys(builtinTools)) {
		const classified = classifyParams(candidate);
		if (!classified) { continue; }
		candidates.push({ name: candidate, params: { required: classified.required } });
	}
	return suggestAlternateToolPure(
		{ name: calledTool, params: { required: calledClassified.required } },
		candidates,
		rawParamKeys,
	);
};

const buildToolSchemaHint = (canonicalToolName: string, rawParamKeys: readonly string[] = []): string => {
	const classified = classifyParams(canonicalToolName);
	if (!classified) { return ''; }
	const def = (builtinTools as Record<string, { params: Record<string, { description: string }> }>)[canonicalToolName];
	if (!def?.params) { return ''; }
	const lines: string[] = [];
	lines.push(`The tool "${canonicalToolName}" expects these parameters:`);
	for (const k of classified.required) { lines.push(`  - ${k} (required): ${def.params[k].description}`); }
	for (const k of classified.optional) { lines.push(`  - ${k} (optional): ${def.params[k].description}`); }
	// X.11.4 — smart suggest. If the rawParams shape better matches a DIFFERENT
	// tool's required params (e.g. minimax called read_file with {nl_input} —
	// nl_input is run_nl_command's required arg), append a one-line suggestion.
	// The model may have intended the alternate tool all along.
	const alternate = suggestAlternateTool(canonicalToolName, rawParamKeys);
	if (alternate) {
		lines.push('');
		lines.push(`Note: your argument shape (${rawParamKeys.join(', ')}) matches the "${alternate}" tool better than "${canonicalToolName}". If you meant to call "${alternate}", do so now with its expected params.`);
	}
	// Intentionally NO format example. The model is on whichever channel its SDK
	// adapter uses (Anthropic tool_use blocks, OpenAI tool_calls, or XML for
	// the legacy fallback). Showing an XML example used to mislead models on
	// the native FC path — they'd start emitting `<tool><param>...</param></tool>`
	// in plaintext instead of proper tool_use blocks, and our adapter wouldn't
	// parse it. Trust the SDK channel; the model already knows its own protocol.
	return lines.join('\n');
};

// Stall detection: notify user if LLM stops producing tokens unexpectedly.
// EARLY surfaces an inline banner only (no toast); FULL thresholds also raise a toast.
// HARD goes further: auto-abort the stream so `isRunning` doesn't latch forever and
// block subsequent submits. All four thresholds are user-overridable via
// `vibeide.chat.stream*StallSeconds` settings; the defaults below match the registered
// `default` field in `vibeideGlobalSettingsConfiguration.ts` and are used only when
// config returns NaN/undefined (transient race during settings reload).
const DEFAULT_EARLY_STALL_SECONDS = 15;      // soft signal: show inline "stalled" banner in chat
const DEFAULT_FIRST_TOKEN_STALL_SECONDS = 30;     // no first token received after sending request
const DEFAULT_MID_STREAM_STALL_SECONDS = 45;      // no new token received during active streaming
const DEFAULT_HARD_STALL_SECONDS = 120;     // 120s — default auto-abort threshold
const HARD_STALL_AUTO_RETRY_MAX = 1;       // ONE automatic re-send per thread after a hard-stall: a second stall in a row means the hang is systemic (payload/provider), not transient — surface the error instead of burning more silent 120s windows. Reset on any successful reply; on/off via `vibeide.chat.hardStallAutoRetry`.

// Read a numeric setting with NaN-guard. Math.max/min propagate NaN, which then
// becomes setTimeout(NaN * 1000) — a no-op timer that silently disables stall
// detection. Validate up front: if non-finite, fall back to the supplied default.
const readClampedNumberSetting = (
	configService: { getValue<T>(key: string): T | undefined },
	key: string,
	fallback: number,
	min: number,
	max: number,
): number => {
	const raw = configService.getValue<number>(key);
	const candidate = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
	return Math.max(min, Math.min(max, candidate));
};


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) { return null; }

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i];

		if (s.uri.fsPath !== newSelection.uri.fsPath) { continue; }

		if (s.type === 'File' && newSelection.type === 'File') {
			return i;
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) { continue; }
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range;
			const [newStart, newEnd] = newSelection.range;
			if (oldStart !== newStart || oldEnd !== newEnd) { continue; }
			return i;
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i;
		}
	}
	return null;
};


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' };
type UserMessageState = UserMessageType['state'];
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
};

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
};



/** Per-tab chat config snapshot (multi-chat): each chat tab keeps its own model / mode / autopilot /
 * iterations. Applied to the global stores when the tab becomes active, re-saved when the user changes
 * a control while it's active. `chatMode` is kept as a plain string here to avoid a type import cycle;
 * the React layer casts it to ChatMode. */
export type ThreadChatConfig = {
	model: { providerName: string; modelName: string } | null;
	chatMode: string;
	autopilot: boolean;
	iterations: number;
};

export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string
	workspaceId?: string; // IWorkspace.id this thread belongs to. Undefined = legacy (pre-scoping) thread → shown in every project.
	workspaceLabel?: string; // Human-readable project name (first folder basename) captured at stamp time, for the "all projects" badge.
	/** Per-tab chat config (model/mode/autopilot/iterations). Undefined until the tab first snapshots the globals. */
	chatConfig?: ThreadChatConfig;

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		/** Context the user queued WHILE a turn is running — drained into a user message at the top of the
		 *  next agent hop (no abort needed). See docs/knowledge/chat-ux/chat-interrupt-and-inject.md. */
		pendingInjections?: string[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink;
			};
		};


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>;
			_whenMountedResolver: (res: WhenMounted) => void;
			mountedIsResolvedRef: { current: boolean };
		};

		// Last provider-reported token usage in this thread. Set in onFinalMessage when
		// the AI SDK surfaces a `usage` block on `finish`. Used by the UI context-usage
		// indicator as the authoritative base instead of relying on length/4 heuristics.
		lastUsage?: LLMTokenUsage;

	};
};

type ChatThreads = {
	[id: string]: undefined | ThreadType;
};


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
	/** Working set of threads shown as in-view chat tabs (multi-chat). Subset of allThreads; persisted per-workspace. */
	openTabIds: string[];
};

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'preparing' // preparing request (model selection, validation, etc.)
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined;

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string; fullError: Error | null; recoverable?: 'dismissPlan' | 'forceReset' | 'switchModel' | 'retry' };
		// Provider rate-limit auto-pause: the run is waiting out a 429 retry-after and will resume the
		// turn itself at `resumeAtMs`. Drives the inline countdown banner so the wait is visible.
		pauseInfo?: { resumeAtMs: number; attempt: number; maxAttempts: number; reason: 'rateLimit' };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
		stallInfo?: { stalledAt: number }; // set when watchdog detects no new tokens; cleared on next token
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'preparing';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string; // status message like "Selecting best model..." or "Preparing request..."
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // allow cancellation during preparation
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	};
};

const newThreadObject = (workspaceId: string | undefined, workspaceLabel: string | undefined) => {
	const now = new Date().toISOString();
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		workspaceId,
		workspaceLabel,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			pendingInjections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType;
};



export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>;
	/** Fired when provider/model health degradation state changes (3099) — model-chip warning. */
	readonly onDidChangeProviderHealth: Event<void>;
	/** True if the (provider×model) is currently over the failure threshold within the window (3099). */
	isProviderDegraded(providerName: string, modelName: string): boolean;
	/** Fired after a thread is deleted. Consumers (tab-binding contribution) use this to close/unbind tabs. */
	readonly onDidDeleteThread: Event<string>;
	/**
	 * Alias for `onDidDeleteThread` — fires when a thread session is disposed (closed/deleted).
	 * Roadmap L904/L933: agent-lock holder-disposed cleanup and session-memory releaseThread.
	 */
	readonly onDidDisposeThread: Event<string>;
	/** Fired when UI should open the anchored chat-history popover (toolbar). */
	readonly onDidRequestChatHistoryPopover: Event<void>;
	/** Open sidebar history popover instead of workspace quick pick. */
	requestChatHistoryPopover(): void;
	/**
	 * If a history-open was requested before the React toolbar mounted, the flag stays set.
	 * Call once on mount (after subscribing) — returns true and clears if pending.
	 */
	pullChatHistoryPopoverPending(): boolean;

	getCurrentThread(): ThreadType;
	/** IWorkspace.id of the current window — used to scope history to the open project. */
	getCurrentWorkspaceId(): string;
	/** Cross-window UI toggle: when true, history lists show threads from every project. */
	getHistoryShowAllProjects(): boolean;
	setHistoryShowAllProjects(value: boolean): void;
	/** Re-assign a thread to the currently open project (used by the "move to this project" history action). */
	moveThreadToCurrentWorkspace(threadId: string): void;
	/** Stamp all legacy (untagged) threads onto the current project. Returns how many were claimed. */
	claimUntaggedThreadsForCurrentWorkspace(): number;
	/** Message-bearing threads strictly owned by the current project (for export). */
	getCurrentWorkspaceThreads(): ThreadType[];
	/** Delete all message-bearing threads strictly owned by the current project. Returns how many were deleted. */
	deleteCurrentWorkspaceThreads(): number;
	openNewThread(): void;
	/** Always create a fresh thread (bypasses openNewThread's empty-thread reuse). Returns the new thread id. */
	forceCreateNewThread(): string;
	switchToThread(threadId: string): void;
	/** Close an in-view chat tab (removes it from the open set; the thread stays in history). */
	closeTab(threadId: string): void;
	/** Reorder open chat tabs: move `fromId` to the slot of `toId` (drag-and-drop). Persisted. */
	reorderOpenTabs(fromId: string, toId: string): void;
	/** Per-thread composer draft (in-memory). Lets each open chat tab keep its own unsent input across tab switches. */
	getThreadDraft(threadId: string): string;
	setThreadDraft(threadId: string, text: string): void;
	/** Per-tab chat config snapshot (model/mode/autopilot/iterations), persisted with the thread. */
	setThreadChatConfig(threadId: string, cfg: ThreadChatConfig): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState;
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void;
	getCurrentThreadState: () => ThreadType['state'];
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void;

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string; messageIdx: number; threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string; newLinkLocation: CodespanLocationLink; messageIdx: number; threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string; threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined;

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// Recover from a stalled stream: discard the partial assistant output and re-send the last user message.
	retryStalledStream(threadId: string): Promise<void>;
	// Same as retryStalledStream, but arms one-shot auto-collection of the stall diagnostics report.
	retryStalledStreamWithDiagnostics(threadId: string): Promise<void>;
	// Plain-data snapshot (provider/model/timeout/last error) for the stall diagnostics report.
	getStallDiagnosticsContext(threadId: string): { provider?: string; model?: string; hardStallSeconds: number; lastErrorMessage?: string };
	// "Продолжить сейчас" on the rate-limit pause banner: skip the remaining wait and resume the turn now.
	resumeRateLimitPauseNow(threadId: string): Promise<void>;

	/**
	 * Hard-reset a thread's stream state. Unlike abortRunning(), this does NOT
	 * await any pending interrupt promise — it just clears all the local timers,
	 * pending RAF updates, and the streamState entry itself. Used by:
	 *   - the stuck-state recovery path in _addUserMessageAndStreamResponse,
	 *     when the thread has been "running" for longer than the submit-stall
	 *     threshold and a new send arrives;
	 *   - the inline "Сбросить состояние чата" button shown when the chat UI
	 *     detects a recoverable: 'forceReset' error in the streamState;
	 *   - the `vibeide.chat.forceResetChatState` Command Palette action.
	 *
	 * Returns `true` if something was actually cleared (running state / watchdog
	 * timer / age tracker had data); `false` if the thread was already idle and
	 * the call was a no-op. Lets callers tailor user feedback and avoid
	 * metric-event noise when nothing actually happened.
	 */
	forceResetChatState(threadId: string): boolean;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string; messageIdx: number; threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId, images, noPlan, displayContent }: { userMessage: string; threadId: string; images?: ChatImageAttachment[]; noPlan?: boolean; displayContent?: string }): Promise<void>;
	/** Queue context to be merged into the NEXT agent hop without aborting the running turn. */
	addPendingInjection(threadId: string, text: string): void;
	/** Remove a still-queued injection by index (user cancelled it before it was drained into context). */
	removePendingInjection(threadId: string, index: number): void;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string; messageIdx: number; jumpToUserModified: boolean }): Promise<void>;

	// Plan management methods
	approvePlan(opts: { threadId: string; messageIdx: number }): void;
	rejectPlan(opts: { threadId: string; messageIdx: number }): void;
	editPlan(opts: { threadId: string; messageIdx: number; updatedPlan: PlanMessage }): void;
	toggleStepDisabled(opts: { threadId: string; messageIdx: number; stepNumber: number }): void;
	reorderPlanSteps(opts: { threadId: string; messageIdx: number; newStepOrder: number[] }): void;
	/** Pin-context: toggle `pinned` on a user/assistant message. Pinned messages are kept verbatim
	 *  by budget-fill truncation in convertToLLMMessageService (the honor side already exists). */
	toggleMessagePinned(opts: { threadId: string; messageIdx: number }): void;
	dismissAllPendingPlans(threadId: string, opts?: { resumeBlockedMessage?: boolean }): number;

	// Step execution control
	pauseAgentExecution(opts: { threadId: string }): Promise<void>;
	resumeAgentExecution(opts: { threadId: string }): Promise<void>;
	/** Abort every thread that is mid-LLM, mid-tool, or awaiting approval. Returns number of threads interrupted. */
	emergencyStopAllAgents(): Promise<number>;
	retryStep(opts: { threadId: string; messageIdx: number; stepNumber: number }): Promise<void>;
	skipStep(opts: { threadId: string; messageIdx: number; stepNumber: number }): void;
	rollbackToStep(opts: { threadId: string; messageIdx: number; stepNumber: number }): Promise<void>;

	/**
	 * Inject a pre-built PlanMessage into a thread (used for plan resume after Reload Window).
	 * The plan is added with approvalState = 'pending' so the user can review and Execute.
	 */
	injectPlanMessage(threadId: string, plan: PlanMessage): void;

	focusCurrentChat: () => Promise<void>;
	blurCurrentChat: () => Promise<void>;
}

export const IChatThreadService = createDecorator<IChatThreadService>('vibeChatThreadService');

// Sentinel placed in displayContentSoFar before the first model token arrives.
// The UI matches this exact string to render an animated indicator instead of the raw text.
export const WAITING_FOR_MODEL_RESPONSE_SENTINEL = 'Waiting for model response...';
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// #6 — show the "repair fired (slower)" attribution toast at most once per window session.
	private _xmlRepairFiredNotified = false;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	private readonly _onDidChangeProviderHealth = new Emitter<void>();
	readonly onDidChangeProviderHealth: Event<void> = this._onDidChangeProviderHealth.event;

	private readonly _onDidDeleteThread = new Emitter<string>();
	readonly onDidDeleteThread: Event<string> = this._onDidDeleteThread.event;
	readonly onDidDisposeThread: Event<string> = this._onDidDeleteThread.event;

	private _pendingChatHistoryPopover = false;
	private readonly _onDidRequestChatHistoryPopover = new Emitter<void>();
	readonly onDidRequestChatHistoryPopover: Event<void> = this._onDidRequestChatHistoryPopover.event;

	requestChatHistoryPopover(): void {
		this._pendingChatHistoryPopover = true;
		this._onDidRequestChatHistoryPopover.fire();
	}

	pullChatHistoryPopoverPending(): boolean {
		if (!this._pendingChatHistoryPopover) {
			return false;
		}
		this._pendingChatHistoryPopover = false;
		return true;
	}

	readonly streamState: ThreadStreamState = {};
	state: ThreadsState; // allThreads is persisted, currentThread is not

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)

	// Cache for file read results to prevent duplicate reads
	// Key: threadId -> cacheKey (uri.fsPath + startLine + endLine + pageNumber) -> cached result
	// Uses LRU eviction to prevent unbounded memory growth
	private readonly _fileReadCache: Map<string, Map<string, BuiltinToolResultType['read_file']>> = new Map();

	// LRU tracking for file read cache (threadId -> ordered list of cache keys)
	private readonly _fileReadCacheLRU: Map<string, string[]> = new Map();
	private static readonly MAX_FILE_READ_CACHE_ENTRIES_PER_THREAD = 100; // Limit cache size per thread

	// Anti-loop guard: rolling window of recent successful tool-call signatures per thread. When the
	// model issues the SAME tool with identical args repeatedly (observed: glob **/* ~10× in a row),
	// the result never changes — we nudge it to change approach. (threadId -> last N signatures)
	private readonly _recentToolSigs: Map<string, string[]> = new Map();
	private static readonly TOOL_LOOP_WINDOW = 6;
	private static readonly TOOL_LOOP_THRESHOLD = 3;
	private static readonly TOOL_LOOP_ESCALATE_THRESHOLD = 5;

	/** Stable per-window-session nonce so lease heartbeats extend the same execution lease file. */
	private _executionLeaseHolderNonce: string | undefined;

	/** Per-session cost-approval cache (provider+modelId → approvedUpToUSD). */
	private _costSessionApprovals: Array<{ provider: string; modelId: string; approvedUpToUSD: number }> = [];

	// Throttle stream state updates during streaming to reduce React re-renders
	// Use requestAnimationFrame to batch updates for better performance
	private readonly _pendingStreamStateUpdates = new Map<string, ThreadStreamState[string]>();
	private _streamStateRafId: number | undefined;

	// Timestamp (unix ms) when streamState[threadId] last transitioned to a non-idle
	// running state. Used by the stuck-state detection in _addUserMessageAndStreamResponse
	// and the diagnostic surface — if a thread has been "running" for an implausibly
	// long time, we forcibly recover instead of hanging the chat indefinitely.
	private readonly _streamStateSetAt = new Map<string, number>();

	// Suppression window (unix ms, per thread) during which a run-end transition to `undefined`
	// must NOT play a notification sound: user-initiated stops (Escape / abort / cost-decline /
	// edit-rerun) and non-terminal intermediate clears (hard-stall auto-retry). A time window
	// (not a one-shot flag) robustly covers a single abort that produces several undefined
	// transitions in quick succession. Focus-mute already covers the common case; this is the
	// deterministic backstop for users who turned focus-mute off.
	private readonly _suppressStopSoundUntil = new Map<string, number>();
	private _suppressStopSound(threadId: string) {
		this._suppressStopSoundUntil.set(threadId, Date.now() + STOP_SOUND_SUPPRESS_MS);
	}

	// Per-(thread × provider × model) counter of consecutive "Empty response" errors.
	// Reset on any successful response from the same combo (onFinalMessage). Trips
	// when streak reaches `vibeide.chat.emptyResponseCircuitBreakerThreshold` — at
	// which point the next onError swaps the regular toast for an inline
	// recoverable: 'switchModel' message ("Model X failed N times in a row, open
	// settings to switch"). Provider/model identifiers are NEVER hardcoded — both
	// are parsed at runtime from the VibeIDE-emitted error template via regex.
	// Key shape: `${threadId}:${providerName}:${modelName}`.
	private readonly _emptyResponseStreak = new Map<string, number>();
	// Consecutive auto-waits on minute-window rate limits per thread (autopilot resume).
	// Bounded by `vibeide.chat.rateLimitAutoWaitMaxRetries`; reset on any successful reply.
	private readonly _rateLimitAutoWaitStreak = new Map<string, number>();
	// Pending rate-limit resume timers per thread, so "Продолжить сейчас" / a new submit / forceReset
	// can cancel the scheduled auto-resume instead of letting it fire on top of manual action.
	private readonly _rateLimitResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Consecutive hard-stall auto-retries per thread (`vibeide.chat.hardStallAutoRetry`).
	// Capped at HARD_STALL_AUTO_RETRY_MAX; reset on any successful reply.
	private readonly _hardStallAutoRetryStreak = new Map<string, number>();
	// Threads where "Повторить с диагностикой" armed auto-collection — one-shot: if the next attempt
	// also hard-stalls (terminal), the stall report is built automatically. Disarmed on fire/success.
	private readonly _autoCollectStallDiagByThread = new Set<string>();
	// Models auto-downgraded to XML after a «no endpoints support tool_choice» 404 —
	// SESSION-wide by necessity: the post-downgrade retry starts a new run, so a
	// run-local guard would reset and loop the downgrade forever.
	private readonly _noToolsDowngradedModels = new Set<string>();

	// Cross-thread health tracker per (provider, model) combo. Counts failures
	// (empty-response, overflow, invalid-params) in a rolling 10-min window. When
	// the threshold is crossed, surface a one-time toast suggesting model switch —
	// even if the per-thread streak hasn't tripped (e.g. user spread the failures
	// across multiple chats but it's the same broken aggregator route). Ephemeral;
	// not persisted across IDE restarts.
	private readonly _modelHealthTracker = new ModelHealthTracker();

	isProviderDegraded(providerName: string, modelName: string): boolean {
		return this._modelHealthTracker.isDegraded(providerName, modelName);
	}

	// Submit-level watchdog: started in _addUserMessageAndStreamResponse, cleared in
	// _setStreamState when the stream actually transitions to an active state
	// ('preparing'/'LLM'/'tool'/'idle'/'awaiting_user'). Covers hangs in the prep pipeline
	// (file reads, prompt building, router selection, etc.) — i.e. the period BEFORE the
	// stream-level hardStallTimer in _runChatAgent gets created. Without this, a hang
	// before preparing-state is reached would leave the user staring at nothing forever
	// with no spinner and no error.
	private readonly _submitWatchdogByThread = new Map<string, ReturnType<typeof setTimeout>>();

	// PERFORMANCE: Cache prepared LLM messages to avoid expensive re-preparation when messages haven't changed
	// Key: hash of (chatMessages content + modelSelection + chatMode + repoIndexer results)
	// Value: { messages, separateSystemMessage, tokenCount, contextSize, timestamp }
	private readonly _messagePrepCache: Map<string, {
		messages: LLMChatMessage[];
		separateSystemMessage: string | undefined;
		tokenCount: number;
		contextSize: number;
		timestamp: number;
	}> = new Map();
	private static readonly MESSAGE_PREP_CACHE_TTL = 5000; // 5 seconds - messages can change during agent loops
	private static readonly MESSAGE_PREP_CACHE_MAX_SIZE = 50; // Limit cache size

	// PERFORMANCE: coalesce thread persistence. `_storeAllThreads` is called 10+ times per agent
	// turn (every message / tool result); each call re-serialized the ENTIRE thread store (a 65MB
	// JSON.stringify on heavy sessions — the slope-alert watchdog flagged the resulting churn).
	// We now buffer the latest state and write once per debounce window (bounded — fires ~1.5s
	// after the FIRST change in a burst, then re-arms), with a guaranteed flush on storage-save
	// and dispose so nothing buffered is lost.
	private static readonly STORE_THREADS_DEBOUNCE_MS = 1500;
	private _pendingThreadsToStore: ChatThreads | undefined = undefined;
	private readonly _storeThreadsScheduler = this._register(new RunOnceScheduler(() => this._flushStoreThreads(), ChatThreadService.STORE_THREADS_DEBOUNCE_MS));



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVibeideModelService private readonly _vibeideModelService: IVibeideModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IVibeTokenBudgetService private readonly _tokenBudgetService: IVibeTokenBudgetService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IVibePersistedPlanService private readonly _persistedPlanService: IVibePersistedPlanService,
		@IVibePlanEventJournalService private readonly _planEventJournal: IVibePlanEventJournalService,
		@IVibePlanBindingRegistry private readonly _planBindingRegistry: IVibePlanBindingRegistry,
		@IVibeTaskDecompositionService private readonly _taskDecompositionService: IVibeTaskDecompositionService,
		@IMCPService private readonly _mcpService: IMCPService,
		@ITaskAwareModelRouter private readonly _modelRouter: ITaskAwareModelRouter,
		@IEditRiskScoringService private readonly _editRiskScoringService: IEditRiskScoringService,
		@IModelService private readonly _modelService: IModelService,
		@ICommandService private readonly _commandService: ICommandService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
		@IVibeAgentActivityLogService private readonly _agentActivityLog: IVibeAgentActivityLogService,
		@IVibeLLMJudgeService private readonly _llmJudgeService: IVibeLLMJudgeService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IVibeCheckpointCoordinator private readonly _checkpointCoordinator: IVibeCheckpointCoordinator,
		@IDialogService private readonly _dialogService: IDialogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IVibeTokenCostForecastService private readonly _costForecastService: IVibeTokenCostForecastService,
		@IVibeSessionMemoryService private readonly _sessionMemoryService: IVibeSessionMemoryService,
		@IVibeAgentTerritorialLockService private readonly _agentTerritorialLockService: IVibeAgentTerritorialLockService,
		@IVibeMentionService private readonly _mentionService: IVibeMentionService,
		@IVibeSearchContextService private readonly _searchContextService: IVibeSearchContextService,
		@IVibeAIDebuggingService private readonly _aiDebuggingService: IVibeAIDebuggingService,
		@IVibeContextGuardService private readonly _contextGuardService: IVibeContextGuardService,
		@IVibeExternalAccessService private readonly _externalAccessService: IVibeExternalAccessService,
		@IVibeNotifySoundService private readonly _notifySoundService: IVibeNotifySoundService,
		@IVibeDesktopNotificationService private readonly _desktopNotificationService: IVibeDesktopNotificationService,
	) {
		super();
		this.state = { allThreads: {}, currentThreadId: null as unknown as string, openTabIds: [] }; // default state
		// When set for a thread, the next call to _shouldGeneratePlan will return false and clear the flag
		this._suppressPlanOnceByThread = {};

		// Flush the debounced thread write BEFORE the storage layer persists (shutdown / periodic
		// save) and on dispose, so a buffered write inside the debounce window is never lost.
		this._register(this._storageService.onWillSaveState(() => this._flushStoreThreads()));
		this._register(toDisposable(() => this._flushStoreThreads()));

		const readThreads = this._readAllThreads() || {};

		const allThreads = readThreads;
		// Restore open chat tabs, dropping any whose thread no longer exists (deleted elsewhere) OR is
		// empty (stale "Новый чат" leftovers — e.g. the locked empty tab from the pre-View layout). The
		// single current empty thread is re-added by openNewThread() below, so there's never more than one.
		const restoredTabs = this._readOpenTabIds().filter(id => (allThreads[id]?.messages.length ?? 0) > 0);
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
			openTabIds: restoredTabs,
		};

		// Reset ContextGuard counters when the user switches to a different
		// chat thread (or opens a new one). Without this the status bar would
		// keep showing the previous thread's usage % until the next message
		// is actually sent in the new thread. convertToLLMMessageService
		// will re-populate with the real value on that next request.
		// Wiring lives here (not in vibeContextGuardService.ts) because the
		// reverse direction would close a cyclic module graph through
		// convertToLLMMessageService.
		//
		// IMPORTANT: onDidChangeCurrentThread fires on EVERY _setState (it doubles as a
		// generic "state changed" signal for React), so it fires on every message/tool-
		// result added mid-turn — not only on real thread switches. Dedupe on the actual
		// thread id, otherwise the guard was reset to 0 (and re-populated) several times
		// per agent turn, flickering the context indicator and spamming "Reset (thread
		// changed)" in the logs.
		let _lastGuardedThreadId = this.state.currentThreadId;
		this._register(this.onDidChangeCurrentThread(() => {
			const cur = this.state.currentThreadId;
			if (cur !== _lastGuardedThreadId) {
				_lastGuardedThreadId = cur;
				this._contextGuardService.reset();
			}
		}));

		// always be in a thread
		this.openNewThread();


		// keep track of user-modified files

	}

	// If true for a thread, suppress plan generation once for the next user message
	private _suppressPlanOnceByThread: Record<string, boolean>;

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId;
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const s = await thread.state.mountedInfo?.whenMounted;
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus();
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId;
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const s = await thread.state.mountedInfo?.whenMounted;
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur();
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState;
		this._onDidChangeCurrentThread.fire();
	};
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string, openTabIds: [] }; // see constructor
		this._storeOpenTabIds([]);
		this.openNewThread();
		this._onDidChangeCurrentThread.fire();
	};

	// !!! this is important for properly restoring URIs and images from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				// `URI.revive` is the cheaper restore path — no full parse, just
				// re-establishes the prototype/methods on the existing object shape.
				// `URI.from` would re-parse the components. For thread restore that
				// can replay hundreds of URIs on workspace open, the difference adds
				// up. Switch is safe because $mid:1 already guarantees a properly
				// shaped URI literal from `JSON.stringify(uri.toJSON())`.
				return URI.revive(value);
			}
			// Restore Uint8Array from base64 string for image data
			// Only process 'data' keys that are directly under image attachment objects
			// Check key === 'data' to match image attachment structure
			if (key === 'data') {
				if (typeof value === 'string' && value.startsWith('__base64__:')) {
					// Handle base64 string format (the normal case)
					try {
						const base64 = value.substring(11); // Remove '__base64__:' prefix
						const binaryString = atob(base64);
						const bytes = new Uint8Array(binaryString.length);
						for (let i = 0; i < binaryString.length; i++) {
							bytes[i] = binaryString.charCodeAt(i);
						}
						return bytes;
					} catch (e) {
						vibeLog.error('chatThread', 'Failed to decode base64 image data in storage reviver', e);
						return value; // Return original value on error
					}
				} else if (Array.isArray(value)) {
					// Handle case where it's already an array but not Uint8Array
					// Only convert if it looks like byte data (all numbers 0-255)
					if (value.length > 0 && value.every((v: unknown) => typeof v === 'number' && v >= 0 && v <= 255)) {
						return new Uint8Array(value as number[]);
					}
				}
				// For objects, don't try to convert here - let it be handled later if needed
				// This prevents infinite recursion and unexpected conversions
			}
			return value;
		});
	}

	// Tool-result SIZE cap, resolved from config with defensive clamps. Bounds how large a
	// single stored tool-result may be once it ages past the recent window — the dominant
	// renderer/disk memory cost on long sessions (real store: ~40MB, `content` 11MB).
	private _resolveToolResultCap(): { maxChars: number; keepRecent: number } {
		const kb = Math.max(4, Math.min(2048, this._configurationService.getValue<number>('vibeide.chat.maxStoredToolResultKB') ?? 24));
		const keepRecent = Math.max(0, Math.min(200, this._configurationService.getValue<number>('vibeide.chat.keepRecentFullToolResults') ?? 16));
		return { maxChars: kb * 1024, keepRecent };
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null;
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		// One-time cleanup on load: cap oversized OLD tool-results across ALL threads so the
		// historical baseline doesn't sit in renderer memory at full size. Recent results per
		// thread stay verbatim. The capped state is re-persisted on the next mutation.
		const { maxChars, keepRecent } = this._resolveToolResultCap();
		let totalCapped = 0, totalKbCut = 0;
		for (const id of Object.keys(threads)) {
			const t = threads[id];
			if (!t) { continue; }
			const capped = capToolResultSizes(t.messages, maxChars, keepRecent);
			if (capped) {
				threads[id] = { ...t, messages: capped.messages };
				totalCapped += capped.cappedCount;
				totalKbCut += capped.charsCut / 1024;
			}
		}
		if (totalCapped > 0) {
			vibeLog.info('chatThread', `Load: capped ${totalCapped} old tool-result(s) across threads (~${totalKbCut | 0} KB) to bound renderer memory (keepRecent=${keepRecent}, maxKB=${(maxChars / 1024) | 0}).`);
		}

		return threads;
	}

	private _storeAllThreads(threads: ChatThreads) {
		// Coalesce: buffer the latest state, write once per debounce window instead of
		// re-serializing the whole store on every mutation. `schedule()` only on the FIRST
		// change of a burst (bounds the max delay to STORE_THREADS_DEBOUNCE_MS); later changes
		// just update the buffer and ride the already-armed timer.
		this._pendingThreadsToStore = threads;
		if (!this._storeThreadsScheduler.isScheduled()) {
			this._storeThreadsScheduler.schedule();
		}
	}

	private _flushStoreThreads() {
		const threads = this._pendingThreadsToStore;
		if (threads === undefined) { return; }
		this._pendingThreadsToStore = undefined;
		// Convert Uint8Array image data to base64 before serializing
		const serializedThreads = JSON.stringify(threads, (key, value) => {
			// Convert Uint8Array to base64 string for storage
			if (key === 'data' && value instanceof Uint8Array) {
				// Convert Uint8Array to base64
				const chunkSize = 0x8000; // 32KB chunks to avoid stack overflow
				let binaryString = '';
				for (let i = 0; i < value.length; i += chunkSize) {
					const chunk = value.slice(i, i + chunkSize);
					binaryString += String.fromCharCode(...chunk);
				}
				const base64 = btoa(binaryString);
				return `__base64__:${base64}`;
			}
			return value;
		});
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}

	// ── Open chat tabs (multi-chat) ──────────────────────────────────────────────
	private _readOpenTabIds(): string[] {
		const s = this._storageService.get(OPEN_TAB_IDS_KEY, StorageScope.WORKSPACE);
		if (!s) { return []; }
		try {
			const arr = JSON.parse(s);
			return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
		} catch { return []; }
	}
	private _storeOpenTabIds(ids: string[]) {
		this._storageService.store(OPEN_TAB_IDS_KEY, JSON.stringify(ids), StorageScope.WORKSPACE, StorageTarget.USER);
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		};

		this.state = newState;

		this._onDidChangeCurrentThread.fire();


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId;
		const streamState = this.streamState[threadId];
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages;
			const lastMessage = messages && messages[messages.length - 1];
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request') { this._setStreamState(threadId, { isRunning: 'awaiting_user', }); }

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName });
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) { return; }

		let whenMountedResolver: (w: WhenMounted) => void;
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res);

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w);
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo;
					if (mountInfo) { mountInfo.mountedIsResolvedRef.current = true; }
				},
			}
		}, true); // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		const prior = this.streamState[threadId];
		this.streamState[threadId] = state;

		// Notification sound on the single funnel: fire when the thread transitions into a
		// "waiting for the user / work not proceeding" state. All gates (enabled, per-event,
		// focus, debounce) live in the sound service. Cheap: the vast majority of calls are
		// LLM→LLM and fail the guards below immediately.
		this._maybeNotifyOnStreamTransition(threadId, prior?.isRunning, state);

		// Track the wall-clock moment a thread entered any running state, so the
		// stuck-state recovery in _addUserMessageAndStreamResponse can decide
		// whether to wait or force-clear. Cleared when state goes back to
		// undefined or idle (terminal states from the user's perspective).
		const isActive = state?.isRunning === 'preparing'
			|| state?.isRunning === 'LLM'
			|| state?.isRunning === 'tool'
			|| state?.isRunning === 'awaiting_user';
		if (isActive) {
			if (!this._streamStateSetAt.has(threadId)) {
				this._streamStateSetAt.set(threadId, Date.now());
			}
		} else {
			this._streamStateSetAt.delete(threadId);
		}

		// Clear the submit-level watchdog only when the stream has truly reached the
		// network call — i.e. transitioned past 'preparing' to LLM/tool/awaiting_user/idle.
		// We do NOT clear on 'preparing' itself: preparation can still hang for a long
		// time AFTER preparing-state is set (router selection, prompt prep, token counting,
		// sendLLMMessage setup). Those hangs were not previously covered by any watchdog.
		// Once we hit LLM, the stream-level hardStallTimer (in _runChatAgent) takes over.
		const isPostPreparation = state?.isRunning === 'LLM' || state?.isRunning === 'tool' || state?.isRunning === 'awaiting_user' || state?.isRunning === 'idle';
		if (isPostPreparation) {
			const submitTimer = this._submitWatchdogByThread.get(threadId);
			if (submitTimer !== undefined) {
				clearTimeout(submitTimer);
				this._submitWatchdogByThread.delete(threadId);
			}
		}

		// Throttle updates during streaming to reduce React re-render frequency
		// Batch updates using requestAnimationFrame for smoother performance
		const isStreaming = state?.isRunning === 'LLM';

		if (isStreaming) {
			// During streaming, batch updates using requestAnimationFrame
			this._pendingStreamStateUpdates.set(threadId, state);

			if (this._streamStateRafId === undefined) {
				this._streamStateRafId = getActiveWindow().requestAnimationFrame(() => {
					// Fire all pending updates in a single batch
					for (const [tid] of this._pendingStreamStateUpdates) {
						this._onDidChangeStreamState.fire({ threadId: tid });
					}
					this._pendingStreamStateUpdates.clear();
					this._streamStateRafId = undefined;
				});
			}
		} else {
			// For non-streaming updates (idle, error, etc.), fire immediately
			// Also clear any pending updates for this thread
			this._pendingStreamStateUpdates.delete(threadId);
			this._onDidChangeStreamState.fire({ threadId });
		}
	}

	// Fire a notification sound when a thread transitions into a "waiting for the user / work not
	// proceeding" state. Two cases, both reached through the single _setStreamState funnel:
	//   - awaiting_user: model asked a question / wants plan confirmation (unambiguous transition).
	//   - run end (→ undefined): the run had been progressing and now stops. Skipped for error
	//     ends (already surfaced in UI) and for user-initiated/non-terminal clears inside the
	//     suppression window (abort, cost-decline, hard-stall auto-retry). Complete vs stalled is
	//     read from the last message (agentStoppedNoToolCall marks the «Продолжить» stall).
	private _maybeNotifyOnStreamTransition(threadId: string, priorIsRunning: IsRunningType, next: ThreadStreamState[string]): void {
		const nextIsRunning = next?.isRunning;

		if (nextIsRunning === 'awaiting_user') {
			if (priorIsRunning !== 'awaiting_user') {
				this._notifySoundService.playForEvent('awaiting_user');
				this._desktopNotificationService.notifyForEvent('awaiting_user');
			}
			return;
		}

		if (nextIsRunning === undefined && priorIsRunning !== undefined) {
			if (next?.error) { return; }
			if (Date.now() < (this._suppressStopSoundUntil.get(threadId) ?? 0)) { return; }
			const thread = this.state.allThreads[threadId];
			const last = thread?.messages[thread.messages.length - 1];
			const stalled = last?.role === 'assistant' && last.agentStoppedNoToolCall === true;
			const event: NotifySoundEvent = stalled ? 'stalled' : 'complete';
			this._notifySoundService.playForEvent(event);
			this._desktopNotificationService.notifyForEvent(event);
			// Same genuine-end gate as the sound (error / abort / suppression / awaiting-user already filtered
			// above): if the user queued context mid-run that never drained, send it now as a fresh turn.
			this._autoSendPendingInjectionsAsNewTurn(threadId);
		}
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat';
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName];
		// Skip "auto" - it's not a real provider
		const modelSelectionOptions = modelSelection && !(modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto')
			? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]
			: undefined;
		return { modelSelection, modelSelectionOptions };
	};

	/** Resolve a routing-rule modelId ("provider/name" or plain "name") to a ModelSelection, or null if not found. */
	private _findModelSelectionForId(modelId: string): ModelSelection | null {
		const slashIdx = modelId.indexOf('/');
		if (slashIdx > 0) {
			const providerName = modelId.slice(0, slashIdx) as ProviderName;
			const modelName = modelId.slice(slashIdx + 1);
			const models = this._settingsService.state.settingsOfProvider[providerName]?.models ?? [];
			if (models.some(m => m.modelName === modelName && !m.isHidden)) {
				return { providerName, modelName };
			}
			return null;
		}
		// Plain model name: scan providers in preference order.
		for (const providerName of autoModelFallbackProviderOrder) {
			const settings = this._settingsService.state.settingsOfProvider[providerName];
			if (!settings?._didFillInProviderSettings) { continue; }
			const found = settings.models?.find(m => m.modelName === modelId && !m.isHidden);
			if (found) {
				return { providerName, modelName: modelId };
			}
		}
		return null;
	}

	/**
	 * Auto-select model based on task context
	 * Falls back to user's manual selection if they've set one
	 */
	private async _autoSelectModel(
		userMessage: string,
		images?: ChatImageAttachment[],
		pdfs?: ChatPDFAttachment[]
	): Promise<ModelSelection | null> {
		const featureName: FeatureName = 'Chat';
		const userManualSelection = this._settingsService.state.modelSelectionOfFeature[featureName];

		// If user has a specific model selected (not "Auto"), respect it
		if (userManualSelection && !(userManualSelection.providerName === 'auto' && userManualSelection.modelName === 'auto')) {
			return userManualSelection;
		}

		// Detect task type from message and attachments
		const taskType = this._detectTaskType(userMessage, images, pdfs);
		const hasImages = images && images.length > 0;
		const hasPDFs = pdfs && pdfs.length > 0;
		const hasCode = this._detectCodeInMessage(userMessage);

		// Detect complexity indicators
		const lowerMessage = userMessage.toLowerCase().trim();
		const reasoningKeywords = ['explain why', 'analyze', 'compare and contrast', 'evaluate', 'critique', 'reasoning', 'logical', 'deduce', 'infer', 'conclusion', 'argument', 'thesis', 'hypothesis', 'theoretical', 'conceptual'];
		const complexAnalysisKeywords = ['complex', 'sophisticated', 'nuanced', 'detailed analysis', 'deep understanding', 'comprehensive', 'thorough'];

		// Codebase questions require complex reasoning (understanding structure, relationships, etc.)
		// Use the same detection logic as _detectTaskType for consistency
		const codebaseQuestionPatterns = [
			/\b(codebase|code base|repository|repo|project)\b/,
			/\b(architecture|structure|organization|layout)\b.*\b(project|codebase|repo|code)\b/,
			/^what\s+(is|does|are)\s+(my|this|the)\s+(codebase|repo|project|code|app|application)/,
			/\bhow\s+many\s+(endpoint|endpoints|api|apis|route|routes|file|files|function|functions|class|classes|component|components|module|modules|service|services|controller|controllers)\b/i,
			/^(summarize|explain|describe|overview|analyze)\s+(my|this|the)\s+(codebase|repo|project|code)/,
		];
		const codebaseIndicators = ['codebase', 'code base', 'repository', 'repo', 'project structure', 'architecture', 'endpoint', 'api', 'route'];
		const questionStarters = ['what is', 'what does', 'how many', 'summarize', 'explain', 'describe', 'overview'];
		const matchesPattern = codebaseQuestionPatterns.some(pattern => pattern.test(lowerMessage));
		const hasCodebaseIndicator = codebaseIndicators.some(indicator => lowerMessage.includes(indicator));
		const startsWithQuestion = questionStarters.some(starter => lowerMessage.startsWith(starter));
		const isCodebaseQuestion = matchesPattern || (hasCodebaseIndicator && startsWithQuestion);

		const requiresComplexReasoning = isCodebaseQuestion || // Codebase questions need reasoning
			reasoningKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			complexAnalysisKeywords.some(keyword => lowerMessage.includes(keyword));
		const isLongMessage = userMessage.length > 500;

		// Privacy/offline mode: removed restriction for images/PDFs
		// Images/PDFs now always use auto selection (remote models allowed)
		const globalSettings = this._settingsService.state.globalSettings;
		const requiresPrivacy = false;

		// Estimate context size needed for codebase questions
		// Codebase questions often need to process many files, so estimate higher context needs
		let estimatedContextSize: number | undefined = undefined;
		if (isCodebaseQuestion) {
			// Codebase questions typically need:
			// - Base message: ~500 tokens
			// - System message + repo context: ~2000 tokens (from repo indexer)
			// - Multiple file contexts: ~5000-15000 tokens (depending on codebase size)
			// - Response space: ~4000 tokens
			// Total: ~12k-22k tokens minimum, but prefer models with 128k+ for better understanding
			estimatedContextSize = 20000; // Conservative estimate - prefer models with large context
		} else if (requiresComplexReasoning || isLongMessage) {
			// Complex reasoning tasks may need more context
			estimatedContextSize = Math.max(8000, Math.ceil(userMessage.length / 2)); // Rough estimate
		}

		// Detect additional task-specific flags
		const isDebuggingTask = this._detectDebuggingTask(lowerMessage, hasCode);
		const isCodeReviewTask = this._detectCodeReviewTask(lowerMessage);
		const isTestingTask = this._detectTestingTask(lowerMessage);
		const isDocumentationTask = this._detectDocumentationTask(lowerMessage);
		const isPerformanceTask = this._detectPerformanceTask(lowerMessage);
		const isSecurityTask = this._detectSecurityTask(lowerMessage);
		const isSimpleQuestion = this._detectSimpleQuestion(userMessage, lowerMessage);
		const isMathTask = this._detectMathTask(lowerMessage);
		const isMultiLanguageTask = this._detectMultiLanguageTask(lowerMessage);
		const isMultiStepTask = this._detectMultiStepTask(lowerMessage);

		// Build task context
		// Enable low-latency preference for simple questions to improve TTFS
		// More aggressive: enable for simple questions OR when task doesn't require complex reasoning
		const preferLowLatency = (isSimpleQuestion ||
			(!requiresComplexReasoning &&
				!hasImages &&
				!hasPDFs &&
				!isLongMessage &&
				!isMultiStepTask &&
				!isCodebaseQuestion &&
				taskType === 'chat')); // Only for general chat, not code/vision tasks

		const context: TaskContext = {
			taskType,
			hasImages,
			hasPDFs,
			hasCode,
			contextSize: estimatedContextSize,
			requiresPrivacy,
			preferLowLatency, // Auto-enable for simple queries to improve TTFS
			preferLowCost: false, // Could be a setting
			userOverride: null, // No override when in auto mode
			requiresComplexReasoning,
			isLongMessage,
			isDebuggingTask,
			isCodeReviewTask,
			isTestingTask,
			isDocumentationTask,
			isPerformanceTask,
			isSecurityTask,
			isSimpleQuestion,
			isMathTask,
			isMultiLanguageTask,
			isMultiStepTask,
		};

		try {
			const routingDecision = await this._modelRouter.route(context);

			// Handle abstain/clarify
			if (routingDecision.shouldAbstain && routingDecision.abstainReason) {
				this._notificationService.info(routingDecision.abstainReason);
				// Return null to indicate we should not proceed
				return null;
			}

			// Log routing decision in dev mode (or always for codebase questions to help debug)
			if (globalSettings.imageQADevMode || isCodebaseQuestion) {
				const logData = {
					selected: `${routingDecision.modelSelection.providerName}/${routingDecision.modelSelection.modelName}`,
					confidence: routingDecision.confidence,
					reasoning: routingDecision.reasoning,
					qualityTier: routingDecision.qualityTier,
					timeoutMs: routingDecision.timeoutMs,
					userOverride: userManualSelection ? 'yes' : 'no',
					isCodebaseQuestion,
					contextSize: estimatedContextSize,
					taskType,
					requiresComplexReasoning,
					hasCode,
				};
				vibeLog.info('chatThread', '[Auto Model Select]', JSON.stringify(logData, null, 2));

				// Warn if local model selected for codebase question
				if (isCodebaseQuestion && routingDecision.modelSelection.providerName === 'ollama') {
					vibeLog.warn('chatThread', '[Auto Model Select] WARNING: Local model selected for codebase question!', logData);
				}
			}

			// Store routing decision for later outcome tracking
			// We'll track the outcome when the message is actually sent
			return routingDecision.modelSelection;
		} catch (error) {
			vibeLog.error('chatThread', '[Auto Model Select] Error:', error);
			// Fall back to user's manual selection or null
			return userManualSelection;
		}
	}

	/**
	 * Get a fallback model when auto selection fails
	 * Returns the first available configured model, or null if none are available
	 */
	// Note: _getFallbackModel removed - use _settingsService.resolveAutoModelSelection() instead

	/**
	 * Check if a model supports vision/image inputs.
	 * Order: catalog-driven `supportsVision` override (set by RemoteCatalogService for aggregators
	 * like OpenRouter where modality info is per-model) → provider heuristics → name-based fallback.
	 */
	private _isModelVisionCapable(modelSelection: ModelSelection, capabilities: { supportsVision?: boolean } | undefined): boolean {
		// Authoritative when set: catalog-derived flag (OpenRouter, openAICompatible, etc.).
		// Distinguish explicit false from undefined — undefined falls through to heuristics.
		if (capabilities && typeof capabilities.supportsVision === 'boolean') {
			return capabilities.supportsVision;
		}

		const name = modelSelection.modelName.toLowerCase();
		const provider = modelSelection.providerName.toLowerCase();

		// Known vision-capable models
		if (provider === 'gemini') { return true; } // all Gemini models support vision
		if (provider === 'anthropic') {
			return name.includes('3.5') || name.includes('3.7') || name.includes('4') || name.includes('opus') || name.includes('sonnet');
		}
		if (provider === 'openai') {
			// GPT-5 series (all variants support vision)
			if (name.includes('gpt-5') || name.includes('gpt-5.1')) { return true; }
			// GPT-4.1 series
			if (name.includes('4.1')) { return true; }
			// GPT-4o series
			if (name.includes('4o')) { return true; }
			// o-series reasoning models (o1, o3, o4-mini support vision)
			if (name.startsWith('o1') || name.startsWith('o3') || name.startsWith('o4')) { return true; }
			// Legacy GPT-4 models
			if (name.includes('gpt-4')) { return true; }
		}
		if (provider === 'mistral') {
			// Pixtral models support vision
			if (name.includes('pixtral')) { return true; }
		}
		if (provider === 'ollama' || provider === 'vllm') {
			return name.includes('llava') || name.includes('bakllava') || name.includes('vision');
		}
		// Aggregators / OpenAI-compatible — without a catalog flag, fall back to the shared
		// substring whitelist (single source of truth in common/modelVisionHeuristics.ts).
		// Conservative: only well-known vision markers — anything else stays false to avoid
		// sending images into a text-only model and getting hallucinated descriptions.
		// `minimax` is the native (OpenAI-compatible) endpoint serving both text-only (M2) and
		// multimodal (M3) models, so vision is per-model just like an aggregator.
		if (provider === 'openrouter' || provider === 'opencode' || provider === 'opencodezen' || provider === 'openaicompatible' || provider === 'litellm' || provider === 'pollinations' || provider === 'minimax') {
			if (isVisionByNameHeuristic(modelSelection.modelName)) { return true; }
		}

		return false;
	}

	/**
	 * Detect task type from message content and attachments
	 * More conservative detection - only mark as specific task type if very clear
	 */
	private _detectTaskType(
		userMessage: string,
		images?: ChatImageAttachment[],
		pdfs?: ChatPDFAttachment[]
	): TaskType {
		const lowerMessage = userMessage.toLowerCase().trim();

		// PDF-specific tasks (always detect if PDFs present)
		if (pdfs && pdfs.length > 0) {
			return 'pdf';
		}

		// Vision tasks (always detect if images present)
		if (images && images.length > 0) {
			return 'vision';
		}

		// Codebase/repository questions - comprehensive detection
		// These questions require understanding the entire codebase structure
		const codebaseQuestionPatterns = [
			// Direct codebase/repo references
			/\b(codebase|code base|repository|repo|project)\b/,
			// Questions about structure/architecture
			/\b(architecture|structure|organization|layout)\b.*\b(project|codebase|repo|code)\b/,
			/\b(project|codebase|repo|code)\b.*\b(architecture|structure|organization|layout)\b/,
			// "What is" questions about the project
			/^what\s+(is|does|are)\s+(my|this|the)\s+(codebase|repo|project|code|app|application)/,
			/^what\s+(is|does|are)\s+(my|this|the)\s+\w+\s+(codebase|repo|project)/,
			// "How many" questions (endpoints, files, routes, etc.)
			/\bhow\s+many\s+(endpoint|api|route|file|function|class|component|module|service|controller)\b/i,
			// Summary/explanation requests
			/^(summarize|explain|describe|overview|analyze|break down)\s+(my|this|the)\s+(codebase|repo|project|code)/,
			// Questions about features/capabilities
			/\b(what|which|how)\s+(feature|capability|functionality|endpoint|api|route)\s+(does|has|supports?)\s+(my|this|the)\s+(codebase|repo|project|app)/i,
			// Questions about dependencies/tech stack
			/\b(what|which)\s+(technology|framework|library|dependency|package|stack)\s+(does|uses?|has)\s+(my|this|the)\s+(codebase|repo|project|app)/i,
		];

		const codebaseIndicators = [
			'codebase', 'code base', 'repository', 'repo', 'project structure', 'architecture',
			'endpoint', 'endpoints', 'api', 'apis', 'route', 'routes',
			'file structure', 'code organization', 'project layout',
		];

		const questionStarters = [
			'what is', 'what does', 'what are', 'what do',
			'how many', 'how does', 'how do',
			'summarize', 'explain', 'describe', 'overview', 'analyze',
			'which', 'where',
		];

		// Check if it matches codebase question patterns
		const matchesPattern = codebaseQuestionPatterns.some(pattern => pattern.test(lowerMessage));
		const hasCodebaseIndicator = codebaseIndicators.some(indicator => lowerMessage.includes(indicator));
		const startsWithQuestion = questionStarters.some(starter => lowerMessage.startsWith(starter));

		// Codebase question if:
		// 1. Matches a pattern, OR
		// 2. Has codebase indicator AND starts with a question word
		const isCodebaseQuestion = matchesPattern || (hasCodebaseIndicator && startsWithQuestion);

		if (isCodebaseQuestion) {
			return 'code'; // Use 'code' task type but we'll enhance scoring for codebase questions
		}

		// Implementation/action tasks - tasks that require creating or modifying code
		// These need good code generation models
		const implementationPatterns = [
			// Direct implementation requests
			/^(implement|create|add|build|make|set up|configure)\s+(a|an|the|my|this)?\s*\w+/,
			// Action verbs followed by code-related nouns
			/\b(implement|create|add|build|make|set up|configure|write|generate|develop)\s+(function|class|method|component|feature|endpoint|api|route|service|module|system|feature|functionality)\b/i,
			// "Implement X" or "Create X" patterns
			/\b(implement|create|add|build|make)\s+[a-z]+\s+(that|which|to|for)/i,
		];

		const implementationKeywords = [
			// Action verbs
			'write code', 'generate code', 'create function', 'implement class', 'fix bug',
			'refactor code', 'optimize code', 'debug', 'syntax error', 'compile error',
			'add function', 'create method', 'implement function',
			// Implementation-specific
			'create a', 'implement a', 'add a', 'build a', 'make a',
			'create new', 'implement new', 'add new', 'build new',
			'set up', 'set up a', 'configure', 'configure a',
			'develop', 'develop a', 'build out',
		];

		const hasImplementationPattern = implementationPatterns.some(pattern => pattern.test(lowerMessage));
		const hasImplementationKeyword = implementationKeywords.some(keyword => lowerMessage.includes(keyword));

		// Code tasks - check for actual code patterns or explicit code requests
		const hasCodeBlock = /```[\s\S]+?```/.test(userMessage) || /`[^`\n]{10,}`/.test(userMessage);

		// Implementation task if it matches patterns/keywords OR has code blocks
		if (hasCodeBlock || hasImplementationPattern || hasImplementationKeyword) {
			return 'code';
		}

		// Web search tasks - only if very explicit
		const explicitWebSearchKeywords = ['search the web', 'search online', 'look up online', 'google', 'duckduckgo', 'web search', 'search internet'];
		if (explicitWebSearchKeywords.some(keyword => lowerMessage.includes(keyword))) {
			return 'web_search';
		}

		// Default to general chat (prefers quality models)
		// Complexity detection (reasoning, long messages) is handled in _autoSelectModel
		// and passed to the router via TaskContext
		return 'chat';
	}

	/**
	 * Detect if message contains code
	 */
	private _detectCodeInMessage(message: string): boolean {
		// Simple heuristic: check for code-like patterns
		const codePatterns = [
			/```[\s\S]*?```/, // Code blocks
			/`[^`]+`/, // Inline code
			/function\s+\w+/, // Function declarations
			/class\s+\w+/, // Class declarations
			/import\s+.*from/, // Import statements
			/const\s+\w+\s*=/, // Const declarations
			/let\s+\w+\s*=/, // Let declarations
		];

		return codePatterns.some(pattern => pattern.test(message));
	}

	/**
	 * Detect debugging/error fixing tasks
	 */
	private _detectDebuggingTask(lowerMessage: string, hasCode: boolean): boolean {
		const debuggingKeywords = [
			'fix error', 'debug', 'why is this failing', 'error message', 'exception', 'stack trace',
			'why doesn\'t this work', 'not working', 'broken', 'crash', 'bug', 'fix bug',
			'troubleshoot', 'issue', 'problem', 'failing', 'failed', 'error', 'errors'
		];
		const errorPatterns = [
			/error\s+(message|occurred|happened|in|at)/i,
			/exception\s+(thrown|occurred|in|at)/i,
			/stack\s+trace/i,
			/why\s+(is|does|isn\'t|doesn\'t).*work/i,
			/why\s+(is|does).*fail/i,
		];

		return debuggingKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			errorPatterns.some(pattern => pattern.test(lowerMessage)) ||
			(hasCode && (lowerMessage.includes('error') || lowerMessage.includes('exception')));
	}

	/**
	 * Detect code review/refactoring tasks
	 */
	private _detectCodeReviewTask(lowerMessage: string): boolean {
		const reviewKeywords = [
			'review', 'refactor', 'improve code', 'code quality', 'best practices', 'clean up',
			'is this good code', 'how can i improve', 'refactor this', 'code review',
			'optimize', 'make it better', 'improve this', 'suggest improvements'
		];
		const reviewPatterns = [
			/review\s+(this|my|the)\s+(code|function|class|method)/i,
			/refactor\s+(this|my|the)/i,
			/how\s+(can|to)\s+(improve|refactor|optimize)/i,
			/is\s+(this|my|the)\s+(code|implementation)\s+(good|correct|proper)/i,
		];

		return reviewKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			reviewPatterns.some(pattern => pattern.test(lowerMessage));
	}

	/**
	 * Detect testing tasks
	 */
	private _detectTestingTask(lowerMessage: string): boolean {
		const testingKeywords = [
			'write test', 'add test', 'test coverage', 'unit test', 'integration test',
			'test for', 'how to test', 'create test', 'testing', 'test case', 'test suite',
			'write tests', 'add tests', 'test this', 'test the'
		];
		const testingPatterns = [
			/write\s+(a|an|the|unit|integration)\s+test/i,
			/add\s+(a|an|unit|integration)\s+test/i,
			/create\s+(a|an|unit|integration)\s+test/i,
			/test\s+(for|this|the|coverage)/i,
		];

		return testingKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			testingPatterns.some(pattern => pattern.test(lowerMessage));
	}

	/**
	 * Detect documentation tasks
	 */
	private _detectDocumentationTask(lowerMessage: string): boolean {
		const docKeywords = [
			'write doc', 'documentation', 'comment', 'explain code', 'readme', 'api doc',
			'document this', 'add comments', 'write readme', 'document', 'docs',
			'comment', 'comments', 'javadoc', 'jsdoc', 'docstring'
		];
		const docPatterns = [
			/write\s+(documentation|doc|readme|comments)/i,
			/add\s+(documentation|doc|comments|comment)/i,
			/document\s+(this|my|the)/i,
			/explain\s+(this|my|the)\s+(code|function|class)/i,
		];

		return docKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			docPatterns.some(pattern => pattern.test(lowerMessage));
	}

	/**
	 * Detect performance optimization tasks
	 */
	private _detectPerformanceTask(lowerMessage: string): boolean {
		const perfKeywords = [
			'optimize', 'performance', 'speed up', 'make faster', 'bottleneck', 'profiling',
			'how to optimize', 'performance issue', 'slow', 'faster', 'speed', 'efficiency',
			'optimization', 'improve performance', 'performance problem'
		];
		const perfPatterns = [
			/optimize\s+(this|my|the|for)/i,
			/performance\s+(issue|problem|optimization|improvement)/i,
			/how\s+to\s+(optimize|improve\s+performance|speed\s+up)/i,
			/make\s+(this|it|the)\s+faster/i,
		];

		return perfKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			perfPatterns.some(pattern => pattern.test(lowerMessage));
	}

	/**
	 * Detect security-related tasks
	 */
	private _detectSecurityTask(lowerMessage: string): boolean {
		const securityKeywords = [
			'security', 'vulnerability', 'secure', 'authentication', 'authorization', 'encryption',
			'is this secure', 'security issue', 'vulnerable', 'vulnerabilities', 'secure this',
			'security best practices', 'security review', 'security audit', 'xss', 'csrf', 'sql injection'
		];
		const securityPatterns = [
			/security\s+(issue|problem|vulnerability|review|audit)/i,
			/is\s+(this|my|the)\s+secure/i,
			/how\s+to\s+secure/i,
			/make\s+(this|it|the)\s+secure/i,
		];

		return securityKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			securityPatterns.some(pattern => pattern.test(lowerMessage));
	}

	/**
	 * Detect simple/quick questions
	 * More aggressive detection to enable low-latency routing for better UX
	 */
	private _detectSimpleQuestion(message: string, lowerMessage: string): boolean {
		// Exclude complex tasks first
		if (lowerMessage.includes('codebase') ||
			lowerMessage.includes('repository') ||
			lowerMessage.includes('architecture') ||
			lowerMessage.includes('analyze') ||
			lowerMessage.includes('refactor') ||
			lowerMessage.includes('implement') ||
			lowerMessage.includes('debug') ||
			lowerMessage.includes('error') ||
			lowerMessage.includes('fix') ||
			lowerMessage.includes('review')) {
			return false;
		}

		// Simple questions are typically:
		// 1. Short to medium length (< 200 chars)
		// 2. Start with question words
		// 3. Don't require codebase analysis
		if (message.length < 200) {
			const simpleQuestionStarters = [
				'what is', 'what does', 'what are', 'what do',
				'how do i', 'how to', 'how does', 'how can',
				'explain', 'tell me', 'describe',
				'when', 'where', 'why', 'who',
				'can you', 'could you', 'would you'
			];
			const isQuestion = simpleQuestionStarters.some(starter => lowerMessage.startsWith(starter));

			// Also check for simple question patterns
			const simplePatterns = [
				/^what\s+(is|does|are|do)\s+/,
				/^how\s+(do|does|can|to)\s+/,
				/^explain\s+/,
				/^tell\s+me\s+/,
				/^describe\s+/
			];
			const matchesPattern = simplePatterns.some(pattern => pattern.test(lowerMessage));

			return (isQuestion || matchesPattern) && message.length < 200;
		}

		return false;
	}

	/**
	 * Detect mathematical/computational tasks
	 */
	private _detectMathTask(lowerMessage: string): boolean {
		const mathKeywords = [
			'calculate', 'math', 'algorithm', 'formula', 'compute', 'statistics',
			'calculation', 'mathematical', 'equation', 'solve', 'numerical', 'arithmetic'
		];
		const mathPatterns = [
			/calculate\s+(this|the|a|an)/i,
			/solve\s+(this|the|a|an|for)/i,
			/math\s+(problem|question|calculation)/i,
			/formula\s+(for|to|of)/i,
		];

		return mathKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			mathPatterns.some(pattern => pattern.test(lowerMessage));
	}

	/**
	 * Detect multi-language codebase tasks
	 */
	private _detectMultiLanguageTask(lowerMessage: string): boolean {
		const multiLangKeywords = [
			'translate code', 'convert to', 'port to', 'rewrite in', 'convert from',
			'multiple languages', 'different language', 'language conversion'
		];
		const multiLangPatterns = [
			/translate\s+(code|this|from|to)/i,
			/convert\s+(code|this|from|to)/i,
			/port\s+(to|from)/i,
			/rewrite\s+in/i,
		];

		return multiLangKeywords.some(keyword => lowerMessage.includes(keyword)) ||
			multiLangPatterns.some(pattern => pattern.test(lowerMessage));
	}

	/**
	 * Detect complex multi-step tasks
	 */
	private _detectMultiStepTask(lowerMessage: string): boolean {
		// Multiple action verbs or "and" in requests indicate multi-step tasks
		const actionVerbs = ['implement', 'create', 'add', 'build', 'make', 'set up', 'configure', 'write', 'generate', 'develop', 'fix', 'update', 'modify'];
		const verbCount = actionVerbs.filter(verb => lowerMessage.includes(verb)).length;

		// Multiple "and" conjunctions suggest multiple steps
		const andCount = (lowerMessage.match(/\sand\s/g) || []).length;

		// Multi-step indicators
		const multiStepKeywords = ['then', 'after that', 'next', 'also', 'additionally', 'furthermore', 'step', 'steps'];
		const hasMultiStepKeywords = multiStepKeywords.some(keyword => lowerMessage.includes(keyword));

		return verbCount >= 2 || andCount >= 2 || hasMultiStepKeywords;
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages;
		if (!messages) { return false; }
		const lastMsg = messages[messages.length - 1];
		if (!lastMsg) { return false; }

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool);
			return true;
		}
		return false;
	};
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool);
		if (swapped) { return; }
		this._addMessageToThread(threadId, tool);
	};

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1];
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) { return; } // should never happen

		// A manual approval is a live "user is present and in control" signal — the session token
		// gate exists to stop UNATTENDED runaway runs, so blocking a supervised session at the 2M
		// cap is pure friction. Reset the counter on each approval; flows with no manual clicks
		// (autopilot, or per-type auto-approve covering every tool) keep the gate intact.
		try { this._tokenBudgetService.resetSession(); } catch { /* gate reset is best-effort */ }

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg;

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		);
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1];

		let params: ToolCallParams<ToolName>;
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params;
		}
		else { return; }

		const { name, id, rawParams, mcpServerName } = lastMsg;

		const errorMessage = this.toolErrMsgs.rejected;
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName });
		this._setStreamState(threadId, undefined);
	}

	// Plan management methods
	// NOTE: Plans are not auto-generated yet. They need to be created manually or via LLM generation.
	// To test the UI, you can create a plan manually like:
	// chatThreadService.addTestPlan({ threadId: 'xxx', summary: 'Test plan', steps: [...] })

	/** Filesystem MVP: write Agent plan markdown + machine-readable steps next to persisted plans convention (`.vibe/plans/`). */
	private async _persistApprovedPlanArtifact(params: {
		threadId: string;
		messageIdx: number;
		plan: PlanMessage;
	}): Promise<{ planId: string } | undefined> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			vibeLog.debug('chatThread', 'Persist plan: no workspace folder');
			return undefined;
		}
		const workspaceFolder = folders[0].uri;
		const existingPersistedId = params.plan.persistedPlanId?.trim();
		if (existingPersistedId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existingPersistedId)) {
			return { planId: existingPersistedId };
		}
		let written: { planId: string; uri: URI } | undefined;
		try {
			written = await this._persistedPlanService.writeApprovedAgentPlan({
				workspaceFolder,
				threadId: params.threadId,
				messageIdx: params.messageIdx,
				plan: params.plan,
			});
		} catch (e) {
			if (e instanceof Error && e.message.includes('Plan file blocked')) {
				throw e;
			}
			vibeLog.warn('chatThread', 'Persist plan artifact failed:', e);
			return undefined;
		}
		if (!written) {
			return undefined;
		}
		const { planId } = written;
		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({
				ts: Date.now(),
				action: 'plan_started',
				ok: true,
				meta: { planId, threadId: params.threadId, stepsTotal: params.plan.steps.length },
			}).catch(() => { });
		}
		return { planId };
	}

	approvePlan(opts: { threadId: string; messageIdx: number }): void {
		void this._approvePlanAndRun(opts).catch(err => vibeLog.error('chatThread', 'approvePlan failed', err));
	}

	private async _approvePlanAndRun(opts: { threadId: string; messageIdx: number }): Promise<void> {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const planBlob = [
			plan.summary,
			...plan.steps.map(step =>
				[step.description, ...(step.tools ?? []), ...(step.files ?? [])].filter(Boolean).join(' ')
			),
		].join('\n');
		const opinion = this._llmJudgeService.reviewPlanHeuristic(planBlob);

		const updatedPlan: PlanMessage = {
			...plan,
			approvalState: 'approved',
			approvedAt: Date.now(),
			executionStartTime: Date.now(),
			steps: plan.steps.map(step => ({
				...step,
				status: step.disabled ? 'skipped' as StepStatus : (step.status || 'queued' as StepStatus)
			}))
		};

		const planForThread: PlanMessage = opinion.verdict !== 'looks_ok'
			? {
				...updatedPlan,
				secondOpinion: { verdict: opinion.verdict, message: opinion.message, reviewedAt: Date.now() },
			}
			: { ...updatedPlan, secondOpinion: undefined };

		if (opinion.verdict !== 'looks_ok') {
			this._notificationService.notify({
				severity: opinion.verdict === 'security_concern' ? Severity.Warning : Severity.Info,
				message: localize('vibeide.planSecondOpinion', 'Совещательное ревью плана: {0}', opinion.message),
			});
		}

		let persistedMeta: { planId: string } | undefined;
		try {
			persistedMeta = await this._persistApprovedPlanArtifact({
				threadId: opts.threadId,
				messageIdx: opts.messageIdx,
				plan: planForThread,
			});
		} catch (err) {
			if (err instanceof Error && err.message.includes('Plan file blocked')) {
				this._notificationService.notify({
					severity: Severity.Error,
					message: err.message,
				});
				return;
			}
			vibeLog.warn('chatThread', 'Persist plan artifact failed:', err);
		}

		const mergedPlan: PlanMessage = persistedMeta
			? { ...planForThread, persistedPlanId: persistedMeta.planId }
			: planForThread;

		const folders = this._workspaceContextService.getWorkspace().folders;
		if (persistedMeta?.planId && folders.length > 0) {
			const lease = await this._persistedPlanService.acquireOrRefreshExecutionLease(folders[0].uri, {
				planId: persistedMeta.planId,
				threadId: opts.threadId,
				windowId: this._tryGetWorkbenchWindowId(),
				holderNonce: this._ensureExecutionLeaseHolderNonce(),
			});
			if (!lease.ok) {
				this._notificationService.notify({
					severity: Severity.Warning,
					message: localize(
						'vibeide.planExecutionLockBusy',
						'Another chat session is already executing this plan (thread {0}). Stop it, wait for the lease to expire (~2 min idle), or use the plan dashboard to take over a stale run.',
						lease.holderThreadId.slice(0, 8),
					),
				});
				return;
			}
		}

		this._editMessageInThread(opts.threadId, opts.messageIdx, mergedPlan);
		// CRITICAL: Invalidate plan cache so checkPlanGenerated() sees the updated approvalState
		this._planCache.delete(opts.threadId);

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId: opts.threadId, ...this._currentModelSelectionProps() }),
			opts.threadId,
		);
	}

	rejectPlan(opts: { threadId: string; messageIdx: number }) {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const wf = this._primaryWorkspaceFolderUri();
		if (wf && plan.persistedPlanId) {
			this._planBindingRegistry.unregister(wf, plan.persistedPlanId, opts.threadId);
		}
		this._taskDecompositionService.clearPersistedPlanTask(opts.threadId);
		this._clearPersistedExecutionLease(plan.persistedPlanId);
		const updatedPlan: PlanMessage = {
			...plan,
			approvalState: 'aborted'
		};
		this._editMessageInThread(opts.threadId, opts.messageIdx, updatedPlan);
		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({
				ts: Date.now(),
				action: 'plan_failed',
				ok: false,
				meta: { threadId: opts.threadId, reason: 'aborted' },
			}).catch(() => { });
		}
	}

	editPlan(opts: { threadId: string; messageIdx: number; updatedPlan: PlanMessage }) {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		this._editMessageInThread(opts.threadId, opts.messageIdx, opts.updatedPlan);
	}

	toggleStepDisabled(opts: { threadId: string; messageIdx: number; stepNumber: number }) {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const updatedPlan: PlanMessage = {
			...plan,
			steps: plan.steps.map(step =>
				step.stepNumber === opts.stepNumber
					? { ...step, disabled: !step.disabled }
					: step
			)
		};
		this._editMessageInThread(opts.threadId, opts.messageIdx, updatedPlan);
	}

	toggleMessagePinned(opts: { threadId: string; messageIdx: number }) {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		// Only user/assistant messages carry `pinned` (and are meaningful to keep verbatim).
		if (!message || (message.role !== 'user' && message.role !== 'assistant')) { return; }
		this._editMessageInThread(opts.threadId, opts.messageIdx, { ...message, pinned: !message.pinned });
	}

	reorderPlanSteps(opts: { threadId: string; messageIdx: number; newStepOrder: number[] }) {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const stepMap = new Map(plan.steps.map(s => [s.stepNumber, s]));
		const reorderedSteps = opts.newStepOrder
			.map(stepNum => stepMap.get(stepNum))
			.filter((s): s is PlanStep => s !== undefined)
			.map((step, idx) => ({ ...step, stepNumber: idx + 1 }));

		const updatedPlan: PlanMessage = {
			...plan,
			steps: reorderedSteps
		};
		this._editMessageInThread(opts.threadId, opts.messageIdx, updatedPlan);
	}

	/**
	 * Called from `_runChatAgent` when `checkPlanGenerated()` blocks execution. Replaces
	 * the previous silent `isRunning: 'idle'` exit with a visible recovery flow:
	 *   - inline error in chat (red ErrorDisplay with `recoverable: 'dismissPlan'` marker
	 *     so the chat UI renders a permanent "Сбросить план и продолжить" button)
	 *   - toast notification with the same action (auto-discoverable, but the button in
	 *     chat remains even after the user closes the toast)
	 */
	private _surfacePendingPlanGate(threadId: string): void {
		this._setStreamState(threadId, {
			isRunning: undefined,
			error: {
				message: localize('vibeide.chatThread.pendingPlanGate', 'Незавершённый план блокирует отправку сообщений в этом чате. Сбросьте его, чтобы продолжить.'),
				fullError: null,
				recoverable: 'dismissPlan',
			},
		});
		try {
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('vibeide.chatThread.pendingPlanGate.toast', 'Незавершённый план блокирует отправку сообщений в этом чате.'),
				actions: {
					primary: [{
						id: 'vibeide.chat.dismissPendingPlan.fromToast',
						label: localize('vibeide.chatThread.pendingPlanGate.action', 'Сбросить план и продолжить'),
						class: undefined,
						enabled: true,
						tooltip: '',
						checked: undefined,
						run: () => {
							// Dismiss + auto-resume the blocked message (stream state handled inside).
							this.dismissAllPendingPlans(threadId, { resumeBlockedMessage: true });
						},
					}],
				},
			});
		} catch { /* notify is best-effort; the inline error in chat is the durable signal */ }
	}

	/**
	 * Dismisses every plan-message in a thread that's still gating execution:
	 *   - sets `approvalState` to 'aborted' (covers cached-pending checks)
	 *   - disables every step (covers the `steps.some(!disabled && status==='paused')` gate
	 *     in `_runChatAgent.checkPlanGenerated()`)
	 *
	 * Returns the number of plans touched. Used by both the
	 * `vibeide.chat.dismissPendingPlan` command and the inline error UX in chat that
	 * appears when `_runChatAgent` early-exits due to a pending plan.
	 */
	dismissAllPendingPlans(threadId: string, opts?: { resumeBlockedMessage?: boolean }): number {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return 0; }
		let touched = 0;
		for (let i = 0; i < thread.messages.length; i++) {
			const msg = thread.messages[i];
			if (msg.role !== 'plan') { continue; }
			const plan = msg as PlanMessage;
			const needsAbort = plan.approvalState !== 'aborted';
			const hasActiveStep = plan.steps.some(s => !s.disabled);
			if (!needsAbort && !hasActiveStep) { continue; }
			const updatedPlan: PlanMessage = {
				...plan,
				approvalState: 'aborted',
				steps: plan.steps.map(s => ({ ...s, disabled: true })),
			};
			this.editPlan({ threadId, messageIdx: i, updatedPlan });
			touched++;
		}
		// Optionally resume the user message that the gate blocked, so the user doesn't have to
		// re-type / re-send it (stuck-chat UX feedback). State is fully owned here when requested.
		if (opts?.resumeBlockedMessage && touched > 0) {
			if (!this._resumeBlockedUserMessageAfterDismiss(threadId)) {
				// Nothing to resume — just clear the pending-plan-gate error so the chat unblocks.
				this._setStreamState(threadId, undefined);
			}
		}
		return touched;
	}

	/**
	 * After a pending plan is dismissed, resume the trailing UNPROCESSED user message (the one the
	 * plan gate blocked) WITHOUT regenerating a plan — the user explicitly chose to proceed, so
	 * re-blocking on a fresh plan would loop. Returns true if a resume run was started.
	 */
	private _resumeBlockedUserMessageAfterDismiss(threadId: string): boolean {
		const thread = this.state.allThreads[threadId];
		if (!thread || thread.messages.length === 0) { return false; }
		const last = thread.messages[thread.messages.length - 1];
		// Resume only when the conversation ends on a user message with no reply yet — i.e. a
		// message submitted but never processed because the plan gate blocked it.
		if (!last || last.role !== 'user') { return false; }
		// Suppress plan generation for this one run so the resume doesn't regenerate a plan and
		// re-trigger the gate we just cleared (infinite block loop).
		this._suppressPlanOnceByThread[threadId] = true;
		this._setStreamState(threadId, undefined); // clear the dismissPlan recoverable error
		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps() }),
			threadId,
		);
		return true;
	}

	async pauseAgentExecution(opts: { threadId: string }): Promise<void> {
		// Pause = abort current LLM stream + mark the running plan step as 'paused' so the
		// PlanCard UI can render the resume affordance. Resuming is a separate user action.
		await this.abortRunning(opts.threadId);
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }

		// Find current plan and update current step to paused
		const planIdx = findLastIdx(thread.messages, (m: ChatMessage) => m.role === 'plan') ?? -1;
		if (planIdx >= 0) {
			const plan = thread.messages[planIdx] as PlanMessage;
			const runningStepIdx = plan.steps.findIndex(s => s.status === 'running');
			if (runningStepIdx >= 0) {
				const updatedSteps = [...plan.steps];
				updatedSteps[runningStepIdx] = { ...updatedSteps[runningStepIdx], status: 'paused' };
				const updatedPlan: PlanMessage = { ...plan, steps: updatedSteps };
				this._editMessageInThread(opts.threadId, planIdx, updatedPlan);
			}
		}
	}

	async resumeAgentExecution(opts: { threadId: string }): Promise<void> {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }

		const planIdx = findLastIdx(thread.messages, (m: ChatMessage) => m.role === 'plan') ?? -1;
		if (planIdx >= 0) {
			const plan = thread.messages[planIdx] as PlanMessage;
			const pausedStepIdx = plan.steps.findIndex(s => s.status === 'paused');
			if (pausedStepIdx >= 0) {
				const updatedSteps = [...plan.steps];
				updatedSteps[pausedStepIdx] = { ...updatedSteps[pausedStepIdx], status: 'queued' };
				const updatedPlan: PlanMessage = {
					...plan,
					steps: updatedSteps,
					approvalState: 'executing'
				};
				this._editMessageInThread(opts.threadId, planIdx, updatedPlan);
				// Resume execution from this step
				this._wrapRunAgentToNotify(
					this._runChatAgent({ threadId: opts.threadId, ...this._currentModelSelectionProps() }),
					opts.threadId,
				);
			}
		}
	}

	async retryStep(opts: { threadId: string; messageIdx: number; stepNumber: number }): Promise<void> {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const updatedSteps = plan.steps.map(step =>
			step.stepNumber === opts.stepNumber
				? { ...step, status: 'queued' as StepStatus, error: undefined, startTime: undefined, endTime: undefined }
				: step
		);
		const updatedPlan: PlanMessage = {
			...plan,
			steps: updatedSteps,
			approvalState: plan.approvalState === 'completed' ? 'executing' : plan.approvalState
		};
		this._editMessageInThread(opts.threadId, opts.messageIdx, updatedPlan);
		// Trigger step execution
		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId: opts.threadId, ...this._currentModelSelectionProps() }),
			opts.threadId,
		);
	}

	skipStep(opts: { threadId: string; messageIdx: number; stepNumber: number }) {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const updatedSteps = plan.steps.map(step =>
			step.stepNumber === opts.stepNumber
				? { ...step, status: 'skipped' as StepStatus }
				: step
		);
		const updatedPlan: PlanMessage = { ...plan, steps: updatedSteps };
		this._editMessageInThread(opts.threadId, opts.messageIdx, updatedPlan);

		if (plan.persistedPlanId) {
			this._taskDecompositionService.advancePersistedPlanStep(opts.threadId, 'skipped');
		}

		// After skipping, resume execution to continue with the next queued step
		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId: opts.threadId, ...this._currentModelSelectionProps() }),
			opts.threadId,
		);
	}

	async rollbackToStep(opts: { threadId: string; messageIdx: number; stepNumber: number }): Promise<void> {
		const thread = this.state.allThreads[opts.threadId];
		if (!thread) { return; }
		const message = thread.messages[opts.messageIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const step = plan.steps.find(s => s.stepNumber === opts.stepNumber);
		if (!step || step.checkpointIdx === undefined || step.checkpointIdx === null) { return; }

		// Rollback to checkpoint before this step
		await this.jumpToCheckpointBeforeMessageIdx({
			threadId: opts.threadId,
			messageIdx: step.checkpointIdx,
			jumpToUserModified: false
		});
	}

	/**
	 * Inject a pre-built PlanMessage into an existing thread.
	 * Used by VibePersistedPlanResumeContribution to restore interrupted plans after Reload Window.
	 * The plan is inserted with approvalState = 'pending' so the user must click Execute to start.
	 */
	injectPlanMessage(threadId: string, plan: PlanMessage): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) {
			vibeLog.warn('PlanResume', `injectPlanMessage: thread ${threadId} not found`);
			return;
		}
		const planWithPending: PlanMessage = { ...plan, approvalState: 'pending' };
		this._addMessageToThread(threadId, planWithPending);
		vibeLog.info('PlanResume', `Injected plan into thread ${threadId} (${plan.steps.length} steps)`);
		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({
				ts: Date.now(),
				action: 'plan_resumed',
				ok: true,
				meta: { threadId, stepsTotal: plan.steps.length, planId: plan.persistedPlanId },
			}).catch(() => { });
		}
	}

	// Plan execution tracking helpers - cached for performance
	private _planCache: Map<string, { plan: PlanMessage; planIdx: number; lastChecked: number } | null> = new Map();

	// Anti-spam: provider/model keys for which we've already shown the "image silently dropped"
	// warning during this session — suppressed for the rest of the process lifetime so the user
	// is not bombarded across multiple replies from the same broken provider.
	private _visionDropNotified: Set<string> = new Set();

	private _maybeShowVisionDropWarning(modelSelection: ModelSelection, replyText: string | undefined | null): void {
		if (!modelSelection || modelSelection.providerName === 'auto' || modelSelection.modelName === 'auto') {
			return;
		}
		const key = `${modelSelection.providerName}/${modelSelection.modelName}`;
		if (this._visionDropNotified.has(key)) {
			return;
		}
		if (!detectVisionDropResponse(replyText)) {
			return;
		}
		this._visionDropNotified.add(key);
		const handle = this._notificationService.notify({
			severity: Severity.Warning,
			message: localize('vibeide.visionDrop.suspect', 'Похоже, модель «{0}» не получила прикреплённое изображение — провайдер мог тихо его отбросить. Заблокировать изображения для этой модели?', key),
			sticky: true,
			actions: {
				primary: [{
					id: 'vibeide.visionDrop.block',
					enabled: true,
					label: localize('vibeide.visionDrop.blockAction', 'Заблокировать изображения'),
					tooltip: '',
					class: undefined,
					run: async () => {
						try {
							await this._settingsService.setOverridesOfModel(modelSelection.providerName, modelSelection.modelName, { supportsVision: false });
							this._notificationService.info(localize('vibeide.visionDrop.blocked', 'Изображения для «{0}» теперь блокируются. Снять блокировку можно в Настройках → Модели.', key));
						} catch (err) {
							vibeLog.error('chatThread', '[visionDrop] Failed to set supportsVision override', err);
						} finally {
							handle.close();
						}
					},
				}, {
					id: 'vibeide.visionDrop.dismiss',
					enabled: true,
					label: localize('vibeide.visionDrop.dismissAction', 'Игнорировать'),
					tooltip: '',
					class: undefined,
					run: () => { handle.close(); },
				}],
			},
		});
	}
	private readonly PLAN_CACHE_TTL = 100; // ms - invalidate cache after message changes

	private _getCurrentPlan(threadId: string, forceRefresh = false): { plan: PlanMessage; planIdx: number } | undefined {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return undefined; }

		// Fast path: check cache first (only if messages haven't changed significantly)
		if (!forceRefresh) {
			const cached = this._planCache.get(threadId);
			if (cached && cached.lastChecked > Date.now() - this.PLAN_CACHE_TTL && cached.planIdx < thread.messages.length) {
				// Verify cached plan is still valid
				const cachedPlan = thread.messages[cached.planIdx];
				if (cachedPlan && cachedPlan.role === 'plan') {
					const plan = cachedPlan as PlanMessage;
					// Return plan regardless of approvalState (pending, approved, executing all need to be seen)
					return { plan, planIdx: cached.planIdx };
				}
			}
		}

		// Slow path: find plan (only when cache misses or forced)
		const planIdx = findLastIdx(thread.messages, (m: ChatMessage) => m.role === 'plan') ?? -1;
		if (planIdx < 0) {
			this._planCache.set(threadId, null);
			return undefined;
		}
		const plan = thread.messages[planIdx] as PlanMessage;

		// Cache result (for all approval states)
		const result = { plan, planIdx, lastChecked: Date.now() };
		this._planCache.set(threadId, result);
		return { plan, planIdx };
	}

	private _getCurrentStep(threadId: string, forceRefresh = false): { plan: PlanMessage; planIdx: number; step: PlanStep; stepIdx: number } | undefined {
		const planInfo = this._getCurrentPlan(threadId, forceRefresh);
		if (!planInfo) { return undefined; }
		const { plan, planIdx } = planInfo;

		// Find first step that's queued or running
		const stepIdx = plan.steps.findIndex(s =>
			!s.disabled && (s.status === 'queued' || s.status === 'running' || s.status === 'paused')
		);
		if (stepIdx < 0) { return undefined; }

		return { plan, planIdx, step: plan.steps[stepIdx], stepIdx };
	}

	/**
	 * PERFORMANCE: Generate cache key for message preparation
	 * Key is based on chatMessages content, modelSelection, chatMode, and repoIndexer results
	 */
	private _getMessagePrepCacheKey(
		chatMessages: ChatMessage[],
		modelSelection: ModelSelection | null,
		chatMode: ChatMode,
		repoIndexerResults: { results: string[]; metrics: QueryMetrics } | null | undefined
	): string {
		// Create stable hash from inputs
		const modelKey = modelSelection ? `${modelSelection.providerName}:${modelSelection.modelName}` : 'null';
		const messagesHash = JSON.stringify(chatMessages.map(m => {
			// `content` lives on user/tool messages; `id` only on tool messages. Narrow by role
			// so the hash payload stays identical without unsafe casts.
			const content = m.role === 'user' || m.role === 'tool' ? m.content : undefined;
			const id = m.role === 'tool' ? m.id : undefined;
			return {
				role: m.role,
				content: typeof content === 'string' ? content.substring(0, 100) : content, // Truncate for hash
				id
			};
		}));
		const repoIndexerKey = repoIndexerResults ? JSON.stringify(repoIndexerResults.results.slice(0, 10)) : 'null';
		return `${modelKey}|${chatMode}|${messagesHash}|${repoIndexerKey}`;
	}

	/**
	 * PERFORMANCE: Compute token count and context size from prepared messages (cached)
	 */
	private _computeTokenCount(messages: LLMChatMessage[]): { tokenCount: number; contextSize: number } {
		const estimateTokens = (text: string) => Math.ceil(text.length / 4);
		let tokenCount = 0;
		let contextSize = 0;

		for (const m of messages) {
			// Handle Gemini messages (use 'parts' instead of 'content')
			if (isGeminiLLMChatMessage(m)) {
				for (const part of m.parts) {
					if (isGeminiTextPart(part)) {
						tokenCount += estimateTokens(part.text);
						contextSize += part.text.length;
					} else if (isGeminiInlineDataPart(part)) {
						// Rough estimate: ~85 tokens per image + base64 overhead
						tokenCount += 100;
					}
				}
			}
			// Handle Anthropic/OpenAI messages (use 'content')
			else {
				if (typeof m.content === 'string') {
					tokenCount += estimateTokens(m.content);
					contextSize += m.content.length;
				} else if (Array.isArray(m.content)) {
					// Handle OpenAI format with image_url parts
					for (const part of m.content) {
						if (part.type === 'text') {
							tokenCount += estimateTokens(part.text);
							contextSize += part.text.length;
						} else if (part.type === 'image_url') {
							// Rough estimate: ~85 tokens per image + base64 overhead
							tokenCount += 100;
						}
					}
				} else {
					const jsonStr = JSON.stringify(m.content);
					tokenCount += estimateTokens(jsonStr);
					contextSize += jsonStr.length;
				}
			}
		}

		return { tokenCount, contextSize };
	}

	private _updatePlanStep(threadId: string, planIdx: number, stepIdx: number, updates: Partial<PlanStep>) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const message = thread.messages[planIdx];
		if (!message || message.role !== 'plan') { return; }

		const plan = message as PlanMessage;
		const updatedSteps = [...plan.steps];
		updatedSteps[stepIdx] = { ...updatedSteps[stepIdx], ...updates };
		const updatedPlan: PlanMessage = { ...plan, steps: updatedSteps };
		this._editMessageInThread(threadId, planIdx, updatedPlan);
		// PERFORMANCE: Update cache in place instead of invalidating
		// This avoids expensive re-lookup on next access
		const cached = this._planCache.get(threadId);
		if (cached && cached.planIdx === planIdx) {
			// Update cached plan directly - same plan, just updated steps
			cached.plan = updatedPlan;
			cached.lastChecked = Date.now();
		} else {
			// Cache miss or different plan - invalidate to be safe
			this._planCache.delete(threadId);
		}
	}

	// Fast internal versions that take step directly (avoid lookup)
	private _linkToolCallToStepInternal(threadId: string, toolId: string, currentStep: { plan: PlanMessage; planIdx: number; step: PlanStep; stepIdx: number }, stepNumber?: number) {
		const { planIdx, step, stepIdx } = currentStep;
		// If stepNumber provided, verify it matches
		if (stepNumber !== undefined && step.stepNumber !== stepNumber) { return; }

		const toolCalls = step.toolCalls || [];
		if (!toolCalls.includes(toolId)) {
			this._updatePlanStep(threadId, planIdx, stepIdx, {
				toolCalls: [...toolCalls, toolId]
			});
		}
	}

	/**
	 * Finalize the thread's plan IF it is executing and every step is done: mark it completed,
	 * clear the execution lease, unregister the binding, write the FINAL status to the .plan.md,
	 * and emit the review. Idempotent and safe to call from EVERY run-end path (natural loop exit,
	 * `vibe_complete`, implicit-completion). Previously only the natural exit reached this, so a run
	 * that ended via `vibe_complete`/prose left the plan (and its lease + .plan.md) stuck
	 * "executing/running" — which kept re-triggering the startup "Continue Plan" notice. No-op when
	 * there is no executing+complete plan.
	 */
	private _finalizePlanIfComplete(threadId: string): void {
		this._planCache.delete(threadId);
		const refreshedPlanInfo = this._getCurrentPlan(threadId, true);
		if (!refreshedPlanInfo) { return; }
		const allStepsComplete = refreshedPlanInfo.plan.steps.every(s =>
			s.disabled || s.status === 'succeeded' || s.status === 'failed' || s.status === 'skipped'
		);
		if (!(allStepsComplete && refreshedPlanInfo.plan.approvalState === 'executing')) { return; }
		const updatedPlan: PlanMessage = { ...refreshedPlanInfo.plan, approvalState: 'completed' };
		this._editMessageInThread(threadId, refreshedPlanInfo.planIdx, updatedPlan);
		this._clearPersistedExecutionLease(updatedPlan.persistedPlanId);
		const wfDone = this._primaryWorkspaceFolderUri();
		if (wfDone && updatedPlan.persistedPlanId) {
			this._planBindingRegistry.unregister(wfDone, updatedPlan.persistedPlanId, threadId);
			// Persist FINAL status to the .plan.md (running → completed/failed): clears the
			// perpetual startup "Continue Plan" resume notice for a finished plan.
			const anyFailed = updatedPlan.steps.some(s => !s.disabled && s.status === 'failed');
			void this._persistedPlanService.updatePersistedPlanProgress({
				workspaceFolder: wfDone,
				planId: updatedPlan.persistedPlanId,
				plan: updatedPlan,
				status: anyFailed ? 'failed' : 'completed',
			});
		}
		this._taskDecompositionService.clearPersistedPlanTask(threadId);
		this._planCache.delete(threadId);
		this._generateReviewMessage(threadId, updatedPlan);
	}

	private _markStepCompletedInternal(threadId: string, currentStep: { plan: PlanMessage; planIdx: number; step: PlanStep; stepIdx: number }, succeeded: boolean, error?: string): { plan: PlanMessage; planIdx: number; step: PlanStep; stepIdx: number } | undefined {
		const { planIdx, stepIdx } = currentStep;

		const updates: Partial<PlanStep> = {
			status: succeeded ? 'succeeded' : 'failed',
			endTime: Date.now(),
			error: error
		};
		this._updatePlanStep(threadId, planIdx, stepIdx, updates);

		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({
				ts: Date.now(),
				action: succeeded ? 'plan_step_completed' : 'plan_failed',
				ok: succeeded,
				meta: { threadId, stepNumber: currentStep.step.stepNumber },
			}).catch(() => { });
		}

		const wf = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		const persistedPid = currentStep.plan.persistedPlanId?.trim();
		if (wf && persistedPid) {
			void this._planEventJournal.append(wf, {
				type: succeeded ? 'plan.step.completed' : 'plan.step.failed',
				planId: persistedPid,
				threadId,
				stepNumber: currentStep.step.stepNumber,
				...(error ? { error: String(error).slice(0, 500) } : {}),
			});
		}

		const progPlanInfo = this._getCurrentPlan(threadId, true);
		if (progPlanInfo?.plan.persistedPlanId) {
			this._taskDecompositionService.advancePersistedPlanStep(threadId, succeeded ? 'done' : 'failed');
			// Persist step progress to the .plan.md so completed steps are reflected on disk (the
			// frozen "all queued / status: running" snapshot was why finished plans still triggered
			// the startup "Continue Plan" resume notice). Fire-and-forget; the service logs failures
			// and never throws into execution.
			if (wf) {
				void this._persistedPlanService.updatePersistedPlanProgress({
					workspaceFolder: wf,
					planId: progPlanInfo.plan.persistedPlanId,
					plan: progPlanInfo.plan,
					status: 'running',
				});
			}
		}

		// PERFORMANCE: Return updated step info to avoid re-lookup
		// Get updated plan from cache (should be fresh after _updatePlanStep)
		const cached = this._planCache.get(threadId);
		if (cached && cached.planIdx === planIdx) {
			const updatedStep = cached.plan.steps[stepIdx];
			if (updatedStep) {
				return { plan: cached.plan, planIdx, step: updatedStep, stepIdx };
			}
		}
		// Fallback: re-fetch if cache miss (shouldn't happen, but safe)
		return this._getCurrentStep(threadId, false);
	}

	private async _startNextStep(threadId: string): Promise<{ step: PlanStep; stepIdx: number; planIdx: number; plan: PlanMessage; checkpointIdx: number } | undefined> {
		// PERFORMANCE: Use cached plan if available, only force refresh if needed
		const planInfo = this._getCurrentPlan(threadId, false); // Try cache first
		if (!planInfo) {
			// Cache miss - do full refresh
			const refreshed = this._getCurrentPlan(threadId, true);
			if (!refreshed) { return undefined; }
			const { plan, planIdx } = refreshed;

			// Find next queued step (not disabled, queued status)
			const stepIdx = plan.steps.findIndex(s =>
				!s.disabled && s.status === 'queued'
			);
			if (stepIdx < 0) { return undefined; }

			// Create checkpoint before starting step
			await this._addUserCheckpoint({ threadId });
			const thread = this.state.allThreads[threadId];
			if (!thread) { return undefined; }
			const checkpointIdx = thread.messages.length - 1;

			// Update step to running and link checkpoint
			this._updatePlanStep(threadId, planIdx, stepIdx, {
				status: 'running',
				startTime: Date.now(),
				checkpointIdx: checkpointIdx
			});

			// Get updated plan from cache
			const cached = this._planCache.get(threadId);
			const updatedPlan = (cached && cached.planIdx === planIdx) ? cached.plan : plan;
			const updatedStep = updatedPlan.steps[stepIdx];

			return { step: updatedStep, stepIdx, planIdx, plan: updatedPlan, checkpointIdx };
		}

		const { plan, planIdx } = planInfo;

		// Find next queued step (not disabled, queued status)
		const stepIdx = plan.steps.findIndex(s =>
			!s.disabled && s.status === 'queued'
		);
		if (stepIdx < 0) { return undefined; }

		// Create checkpoint before starting step
		await this._addUserCheckpoint({ threadId });
		const thread = this.state.allThreads[threadId];
		if (!thread) { return undefined; }
		const checkpointIdx = thread.messages.length - 1;

		// Update step to running and link checkpoint
		this._updatePlanStep(threadId, planIdx, stepIdx, {
			status: 'running',
			startTime: Date.now(),
			checkpointIdx: checkpointIdx
		});

		// Get updated plan from cache (should be fresh after _updatePlanStep)
		const cached = this._planCache.get(threadId);
		const updatedPlan = (cached && cached.planIdx === planIdx) ? cached.plan : plan;
		const updatedStep = updatedPlan.steps[stepIdx];

		return { step: updatedStep, stepIdx, planIdx, plan: updatedPlan, checkpointIdx };
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName;
	};

	private _tryGetWorkbenchWindowId(): number | undefined {
		const env = this._environmentService as { window?: { id: number } };
		return env.window?.id;
	}

	private _ensureExecutionLeaseHolderNonce(): string {
		if (!this._executionLeaseHolderNonce) {
			this._executionLeaseHolderNonce = generateUuid();
		}
		return this._executionLeaseHolderNonce;
	}

	private _primaryWorkspaceFolderUri(): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length ? folders[0]!.uri : undefined;
	}

	private _clearPersistedExecutionLease(planId: string | undefined): void {
		if (!planId) {
			return;
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			return;
		}
		void this._persistedPlanService.clearExecutionLease(folders[0].uri, planId).catch(() => { });
	}

	/** Tokens spent since `baseline` (captured at run start). Clamped to 0 so an autopilot
	 *  mid-run counter reset can't produce a negative delta. Best-effort (returns 0 on error). */
	private _tokensSpentThisRun(baseline: number): number {
		try {
			const now = this._tokenBudgetService.getStatus().sessionTokensUsed;
			return Math.max(0, now - baseline);
		} catch {
			return 0;
		}
	}

	/** Soft checkpoint (B): pause an agent run and ask the user whether to keep going. Resolves
	 *  `true` to continue, `false` to stop. A sticky prompt with explicit Continue/Stop actions;
	 *  dismissal counts as Stop so the agent loop never hangs waiting on a closed notification.
	 *  D.2a: if the run is aborted (stop button) while the prompt is open, resolve as Stop and
	 *  close the toast — otherwise the awaiting loop would hang until the prompt is touched. */
	private _promptAgentSoftCheckpoint(threadId: string, steps: number, tokensSpent: number): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			let settled = false;
			const abortListener = new MutableDisposable();
			const finish = (v: boolean) => {
				if (settled) { return; }
				settled = true;
				abortListener.dispose();
				resolve(v);
			};
			const tokenPart = tokensSpent > 0
				? localize('vibeide.agent.softCheckpoint.tokens', ' (~{0} токенов)', tokensSpent.toLocaleString())
				: '';
			const handle = this._notificationService.prompt(
				Severity.Info,
				localize('vibeide.agent.softCheckpoint.msg', 'Агент выполнил {0} шагов{1} в одном запросе без остановки. Продолжить?', steps, tokenPart),
				[
					{ label: localize('vibeide.agent.softCheckpoint.continue', 'Продолжить'), run: () => finish(true) },
					{ label: localize('vibeide.agent.softCheckpoint.stop', 'Остановить'), run: () => finish(false) },
				],
				{ sticky: true, onCancel: () => finish(false) }
			);
			abortListener.value = this.onDidChangeStreamState(e => {
				if (e.threadId !== threadId) { return; }
				const ss = this.streamState[threadId];
				if (!ss || ss.isRunning === undefined) {
					handle.close();
					finish(false);
				}
			});
		});
	}

	private async _touchPersistedExecutionLease(threadId: string): Promise<void> {
		const info = this._getCurrentPlan(threadId, false);
		const plan = info?.plan;
		if (!plan?.persistedPlanId) {
			return;
		}
		if (plan.approvalState !== 'approved' && plan.approvalState !== 'executing') {
			return;
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			return;
		}
		try {
			const r = await this._persistedPlanService.acquireOrRefreshExecutionLease(folders[0].uri, {
				planId: plan.persistedPlanId,
				threadId,
				windowId: this._tryGetWorkbenchWindowId(),
				holderNonce: this._ensureExecutionLeaseHolderNonce(),
			});
			if (!r.ok) {
				vibeLog.warn('chatThread', 'Execution lease heartbeat skipped: held by other thread', r.holderThreadId);
			}
		} catch { /* ignore */ }
	}

	private _toolMatchesPersistedPlanHints(toolName: ToolName, step: PlanStep): boolean {
		const hints = step.tools;
		if (!hints?.length) {
			return true;
		}
		// Built-in read-only tools (KNOWN built-in AND not in
		// approvalTypeOfBuiltinToolName — which is the data-driven authoritative
		// source of "built-in tools with side effects") are ALWAYS allowed
		// regardless of the step's `tools` hint.
		//
		// Rationale: planners reliably list write/exec tools (create_file_or_folder,
		// run_command, edit_file) but rarely enumerate read tools (read_file,
		// ls_dir, get_dir_tree, grep, glob) that the model legitimately uses to
		// orient itself before performing the write. Hard-blocking on read-only
		// drift produced false positives where the step paused on an exploration
		// call that had zero side effects.
		//
		// IMPORTANT: MCP tools and any non-built-in tool DON'T get this
		// exemption — MCP tool side effects are external by definition
		// (creating issues, posting messages, calling third-party APIs) and
		// must be subject to strict plan-drift. We can't infer "MCP foo is
		// read-only" from any data source we control; the planner has to be
		// explicit about MCP tools in the step hints.
		const isBuiltIn = isABuiltinToolName(toolName);
		const isBuiltInReadOnly = isBuiltIn && !Object.hasOwn(approvalTypeOfBuiltinToolName, toolName as string);
		if (isBuiltInReadOnly) {
			return true;
		}
		const tn = String(toolName).toLowerCase();
		return hints.some(h => {
			const raw = (h ?? '').toLowerCase().trim();
			if (!raw.length) {
				return false;
			}
			return tn === raw || tn.includes(raw) || raw.includes(tn);
		});
	}

	/** Returns true if execution should stop (plan paused for drift). */
	private _pauseRunningPlanStepForToolDrift(threadId: string, toolName: ToolName): boolean {
		const stepState = this._getCurrentStep(threadId, true);
		if (!stepState || stepState.step.status !== 'running') {
			return false;
		}
		if (this._toolMatchesPersistedPlanHints(toolName, stepState.step)) {
			return false;
		}
		const { planIdx, stepIdx } = stepState;
		const thread = this.state.allThreads[threadId];
		if (!thread) {
			return false;
		}
		const message = thread.messages[planIdx];
		if (!message || message.role !== 'plan') {
			return false;
		}
		const plan = message as PlanMessage;
		const updatedSteps = [...plan.steps];
		updatedSteps[stepIdx] = {
			...updatedSteps[stepIdx],
			status: 'paused',
			error: localize('vibeide.planToolDriftStepError', 'Пауза: инструмент "{0}" не совпадает с запланированными для этого шага. Обновите `.vibe/plans/*.plan.md` или продолжите.', String(toolName)),
		};
		const updatedPlan: PlanMessage = { ...plan, steps: updatedSteps, approvalState: 'executing' };
		this._editMessageInThread(threadId, planIdx, updatedPlan);
		this._planCache.delete(threadId);
		this._notificationService.notify({
			severity: Severity.Warning,
			message: localize('vibeide.planToolDriftNotify', 'План приостановлен: инструмент "{0}" расходится с запланированными для этого шага.', String(toolName)),
		});
		return true;
	}

	private _resolveMcpServerForPlanTool(toolName: ToolName, mcpServerHint: string | undefined): string | undefined {
		if (mcpServerHint) {
			return mcpServerHint;
		}
		const mt = this._mcpService.getMCPTools()?.find(t => t.name === toolName);
		return mt?.mcpServerName;
	}

	private _mcpCallMatchesPlanAllowlist(step: PlanStep, toolName: ToolName, mcpServerName: string | undefined): boolean {
		const srvAllow = step.mcpServersAllow;
		const toolAllow = step.mcpToolsAllow;
		const hasSrv = !!(srvAllow && srvAllow.length > 0);
		const hasTool = !!(toolAllow && toolAllow.length > 0);
		if (!hasSrv && !hasTool) {
			return true;
		}
		const isMcp = !!(mcpServerName && mcpServerName.length > 0);
		if (!isMcp) {
			return true;
		}
		if (hasSrv) {
			const s = mcpServerName.toLowerCase();
			const okSrv = srvAllow!.some(x => (x ?? '').toLowerCase().trim() === s);
			if (!okSrv) {
				return false;
			}
		}
		if (hasTool) {
			const tn = String(toolName).toLowerCase();
			// MCP tool names are exposed to the model as `<server>_<tool>`, but
			// pre-existing plan allowlists store the bare tool name. Accept either.
			const originalName = this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.originalName?.toLowerCase();
			const okTool = toolAllow!.some(t => {
				const candidate = (t ?? '').toLowerCase().trim();
				if (!candidate) { return false; }
				return candidate === tn || (originalName !== undefined && candidate === originalName);
			});
			if (!okTool) {
				return false;
			}
		}
		return true;
	}

	/** Returns true if execution should stop (plan paused for MCP allowlist violation). */
	private _pauseRunningPlanStepForMcpAllowlist(threadId: string, toolName: ToolName, serverLabel: string | undefined): boolean {
		const stepState = this._getCurrentStep(threadId, true);
		if (!stepState || stepState.step.status !== 'running') {
			return false;
		}
		const { planIdx, stepIdx } = stepState;
		const thread = this.state.allThreads[threadId];
		if (!thread) {
			return false;
		}
		const message = thread.messages[planIdx];
		if (!message || message.role !== 'plan') {
			return false;
		}
		const plan = message as PlanMessage;
		const updatedSteps = [...plan.steps];
		const srvTxt = serverLabel ?? '';
		updatedSteps[stepIdx] = {
			...updatedSteps[stepIdx],
			status: 'paused',
			error: localize('vibeide.planMcpAllowlistStepError', 'Пауза: MCP-инструмент "{0}" сервера "{1}" вне allowlist этого шага. Обновите `.vibe/plans/*.plan.md` или продолжите.', String(toolName), String(srvTxt)),
		};
		const updatedPlan: PlanMessage = { ...plan, steps: updatedSteps, approvalState: 'executing' };
		this._editMessageInThread(threadId, planIdx, updatedPlan);
		this._planCache.delete(threadId);
		this._notificationService.notify({
			severity: Severity.Warning,
			message: localize('vibeide.planMcpAllowlistNotify', 'План приостановлен: MCP-инструмент "{0}" нарушает allowlist шага.', String(toolName)),
		});
		return true;
	}

	// Check if user request warrants plan generation
	private _shouldGeneratePlan(threadId: string): boolean {
		// Honor one-shot suppression flag (used by simple Quick Actions)
		if (this._suppressPlanOnceByThread[threadId]) {
			delete this._suppressPlanOnceByThread[threadId];
			return false;
		}
		const thread = this.state.allThreads[threadId];
		if (!thread) { return false; }

		const lastUserMessage = thread.messages.filter(m => m.role === 'user').pop();
		if (!lastUserMessage || lastUserMessage.role !== 'user') { return false; }

		const userRequest = (lastUserMessage.displayContent || '').toLowerCase();

		// Detect complex multi-step tasks that should have plans
		const complexTaskIndicators = [
			// Multi-step operations
			'create.*system', 'build.*system', 'implement.*system', 'set up.*system',
			'refactor', 'refactoring',
			'migrate', 'migration',
			'add.*and.*test', 'create.*and.*add', 'implement.*and.*test',
			'setup', 'set up', 'configure',
			// Multi-file operations
			'multiple.*file', 'several.*file', 'all.*file',
			'create.*with', 'add.*with.*and',
			// Structured requests
			'authentication.*system', 'api.*with.*tests', 'full.*stack'
		];

		const hasComplexIndicator = complexTaskIndicators.some(pattern => {
			const regex = new RegExp(pattern, 'i');
			return regex.test(userRequest);
		});

		// Also check for multiple action verbs (suggests multiple steps)
		const actionVerbs = ['create', 'add', 'edit', 'delete', 'update', 'refactor', 'implement', 'build', 'set up', 'configure', 'test'];
		const actionCount = actionVerbs.filter(verb => userRequest.includes(verb)).length;

		return hasComplexIndicator || actionCount >= 3;
	}

	/**
	 * Auxiliary-model routing (knowledge/roadmap/token-economy.md, C): service LLM calls
	 * (plan generation etc.) don't need the user's main — often expensive — model. When
	 * `vibeide.chat.auxiliaryModel` is set to a known `provider/model`, route there.
	 * Unset / invalid value → null, caller keeps the main selection (a typo in the setting
	 * must degrade to current behaviour, not break the service call).
	 */
	private _resolveAuxiliaryModelSelection(): ModelSelection | null {
		const raw = this._configurationService.getValue<unknown>('vibeide.chat.auxiliaryModel');
		if (typeof raw !== 'string' || raw.trim().length === 0) { return null; }
		const resolved = this._findModelSelectionForId(raw.trim());
		if (!resolved) {
			vibeLog.warn('chatThread', `auxiliaryModel "${raw.trim()}" not found among configured providers — using the main model for this service call.`);
		}
		return resolved;
	}

	// Generate plan from user request by asking LLM
	private async _generatePlanFromUserRequest(
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined
	): Promise<void> {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		// Service call → cheap auxiliary model when configured (token-economy C).
		// `_findModelSelectionForId` never returns the pseudo-provider 'auto', but the type
		// allows it — narrow explicitly so the options lookup index-checks.
		const auxSelection = this._resolveAuxiliaryModelSelection();
		if (auxSelection && auxSelection.providerName !== 'auto') {
			modelSelection = auxSelection;
			modelSelectionOptions = this._settingsService.state.optionsOfModelSelection['Chat'][auxSelection.providerName]?.[auxSelection.modelName];
		}

		const lastUserMessage = thread.messages.filter(m => m.role === 'user').pop();
		if (!lastUserMessage || lastUserMessage.role !== 'user') { return; }

		const userRequest = lastUserMessage.displayContent || '';

		const stagedPaths: string[] = [];
		const staged = lastUserMessage.selections?.length ? lastUserMessage.selections : lastUserMessage.state.stagingSelections;
		if (staged?.length) {
			for (const s of staged) {
				if (s.type === 'File' || s.type === 'CodeSelection') {
					stagedPaths.push(s.uri.fsPath);
				} else if (s.type === 'Folder') {
					stagedPaths.push(s.uri.fsPath);
				}
			}
		}
		const stagedHint = stagedPaths.length
			? `\n\nThe user staged these workspace paths — prioritize them in "files" when relevant:\n${stagedPaths.map(p => `- ${p}`).join('\n')}`
			: '';

		const planPrompt = `The user has requested: "${userRequest}"${stagedHint}

Please generate a structured execution plan for this task. Output your plan in the following JSON format:

{
  "summary": "Brief overall plan summary",
  "steps": [
    {
      "stepNumber": 1,
      "description": "Step description",
      "tools": ["tool_name1", "tool_name2"],
      "files": ["path/to/file1.ts", "path/to/file2.ts"]
    },
    {
      "stepNumber": 2,
      "description": "Next step description",
      "tools": ["tool_name"],
      "files": ["path/to/file.ts"]
    }
  ]
}

Think through the task carefully. Break it down into logical steps. For each step:
- Describe what needs to be done
- List the tools that will be needed (e.g., read_file, edit_file, create_file_or_folder, run_command, search_for_files)
- List files that will be affected (if known or likely)

Output ONLY the JSON, no other text. Start with { and end with }.`;

		// Send plan generation request
		const chatMessages = thread.messages.slice(0, -1); // All messages except last user message
		const planRequest: ChatMessage = {
			role: 'user',
			content: planPrompt,
			displayContent: planPrompt,
			selections: null,
			state: { stagingSelections: [], isBeingEdited: false }
		};

		const { messages } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
			chatMessages: [...chatMessages, planRequest],
			modelSelection,
			chatMode: 'normal' // Use 'normal' mode to prevent tool execution during plan generation
		});

		this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: 'Generating execution plan...', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) });

		// Create a promise that resolves when the plan is generated
		return new Promise<void>((resolve, reject) => {
			try {
				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode: 'normal', // Normal mode - no tool execution
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel: this._settingsService.state.overridesOfModel,
					logging: { loggingName: 'Plan Generation', loggingExtras: { threadId } },
					separateSystemMessage: undefined,
					onText: ({ fullText }) => {
						// Don't show raw JSON to user - just show "Generating plan..."
						this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: 'Generating execution plan...', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => { if (llmCancelToken) { this._llmMessageService.abort(llmCancelToken); } }) });
					},
					onFinalMessage: async ({ fullText }) => {
						// Parse plan from LLM response
						try {
							// Try to extract JSON from response
							const jsonMatch = fullText.match(/\{[\s\S]*\}/);
							if (jsonMatch) {
								const planData: {
									summary?: string;
									steps?: Array<{ stepNumber?: number; description?: string; tools?: string[]; files?: string[] }>;
								} = JSON.parse(jsonMatch[0]);
								const planMessage: PlanMessage = {
									role: 'plan',
									type: 'agent_plan',
									summary: planData.summary || 'Execution plan',
									steps: (planData.steps || []).map((step, idx) => ({
										stepNumber: step.stepNumber || idx + 1,
										description: step.description || `Step ${idx + 1}`,
										tools: step.tools || [],
										files: step.files || [],
										status: 'queued' as StepStatus
									})),
									approvalState: 'pending'
								};

								// Add plan to thread (DO NOT add assistant message - hide the raw JSON)
								this._addMessageToThread(threadId, planMessage);
								// CRITICAL: Invalidate cache immediately so subsequent checks see the new plan
								this._planCache.delete(threadId);
								// CRITICAL: Stop execution immediately - set state to idle (don't abort which adds messages)
								// NOTE: The flag will be checked in the main execution loop
								this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
								resolve(); // Resolve when plan is successfully added
							} else {
								// Failed to parse - add as assistant message explaining we couldn't parse
								this._addMessageToThread(threadId, {
									role: 'assistant',
									displayContent: 'I attempted to create a plan but had difficulty parsing it. Proceeding with direct execution...\n\n' + fullText,
									reasoning: '',
									anthropicReasoning: null
								});
								this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
								resolve(); // Still resolve - let normal execution continue
							}
						} catch (parseError) {
							vibeLog.error('chatThread', 'Failed to parse plan from LLM:', parseError);
							// Add as assistant message
							this._addMessageToThread(threadId, {
								role: 'assistant',
								displayContent: 'I attempted to create a plan but encountered an error. Proceeding with direct execution...\n\n' + fullText,
								reasoning: '',
								anthropicReasoning: null
							});
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
							resolve(); // Still resolve - let normal execution continue
						}
					},
					onError: async (error) => {
						this._setStreamState(threadId, { isRunning: undefined, error });
						reject(error);
					},
					onAbort: () => {
						this._setStreamState(threadId, undefined);
						reject(new Error('Plan generation aborted'));
					},
				});

				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: localize('vibeide.chatThread.plan.failedToGenerate', 'Не удалось сгенерировать план'), fullError: null } });
					reject(new Error('Failed to start plan generation'));
				}
			} catch (error) {
				this._setStreamState(threadId, { isRunning: undefined, error: { message: localize('vibeide.chatThread.plan.errorGenerating', 'Ошибка при генерации плана'), fullError: error instanceof Error ? error : null } });
				reject(error);
			}
		});
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		// User-initiated stop: suppress the run-end notification sound for this thread (the user is
		// at the keyboard). Covers the several undefined-transitions one abort can produce.
		this._suppressStopSound(threadId);

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo;
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null });
			if (toolCallSoFar) { this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) }); }
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo;
			const content = content_ || this.toolErrMsgs.interrupted;
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName });
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId);
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		await this._addUserCheckpoint({ threadId });

		// interrupt any effects — hard-timeout the await. If the stream-state's
		// `interrupt` Promise never resolves (observed in the wild: stuck
		// 'preparing' state from a previous _runChatAgent that errored without
		// resolving its interruptor), the whole abortRunning() hangs and the
		// caller (_addUserMessageAndStreamResponse) waits forever — user sees
		// "send did nothing" with no toast, no error, no feedback. Capping the
		// wait at 2s lets us still call the interruptor when it's available
		// quickly, but never blocks a new send for more than that.
		const interruptPromise = this.streamState[threadId]?.interrupt;
		if (interruptPromise) {
			const HANG_MS = 2_000;
			let timedOut = false;
			const winner = await Promise.race([
				interruptPromise,
				new Promise<'__timeout__'>(resolve => setTimeout(() => { timedOut = true; resolve('__timeout__'); }, HANG_MS)),
			]);
			if (timedOut) {
				vibeLog.warn('chatThread', `abortRunning timeout: interrupt Promise did not resolve within ${HANG_MS}ms (threadId=${threadId}). Forcibly clearing state.`);
			} else if (typeof winner === 'function') {
				try { winner(); } catch (e) { vibeLog.warn('chatThread', 'interrupt() threw:', e); }
			}
		}

		this._setStreamState(threadId, undefined);
	}

	forceResetChatState(threadId: string): boolean {
		// Snapshot the pre-reset state for both the metrics event and the
		// "did anything actually happen" return signal. A thread is "clean"
		// (no-op reset) when ALL four trackers are empty:
		//   - streamState entry missing or isRunning === undefined
		//   - no submit watchdog timer pending
		//   - no age tracker entry
		//   - no pending RAF batch update queued
		// If any one of those has data, the call is a real reset.
		const priorIsRunning = this.streamState[threadId]?.isRunning;
		const priorStateBeforeReset = priorIsRunning ?? 'undefined';
		const priorAgeMs = this._streamStateSetAt.has(threadId) ? Date.now() - this._streamStateSetAt.get(threadId)! : 0;
		const hadWatchdog = this._submitWatchdogByThread.has(threadId);
		const hadPendingRaf = this._pendingStreamStateUpdates.has(threadId);
		const actuallyResetSomething = priorIsRunning !== undefined || hadWatchdog || hadPendingRaf || this._streamStateSetAt.has(threadId);

		// Drop pending RAF batch updates for this thread so a delayed
		// onDidChangeStreamState doesn't resurrect a stale state.
		this._pendingStreamStateUpdates.delete(threadId);
		// Clear the submit-level watchdog timer if one is still pending.
		const submitTimer = this._submitWatchdogByThread.get(threadId);
		if (submitTimer !== undefined) {
			clearTimeout(submitTimer);
			this._submitWatchdogByThread.delete(threadId);
		}
		// Clear the age tracker so the next send doesn't see this thread as "stuck".
		this._streamStateSetAt.delete(threadId);
		// Cancel any pending rate-limit auto-resume so it can't fire after a manual reset.
		this._clearRateLimitResumeTimer(threadId);
		// Final: flip streamState to undefined. _setStreamState fires
		// onDidChangeStreamState so the UI's error block disappears.
		this._setStreamState(threadId, undefined);

		if (actuallyResetSomething) {
			vibeLog.warn('chatThread', `forceResetChatState(${threadId}) — state, watchdog, RAF, and age tracker all cleared.`);
			this._metricsService.capture('Chat Force Reset', {
				priorState: priorStateBeforeReset,
				priorAgeSec: Math.floor(priorAgeMs / 1000),
			});
		}
		return actuallyResetSomething;
	}

	/**
	 * Recreate the main-process transport (local client caches + shared cloud undici pool) before a
	 * stall retry, unless disabled via `vibeide.chat.hardStallAutoResetTransport`. A silent stall on a
	 * cloud provider is usually a wedged keep-alive pool; the user's manual workaround (switch provider /
	 * restart) just got a fresh pool — this automates it. Best-effort: a reset failure must not block the retry.
	 */
	private async _maybeResetTransportForStall(threadId: string, reason: 'auto-retry' | 'manual-retry'): Promise<void> {
		if (this._configurationService.getValue<boolean>('vibeide.chat.hardStallAutoResetTransport') === false) { return; }
		try {
			await this._llmMessageService.resetProviderClients();
			recordChatTrace('llmTurn:transport-reset', { reason });
			vibeLog.warn('chatThread', `[stall] transport reset before ${reason} (threadId=${threadId})`);
		} catch (e) {
			vibeLog.warn('chatThread', `[stall] transport reset failed (${reason}): ${getErrorMessage(e)}`);
		}
	}

	/** Cancel a pending rate-limit auto-resume timer (if any) so it can't fire on top of manual action. */
	private _clearRateLimitResumeTimer(threadId: string): void {
		const t = this._rateLimitResumeTimers.get(threadId);
		if (t !== undefined) { clearTimeout(t); this._rateLimitResumeTimers.delete(threadId); }
	}

	/** "Продолжить сейчас" on the rate-limit pause banner: skip the remaining wait and resume the turn now. */
	async resumeRateLimitPauseNow(threadId: string): Promise<void> {
		this._clearRateLimitResumeTimer(threadId);
		if (this.streamState[threadId]?.isRunning !== undefined) { return; } // already running / not paused
		this._setStreamState(threadId, { isRunning: undefined }); // clear pauseInfo before resuming
		this._runChatAgent({ threadId, ...this._currentModelSelectionProps() });
	}

	/** Plain-data snapshot for the stall diagnostics report (read by the collect command). */
	getStallDiagnosticsContext(threadId: string): { provider?: string; model?: string; hardStallSeconds: number; lastErrorMessage?: string } {
		const { modelSelection } = this._currentModelSelectionProps();
		return {
			provider: modelSelection?.providerName,
			model: modelSelection?.modelName,
			hardStallSeconds: readClampedNumberSetting(this._configurationService, 'vibeide.chat.streamHardStallSeconds', DEFAULT_HARD_STALL_SECONDS, 30, 1800),
			lastErrorMessage: this.streamState[threadId]?.error?.message,
		};
	}

	/** "Повторить с диагностикой": arm one-shot auto-collection, then retry (which resets transport). */
	async retryStalledStreamWithDiagnostics(threadId: string): Promise<void> {
		this._autoCollectStallDiagByThread.add(threadId);
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize('vibeide.chatThread.retryWithDiagnostics', 'Повтор в режиме диагностики: если стоп повторится, отчёт соберётся автоматически.'),
		});
		await this.retryStalledStream(threadId);
	}

	async retryStalledStream(threadId: string): Promise<void> {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		// find last user message
		let lastUserIdx = -1;
		for (let i = thread.messages.length - 1; i >= 0; i--) {
			if (thread.messages[i].role === 'user') { lastUserIdx = i; break; }
		}
		if (lastUserIdx === -1) { return; }
		const lastUserMsg = thread.messages[lastUserIdx];
		if (lastUserMsg.role !== 'user') { return; } // type narrow

		// interrupt the current stream WITHOUT committing partial assistant content (unlike abortRunning)
		// User-initiated edit-and-rerun: suppress the run-end notification sound for this thread.
		this._suppressStopSound(threadId);
		// A manual stall retry gets a fresh transport too (same wedged-pool reasoning as the auto-retry).
		await this._maybeResetTransportForStall(threadId, 'manual-retry');
		const interrupt = await this.streamState[threadId]?.interrupt;
		if (typeof interrupt === 'function') { interrupt(); }

		// truncate thread back to before the user message — preserves the user msg itself, drops all later (incl. partial assistant)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: { ...thread, messages: thread.messages.slice(0, lastUserIdx) }
			}
		});

		this._setStreamState(threadId, undefined);

		// re-send with original content + attachments
		await this._addUserMessageAndStreamResponse({
			userMessage: lastUserMsg.content || lastUserMsg.displayContent,
			_chatSelections: lastUserMsg.selections ?? undefined,
			threadId,
			images: lastUserMsg.images,
			pdfs: lastUserMsg.pdfs,
			displayContent: lastUserMsg.displayContent,
		});
	}

	async emergencyStopAllAgents(): Promise<number> {
		let n = 0;
		for (const threadId of Object.keys(this.streamState)) {
			const st = this.streamState[threadId];
			if (!st?.isRunning || st.isRunning === 'idle') {
				continue;
			}
			await this.abortRunning(threadId);
			n++;
		}
		return n;
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: unknown) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	};


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	/**
	 * Parses JSON tool call format from text response.
	 * Some models output tool calls as JSON text instead of using native tool calling.
	 * Example: {"name": "delete_file_or_folder", "arguments": {"uri": "/path", "is_recursive": true}}
	 */
	private _parseJSONToolCallFromText(text: string): { toolName: ToolName; toolParams: RawToolParamsObj } | null {
		try {
			// Try to find JSON object in text (may be wrapped in markdown code blocks or plain text)
			let jsonStr = text.trim();

			// Remove markdown code blocks if present
			const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
			if (codeBlockMatch) {
				jsonStr = codeBlockMatch[1].trim();
			}

			// Try to find JSON object pattern - be more flexible with whitespace
			// Look for opening brace, then try to find matching closing brace
			const openBraceIdx = jsonStr.indexOf('{');
			if (openBraceIdx === -1) {
				return null;
			}

			// Find matching closing brace
			let braceCount = 0;
			let closeBraceIdx = -1;
			for (let i = openBraceIdx; i < jsonStr.length; i++) {
				if (jsonStr[i] === '{') { braceCount++; }
				if (jsonStr[i] === '}') {
					braceCount--;
					if (braceCount === 0) {
						closeBraceIdx = i;
						break;
					}
				}
			}

			if (closeBraceIdx === -1) {
				return null;
			}

			const jsonSubstring = jsonStr.substring(openBraceIdx, closeBraceIdx + 1);
			const parsed = JSON.parse(jsonSubstring);

			// Check if it's a tool call format
			if (typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'name')) {
				const toolName = parsed.name;
				const toolParams = parsed.arguments || parsed.params || {};

				// Validate tool name is a valid ToolName
				// Note: We'll validate this when we try to use it
				if (typeof toolName === 'string' && typeof toolParams === 'object' && toolParams !== null) {
					return {
						toolName: toolName as ToolName,
						toolParams: toolParams as RawToolParamsObj
					};
				}
			}
		} catch (error) {
			// Not valid JSON or not a tool call format
			return null;
		}

		return null;
	}

	/**
	 * Synthesizes a tool call from user intent when the model refuses to use tools.
	 * This ensures Agent Mode works even with models that don't follow tool calling instructions.
	 */
	private _synthesizeToolCallFromIntent(userRequest: string, originalRequest: string): { toolName: string; toolParams: RawToolParamsObj } | null {
		const lowerRequest = userRequest.toLowerCase();

		// Extract key terms from the request
		const extractKeywords = (text: string): string[] => {
			const words = text.split(/\s+/).filter(w => w.length > 2);
			const stopWords = ['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'can', 'you', 'add', 'create', 'make', 'do'];
			return words.filter(w => !stopWords.includes(w.toLowerCase())).slice(0, 5);
		};

		// Handle web search queries - expanded patterns
		if (lowerRequest.includes('search the web') || lowerRequest.includes('search online') || lowerRequest.includes('look up') ||
			lowerRequest.includes('check the web') || lowerRequest.includes('check the internet') || lowerRequest.includes('check internet') ||
			lowerRequest.includes('look it up') || lowerRequest.includes('find information') ||
			lowerRequest.includes('tell me what you know about') || lowerRequest.includes('what do you know about') ||
			lowerRequest.includes('google') || lowerRequest.includes('duckduckgo') ||
			(lowerRequest.includes('search for') && lowerRequest.includes('on the web')) ||
			(lowerRequest.includes('search for') && lowerRequest.includes('on the internet')) ||
			(lowerRequest.includes('what is') || lowerRequest.includes('what are') || lowerRequest.includes('who is') || lowerRequest.includes('when did')) &&
			(lowerRequest.includes('latest') || lowerRequest.includes('current') || lowerRequest.includes('recent') || lowerRequest.includes('2024') || lowerRequest.includes('2025'))) {
			const keywords = extractKeywords(originalRequest);
			// For "tell me what you know about X", extract X
			let query = originalRequest;
			if (lowerRequest.includes('tell me what you know about') || lowerRequest.includes('what do you know about')) {
				const aboutMatch = originalRequest.match(/about\s+(.+)/i) || originalRequest.match(/know about\s+(.+)/i);
				if (aboutMatch) {
					query = aboutMatch[1].trim();
				} else {
					query = keywords.length > 0 ? keywords.join(' ') : originalRequest;
				}
			} else {
				query = keywords.length > 0 ? keywords.join(' ') : originalRequest;
			}
			return {
				toolName: 'web_search',
				toolParams: {
					query: query,
					k: '5'
				}
			};
		}

		// Handle URL browsing requests
		if (lowerRequest.includes('open url') || lowerRequest.includes('fetch url') || lowerRequest.includes('browse url') ||
			lowerRequest.includes('read url') || lowerRequest.includes('get content from') ||
			(lowerRequest.match(/https?:\/\//) && (lowerRequest.includes('read') || lowerRequest.includes('open') || lowerRequest.includes('fetch')))) {
			const urlMatch = originalRequest.match(/(https?:\/\/[^\s]+)/i);
			if (urlMatch) {
				return {
					toolName: 'browse_url',
					toolParams: {
						url: urlMatch[1]
					}
				};
			}
		}

		// Handle codebase queries - need to search for relevant files to answer
		if (lowerRequest.includes('codebase') || lowerRequest.includes('code base') || lowerRequest.includes('repository') || lowerRequest.includes('repo') ||
			(lowerRequest.includes('what') && (lowerRequest.includes('project') || lowerRequest.includes('about'))) ||
			(lowerRequest.includes('how many') && (lowerRequest.includes('endpoint') || lowerRequest.includes('api')))) {
			// User is asking about the codebase - search for overview files first
			const keywords = extractKeywords(originalRequest);
			const query = keywords.length > 0 ? keywords.join(' ') : 'readme package.json server api route endpoint';

			return {
				toolName: 'search_for_files',
				toolParams: {
					query: query
				}
			};
		}

		// Determine intent and synthesize appropriate tool call
		if (lowerRequest.includes('endpoint') || lowerRequest.includes('route') || lowerRequest.includes('api')) {
			// User wants to add an endpoint - start by searching for server/route files
			const keywords = extractKeywords(originalRequest).filter(k => !['dummy', 'endpoint', 'backend'].includes(k.toLowerCase()));
			const query = keywords.length > 0 ? keywords.join(' ') : 'server route api endpoint';

			return {
				toolName: 'search_for_files',
				toolParams: {
					query: query
				}
			};
		} else if (lowerRequest.includes('file') && (lowerRequest.includes('create') || lowerRequest.includes('add') || lowerRequest.includes('make'))) {
			// User wants to create a file
			const keywords = extractKeywords(originalRequest);
			const fileName = keywords.find(k => k.includes('.') || k.length > 3) || 'newfile';

			return {
				toolName: 'create_file_or_folder',
				toolParams: {
					uri: fileName.startsWith('/') ? fileName : `/${fileName}`,
					type: 'file'
				}
			};
		} else if (lowerRequest.includes('open')) {
			// User wants to open a file in the editor
			const fileMatch = originalRequest.match(/([\w\/\.\-]+\.\w+)/i) ||
				originalRequest.match(/open\s+([\w\/\.\-]+)/i);
			if (fileMatch) {
				return {
					toolName: 'open_file',
					toolParams: {
						uri: fileMatch[1]
					}
				};
			}
		} else if (lowerRequest.includes('read') || lowerRequest.includes('show') || lowerRequest.includes('view')) {
			// User wants to read a file
			const fileMatch = originalRequest.match(/([\w\/\.\-]+\.\w+)/i);
			if (fileMatch) {
				return {
					toolName: 'read_file',
					toolParams: {
						uri: fileMatch[1],
						start_line: '1',
						end_line: '100'
					}
				};
			}
		} else if (lowerRequest.includes('add') && (lowerRequest.includes('comment') || lowerRequest.includes('note') || lowerRequest.includes('todo'))) {
			// User wants to add a comment - need to find the file first
			// Extract file name from request (e.g., "add comment to test.js" -> "test.js")
			const fileMatch = originalRequest.match(/(?:to|in|on|at)\s+([\w\/\.\-]+\.\w+)/i) ||
				originalRequest.match(/([\w\/\.\-]+\.\w+)/i);
			if (fileMatch) {
				return {
					toolName: 'read_file',
					toolParams: {
						uri: fileMatch[1],
						start_line: '1',
						end_line: '100'
					}
				};
			}
			// If no file specified, search for likely files
			const keywords = extractKeywords(originalRequest).filter(k => !['comment', 'note', 'todo', 'add'].includes(k.toLowerCase()));
			return {
				toolName: 'search_for_files',
				toolParams: {
					query: keywords.length > 0 ? keywords.join(' ') : 'file'
				}
			};
		} else if (lowerRequest.includes('edit') || lowerRequest.includes('modify') || lowerRequest.includes('change') || lowerRequest.includes('update')) {
			// User wants to edit a file - first need to find/read it
			const fileMatch = originalRequest.match(/(?:to|in|on|at)\s+([\w\/\.\-]+\.\w+)/i) ||
				originalRequest.match(/([\w\/\.\-]+\.\w+)/i);
			if (fileMatch) {
				return {
					toolName: 'read_file',
					toolParams: {
						uri: fileMatch[1],
						start_line: '1',
						end_line: '100'
					}
				};
			}
			const keywords = extractKeywords(originalRequest);
			return {
				toolName: 'search_for_files',
				toolParams: {
					query: keywords.join(' ') || 'file'
				}
			};
		}

		// Default: search for relevant files based on request
		const keywords = extractKeywords(originalRequest);
		return {
			toolName: 'search_for_files',
			toolParams: {
				query: keywords.join(' ') || originalRequest.slice(0, 50)
			}
		};
	}

	private async _buildEditContext(
		toolName: ToolName,
		toolParams: ToolCallParams<ToolName>,
		threadId: string
	): Promise<EditContext> {
		let uri: URI;
		let originalContent: string | undefined;
		let newContent: string | undefined;
		let textEdits: TextEdit[] | undefined;
		let operation: EditContext['operation'];

		// Get URI and operation type
		if (toolName === 'rewrite_file') {
			const params = toolParams as BuiltinToolCallParams['rewrite_file'];
			uri = params.uri;
			newContent = params.newContent;
			operation = 'rewrite_file';

			// Try to get original content
			try {
				const model = this._modelService.getModel(uri);
				if (model) {
					originalContent = model.getValue();
				}
			} catch {
				// Model not available
			}
		} else if (toolName === 'edit_file') {
			const params = toolParams as BuiltinToolCallParams['edit_file'];
			uri = params.uri;
			operation = 'edit_file';

			// Parse searchReplaceBlocks to extract text edits
			// This is a simplified version - actual parsing would need to handle the searchReplaceBlocks format
			// For now, we'll just check if file was read
			try {
				const model = this._modelService.getModel(uri);
				if (model) {
					originalContent = model.getValue();
				}
			} catch {
				// Model not available
			}
		} else if (toolName === 'create_file_or_folder') {
			const params = toolParams as BuiltinToolCallParams['create_file_or_folder'];
			uri = params.uri;
			operation = 'create_file_or_folder';
		} else if (toolName === 'delete_file_or_folder') {
			const params = toolParams as BuiltinToolCallParams['delete_file_or_folder'];
			uri = params.uri;
			operation = 'delete_file_or_folder';

			// Try to get original content before deletion
			try {
				const model = this._modelService.getModel(uri);
				if (model) {
					originalContent = model.getValue();
				}
			} catch {
				// Model not available
			}
		} else {
			throw new Error(`Unsupported tool for edit context: ${toolName}`);
		}

		// Check if file was read before (by checking thread history)
		let fileWasRead = false;
		try {
			const thread = this.state.allThreads[threadId];
			if (thread) {
				// Check if read_file was called for this URI in recent messages
				for (const message of thread.messages) {
					if (message.role === 'tool' && message.name === 'read_file') {
						// Check if message has params (not invalid_params type)
						if (message.type !== 'invalid_params') {
							const readParams = message.params as BuiltinToolCallParams['read_file'];
							if (readParams && readParams.uri.fsPath === uri.fsPath) {
								fileWasRead = true;
								break;
							}
						}
					}
				}
			}
		} catch {
			// Ignore errors
		}

		// Get model selection from thread state (if available)
		// Model selection is stored in the thread's last assistant message or stream state
		let modelSelection: ModelSelection | undefined;
		try {
			const thread = this.state.allThreads[threadId];
			if (thread) {
				// Try to get from the most recent assistant message that has model selection
				for (let i = thread.messages.length - 1; i >= 0; i--) {
					const msg = thread.messages[i];
					// `modelSelection` is not part of the assistant message type but may be present
					// at runtime on legacy/persisted threads — read it defensively without widening.
					if (msg.role === 'assistant' && Object.hasOwn(msg, 'modelSelection')) {
						modelSelection = (msg as { modelSelection?: ModelSelection }).modelSelection;
						break;
					}
				}
			}
		} catch {
			// Ignore errors
		}

		// Count total files in operation (simplified - assume 1 for now)
		// In a real implementation, we'd track batched operations
		const totalFilesInOperation = 1;

		return {
			uri,
			originalContent,
			newContent,
			textEdits,
			operation,
			fileWasRead,
			modelSelection: modelSelection ? {
				providerName: modelSelection.providerName,
				modelName: modelSelection.modelName,
			} : undefined,
			totalFilesInOperation,
		};
	}

	private _showAutoApplyNotification(
		editContext: EditContext,
		riskScore: EditRiskScore,
		toolName: ToolName
	): void {
		const fileName = editContext.uri.path.split('/').pop() || editContext.uri.path;
		const operationLabel = toolName === 'rewrite_file' ? 'rewritten' :
			toolName === 'edit_file' ? 'edited' :
				toolName === 'create_file_or_folder' ? 'created' :
					'modified';

		// Show brief, non-intrusive notification
		// Not sticky, auto-dismisses after a few seconds
		// Info severity (not warning) to be less intrusive
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize('yolo.autoApplied', 'Автоприменено: {0} → {1}', operationLabel, fileName),
			source: 'YOLO Mode',
			sticky: false, // Auto-dismiss
			actions: {
				primary: [{
					id: 'yolo.undo',
					label: localize('yolo.undo', 'Отменить'),
					tooltip: localize('yolo.undoTooltip', 'Отменить эту правку'),
					class: undefined,
					enabled: true,
					run: async () => {
						// Trigger undo for the file
						try {
							await this._commandService.executeCommand('undo', editContext.uri);
							this._metricsService.capture('yolo_undo_clicked', {
								operation: toolName,
								riskScore: riskScore.riskScore,
							});
						} catch (error) {
							// Undo failed, show error
							this._notificationService.warn(localize('yolo.undoFailed', 'Не удалось отменить правку. Используйте Ctrl+Z вручную.'));
						}
					},
				}],
			},
		});
	}

	/**
	 * Anti-loop guard. Records this tool-call's signature in a small rolling per-thread window and, if
	 * the SAME signature has occurred >= TOOL_LOOP_THRESHOLD times within the last TOOL_LOOP_WINDOW
	 * calls, appends a directive to the tool result telling the model to stop repeating and change
	 * approach. Returns the (possibly augmented) result string. Pure-ish: only mutates `_recentToolSigs`.
	 */
	private _maybeAppendToolLoopNudge(threadId: string, toolName: string, toolParams: unknown, resultStr: string): string {
		let sig: string;
		try { sig = `${toolName}|${JSON.stringify(toolParams)}`; } catch { sig = toolName; }

		const window = this._recentToolSigs.get(threadId) ?? [];
		window.push(sig);
		while (window.length > ChatThreadService.TOOL_LOOP_WINDOW) { window.shift(); }
		this._recentToolSigs.set(threadId, window);

		const repeats = window.filter(s => s === sig).length;
		if (repeats < ChatThreadService.TOOL_LOOP_THRESHOLD) { return resultStr; }

		// Observability — surfaces in the console the user is already watching (no _agentActivityLog,
		// to avoid coupling a non-error event to the error circuit-breaker).
		vibeLog.warn('toolLoop', 'repeated identical tool call', { tool: toolName, repeats, window: window.length });

		// Escalate the wording once it's clearly stuck, so the directive is harder to ignore.
		const nudge = repeats >= ChatThreadService.TOOL_LOOP_ESCALATE_THRESHOLD
			? `\n\n[STOP — you have called "${toolName}" with identical arguments ${repeats} times and the result has NOT changed. Do not call it again. Switch strategy entirely: act on what you already gathered, ask the user a clarifying question, or finalize your answer.]`
			: `\n\n[Loop detected: you have called "${toolName}" with identical arguments ${repeats} times in the last ${window.length} tool calls — the result is not changing. STOP repeating this call. Use what you have already gathered, try materially different arguments, or move on to the next concrete step toward the user's goal.]`;
		return resultStr + nudge;
	}

	private _runToolCall = async (
		threadId: string,
		requestedToolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true; unvalidatedToolParams: RawToolParamsObj; validatedParams: ToolCallParams<ToolName> } | { preapproved: false; unvalidatedToolParams: RawToolParamsObj },
	): Promise<{ awaitingUserApproval?: boolean; interrupted?: boolean }> => {

		// Repair short-circuits applied before main dispatch:
		//
		// 1. `invalid` pseudo-tool — aiSdkAdapter's experimental_repairToolCall
		//    reroutes unknown tool names (numeric "2", invented identifiers) to
		//    this reserved name with the original tool + error packed in input.
		//    Emit a brief tool_error matching Kilo Code's invalid tool output
		//    (packages/opencode/src/tool/invalid.ts). No tool-name list: the
		//    model already has its inventory from the system prompt; re-listing
		//    it re-triggers the same index-vs-name quirk.
		//
		// 2. Case-mismatch fallback — legacy LLM channels (Anthropic native,
		//    Gemini native, XML fallback) don't run through the AI SDK repair
		//    hook. Apply the same lowercase normalisation here so Read_File /
		//    BASH / READ resolve to read_file / bash / read instead of falling
		//    through to "unknown tool". Bound to a fresh `const` so downstream
		//    narrowing via `isABuiltinToolName(toolName)` is preserved
		//    (TypeScript drops type-guard narrowing when the storage is `let`).
		if (requestedToolName === 'invalid') {
			const rawParams = opts.unvalidatedToolParams as { tool?: string; error?: string };
			const reason = rawParams?.error || 'Unknown tool name';
			// AI SDK's NoSuchToolError sometimes includes the available-tools
			// inventory in `error.message`, sometimes not (varies by version
			// and upstream). Append our own inventory only when the SDK didn't
			// already mention "available" — gives minimax/qwen models the real
			// tool names to recover from their numeric-naming training quirk.
			const reasonLower = reason.toLowerCase();
			const sdkAlreadyListsTools = reasonLower.includes('available tool');
			const mcpTools = this._mcpService.getMCPTools() ?? [];
			const inventoryNote = sdkAlreadyListsTools
				? ''
				: ` Available built-in tools: ${builtinToolNames.join(', ')}. Available MCP tools: ${mcpTools.map(t => t.name).join(', ') || '(none)'}.`;
			const message = `The arguments provided to the tool are invalid: ${reason}${inventoryNote}`;
			this._addMessageToThread(threadId, {
				role: 'tool',
				type: 'tool_error',
				params: {},
				rawParams: opts.unvalidatedToolParams,
				result: message,
				name: requestedToolName,
				content: message,
				id: toolId,
				mcpServerName,
			});
			return {};
		}
		// Shape-based tool-name correction (BEFORE alias resolution). Aggregator-
		// proxied models often emit the RIGHT params under the WRONG tool name,
		// which otherwise loops on invalid_params and burns the token budget
		// (model-stalls #010). Pure routing logic + rationale live in
		// toolAliases.detectToolByParamShape (unit-tested); it matches the param
		// SHAPE, never the model name.
		const paramsObjForShape = opts.unvalidatedToolParams as Record<string, unknown> | undefined;
		let effectiveRequestedToolName: ToolName = requestedToolName;
		const shapeTarget = detectToolByParamShape(paramsObjForShape, requestedToolName as string);
		if (shapeTarget && shapeTarget !== (requestedToolName as string) && isABuiltinToolName(shapeTarget)) {
			const keys = Object.keys(paramsObjForShape ?? {});
			vibeLog.warn('Tool', `auto-routing ${requestedToolName} → ${shapeTarget} (${shapeTarget}-shape params)`, {
				originalTool: requestedToolName,
				target: shapeTarget,
				keys,
			});
			// Observability: how often (and from which wrong name) models misalign
			// tool-name <-> params shape. Mirrors the breaker metric so the
			// model-stalls investigation has aggregated signal, not just console logs.
			this._metricsService.capture('Tool Auto-Routed By Shape', {
				fromTool: requestedToolName,
				toTool: shapeTarget,
				paramKeysSig: keys.slice().sort().join(','),
			});
			effectiveRequestedToolName = shapeTarget as ToolName;
		}

		// Resolve raw tool name to canonical VibeIDE name via aliases. Stages:
		//   1. Exact match (`isABuiltinToolName(raw)`) — already a real name.
		//   2. Lowercase match (`Read_File` → `read_file`).
		//   3. Cross-ecosystem alias (`read` → `read_file`, `bash` → `run_command`,
		//      Kilo's `apply_patch` → `edit_file`, etc.) via TOOL_NAME_ALIASES.
		// Same map is applied at AI SDK repair (aiSdkAdapter.ts) and XML extraction
		// (extractGrammar.ts) — single source of truth in common/prompt/toolAliases.
		// Bound to a `const` so downstream TypeScript narrowing via type guards is
		// preserved (a `let` parameter breaks `isABuiltinToolName(toolName)` flow).
		const loweredRequested = (effectiveRequestedToolName as string).toLowerCase();
		const toolName: ToolName = (
			isABuiltinToolName(effectiveRequestedToolName) ? effectiveRequestedToolName :
				isABuiltinToolName(loweredRequested) ? loweredRequested as ToolName :
					(TOOL_NAME_ALIASES[loweredRequested] && isABuiltinToolName(TOOL_NAME_ALIASES[loweredRequested]))
						? TOOL_NAME_ALIASES[loweredRequested] as ToolName
						: effectiveRequestedToolName
		);

		// Param-name aliases (`{path: ...}` → `{uri: ...}`, `{filePath: ...}` →
		// `{uri: ...}`, Kilo's `{offset, limit}` → `{start_line, line_limit}`).
		// Applied here for AI SDK native function-calling and legacy native
		// channels — XML extraction already applies it via resolveInvokeParamName.
		// Without this, minimax/qwen reading a file with `{path: ...}` fails
		// validation with "Provided uri must be a string, but it's a(n) undefined".
		const aliasedParams = applyParamAliases(toolName as string, opts.unvalidatedToolParams) as RawToolParamsObj;
		if (aliasedParams !== opts.unvalidatedToolParams) {
			opts = opts.preapproved
				? { ...opts, unvalidatedToolParams: aliasedParams }
				: { ...opts, unvalidatedToolParams: aliasedParams };
		}

		// compute these below
		let toolParams: ToolCallParams<ToolName>;
		let toolResult: ToolResult<ToolName>;
		let toolResultStr: string;

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName);

		// Circuit breaker for invalid_params loops. If the last N tool messages
		// were all `invalid_params` for the same tool with the same param-shape
		// signature, the model is stuck (typical for aggregator-proxied models
		// that misalign tool-name ↔ params shape). Abort with a clear user-facing
		// error instead of bouncing more schema hints — which only enlarge the
		// loop and eventually OOM the renderer. Threshold configurable via
		// `vibeide.chat.toolInvalidParamsCircuitBreakerThreshold` — parallel to
		// the empty-response breaker (Stage K), so both repetitive failure
		// classes have consistent tunability.
		const invalidParamsBreakerLimit = Math.max(1, Math.min(20,
			this._configurationService.getValue<number>('vibeide.chat.toolInvalidParamsCircuitBreakerThreshold') ?? 3
		));
		const currentParamKeysSig = paramsObjForShape && typeof paramsObjForShape === 'object'
			? Object.keys(paramsObjForShape).slice().sort().join(',')
			: '';
		const threadForBreaker = this.state.allThreads[threadId];
		const recentToolMessages = (threadForBreaker?.messages ?? [])
			.filter(m => m.role === 'tool')
			.slice(-invalidParamsBreakerLimit);
		const sameLoop = recentToolMessages.length >= invalidParamsBreakerLimit && recentToolMessages.every(m =>
			m.role === 'tool' &&
			m.type === 'invalid_params' &&
			m.name === toolName &&
			(m.rawParams && typeof m.rawParams === 'object'
				? Object.keys(m.rawParams).slice().sort().join(',') === currentParamKeysSig
				: false)
		);
		// Thrash breaker: `sameLoop` above only fires when the model repeats the
		// EXACT same (tool, param-shape). Aggregator-proxied models instead thrash
		// across DIFFERENT wrong combos (run_command<-{uri}, then read_file<-
		// {query,...}), which never satisfies sameLoop yet still burns the whole
		// token budget. Trip when the last M tool messages are ALL invalid_params
		// (any tool/shape) -- no successful tool call broke the streak. M > 2 so a
		// model that self-corrects within a couple tries (incident #006) isn't cut off.
		const thrashBreakerLimit = Math.max(3, Math.min(20,
			this._configurationService.getValue<number>('vibeide.chat.toolInvalidParamsThrashBreakerThreshold') ?? 6
		));
		const recentForThrash = (threadForBreaker?.messages ?? [])
			.filter(m => m.role === 'tool')
			.slice(-thrashBreakerLimit);
		const thrashLoop = recentForThrash.length >= thrashBreakerLimit
			&& recentForThrash.every(m => m.role === 'tool' && m.type === 'invalid_params');
		if (sameLoop || thrashLoop) {
			const isThrash = thrashLoop && !sameLoop;
			const keysLabel = currentParamKeysSig || '(без параметров)';
			const breakerMsg = isThrash
				? `Прервано: модель ${thrashBreakerLimit + 1} раз подряд вызвала инструменты с неверными параметрами (последний — "${toolName}", ключи: ${keysLabel}). Похоже на петлю рассинхрона «инструмент ↔ параметры» — переключитесь на другую модель или начните новый чат.`
				: `Прервано: модель ${invalidParamsBreakerLimit + 1} раз подряд вызвала "${toolName}" с одной и той же неверной формой параметров (${keysLabel}). Похоже на петлю — переключитесь на другую модель или начните новый чат.`;
			vibeLog.warn('Tool', 'circuit breaker tripped', { toolName, keys: currentParamKeysSig, mode: isThrash ? 'thrash' : 'same-shape' });
			this._metricsService.capture('Circuit Breaker Tripped — Tool Invalid Params', {
				toolName,
				paramKeysSig: currentParamKeysSig,
				breakerLimit: isThrash ? thrashBreakerLimit : invalidParamsBreakerLimit,
				mode: isThrash ? 'thrash' : 'same-shape',
			});
			this._addMessageToThread(threadId, {
				role: 'tool',
				type: 'tool_error',
				params: {},
				rawParams: opts.unvalidatedToolParams,
				result: breakerMsg,
				name: toolName,
				content: breakerMsg,
				id: toolId,
				mcpServerName,
			});
			this._setStreamState(threadId, {
				isRunning: undefined,
				error: { message: breakerMsg, fullError: null },
			});
			return { interrupted: true };
		}

		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					let params;
					try {
						params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams);
					} catch (e) {
						// Variant B — outside-workspace access needs authorization. Prompt async,
						// and on approval re-validate (the folder is now in the allowlist). On deny,
						// rethrow so the normal validation-error path reports the refusal.
						if (e instanceof ExternalAccessRequiredError) {
							const granted = await this._externalAccessService.requestAccess(e.uri);
							if (!granted) { throw e; }
							params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams);
						} else {
							throw e;
						}
					}
					toolParams = params;
				}
				else {
					toolParams = opts.unvalidatedToolParams;
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error);
				// Diagnostic dump of the exact tool-call shape that failed validation.
				// Logs the validator's complaint + the raw JSON the model emitted. Lets us
				// see at a glance whether the model hallucinated a path (e.g. C:\Repo\...
				// instead of d:\Projects\...), missed a required field, sent wrong types,
				// or wrapped the params in some unexpected envelope. Without this we only
				// see the UI's "Invalid parameters" badge and have to guess.
				try {

					vibeLog.warn('Tool', 'invalid params', {
						toolName,
						errorMessage,
						rawParams: opts.unvalidatedToolParams,
						rawParamsJson: (() => { try { return JSON.stringify(opts.unvalidatedToolParams); } catch { return '<unserializable>'; } })(),
						rawParamsKeys: opts.unvalidatedToolParams && typeof opts.unvalidatedToolParams === 'object'
							? Object.keys(opts.unvalidatedToolParams as Record<string, unknown>)
							: null,
					});
				} catch { /* logging must never throw — swallow */ }
				// Aggregated signal on which tool <-> params-shape mismatches the
				// shape-router does NOT yet handle (drives data-gated routing work,
				// e.g. pattern-shape -> grep/glob). Sorted key signature only, no values.
				this._metricsService.capture('Tool Invalid Params', {
					toolName,
					paramKeysSig: opts.unvalidatedToolParams && typeof opts.unvalidatedToolParams === 'object'
						? Object.keys(opts.unvalidatedToolParams as Record<string, unknown>).slice().sort().join(',')
						: '',
				});
				// Wrap raw validator output with a CONCRETE schema hint. Otherwise the
				// model sees just "Provided uri must be a string, but it's a(n) undefined"
				// and doesn't know which field name is required or in what XML shape.
				// We inject the tool's full parameter list (required first, then optional)
				// with descriptions and an example XML call. This is the difference
				// between "fix something" and "fix uri specifically — example below".
				// Extract param keys from rawParams for smart-suggest (X.11.4 / X.13.7).
				const rawKeysForHint = opts.unvalidatedToolParams && typeof opts.unvalidatedToolParams === 'object'
					? Object.keys(opts.unvalidatedToolParams as Record<string, unknown>)
					: [];
				const schemaHint = buildToolSchemaHint(toolName as string, rawKeysForHint);
				const content = schemaHint
					? `The tool "${toolName}" was called with invalid arguments: ${errorMessage}\n\n${schemaHint}\n\nRe-issue the call with all required parameters present and correctly typed.`
					: `The tool "${toolName}" was called with invalid arguments: ${errorMessage} Re-issue the call with all required parameters present.`;
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content, id: toolId, mcpServerName });
				return {};
			}
			// once validated, add checkpoint for edit
			if (toolName === 'edit_file') { await this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri }); }
			if (toolName === 'rewrite_file') { await this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri }); }

			// 2. if tool requires approval, break from the loop, awaiting approval

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools';
			if (approvalType) {
				const chatAgentAutopilot = this._settingsService.state.globalSettings.chatAgentAutopilot === true;

				// Check YOLO mode for edit operations
				const isEditOperation = isBuiltInTool && (
					toolName === 'edit_file' ||
					toolName === 'rewrite_file' ||
					toolName === 'create_file_or_folder' ||
					toolName === 'delete_file_or_folder'
				);

				// Check YOLO mode for NL shell commands
				const isNLCommand = isBuiltInTool && toolName === 'run_nl_command';

				// Only explicit autoApprove[type] === true opts in; undefined/false → ask (safe default)
				let shouldAutoApprove = this._settingsService.state.globalSettings.autoApprove[approvalType] === true;
				let riskScore: { riskScore: number; confidenceScore: number; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; riskFactors: string[]; confidenceFactors: string[] } | undefined;

				// If YOLO mode is enabled and this is an NL command, check if it's safe
				if (isNLCommand && this._settingsService.state.globalSettings.enableYOLOMode) {
					try {
						const nlParams = toolParams as BuiltinToolCallParams['run_nl_command'];
						const nlInput = nlParams.nlInput.toLowerCase();

						// Simple heuristics for safe commands (read-only, informational)
						const safePatterns = ['list', 'show', 'check', 'status', 'get', 'display', 'print', 'view', 'read', 'cat', 'ls', 'pwd', 'whoami', 'date', 'time'];
						const dangerousPatterns = ['delete', 'remove', 'rm', 'kill', 'destroy', 'format', 'reset', 'clear', 'drop', 'truncate', 'sudo', 'chmod', 'chown'];

						const isSafe = safePatterns.some(pattern => nlInput.includes(pattern)) &&
							!dangerousPatterns.some(pattern => nlInput.includes(pattern));

						if (isSafe) {
							shouldAutoApprove = true;
							// Track YOLO auto-approval metric
							this._metricsService.capture('yolo_auto_approved', {
								operation: toolName,
								nlInput: nlInput.substring(0, 50), // Truncate for privacy
							});
						}
					} catch (error) {
						// If check fails, fall back to normal approval flow
						vibeLog.debug('chatThread', '[ChatThreadService] NL command safety check failed, using normal approval:', error);
					}
				}

				// If this is an edit operation, score the risk (for both YOLO mode and to respect autoApprove safely)
				if (isEditOperation) {
					try {
						const editContext = await this._buildEditContext(toolName, toolParams, threadId);
						riskScore = await this._editRiskScoringService.scoreEdit(editContext);

						// If autoApprove is enabled, respect it for LOW and MEDIUM risk operations
						// HIGH risk still requires approval unless Autopilot is on (handled below)
						if (shouldAutoApprove && riskScore.riskLevel === 'HIGH' && !chatAgentAutopilot) {
							// High-risk edits require approval when not in Autopilot
							shouldAutoApprove = false;
							// Track high-risk blocked metric
							this._metricsService.capture('high_risk_blocked_despite_autoapprove', {
								riskScore: riskScore.riskScore,
								confidenceScore: riskScore.confidenceScore,
								operation: toolName,
							});
						}

						// If YOLO mode is enabled, use risk thresholds for additional auto-approval
						if (this._settingsService.state.globalSettings.enableYOLOMode) {
							const yoloRiskThreshold = this._settingsService.state.globalSettings.yoloRiskThreshold ?? 0.2;
							const yoloConfidenceThreshold = this._settingsService.state.globalSettings.yoloConfidenceThreshold ?? 0.7;

							// Auto-approve if risk is low and confidence is high (even if autoApprove wasn't explicitly set)
							if (riskScore.riskScore < yoloRiskThreshold && riskScore.confidenceScore > yoloConfidenceThreshold) {
								shouldAutoApprove = true;
								// Track YOLO auto-approval metric
								this._metricsService.capture('yolo_auto_approved', {
									riskScore: riskScore.riskScore,
									confidenceScore: riskScore.confidenceScore,
									riskLevel: riskScore.riskLevel,
									operation: toolName,
								});

								// Show non-intrusive notification for medium-risk auto-applies (not very low risk)
								// Very low risk (< 0.1) edits are silent to avoid notification fatigue
								if (riskScore.riskScore >= 0.1) {
									this._showAutoApplyNotification(editContext, riskScore, toolName);
								}
							}
						}
					} catch (error) {
						// If risk scoring fails, fall back to normal approval flow
						// If autoApprove was already true, keep it true (don't block due to scoring failure)
						vibeLog.debug('chatThread', '[ChatThreadService] Risk scoring failed, using normal approval:', error);
					}
				}

				// Autopilot: run tools without confirmation (incl. deletions, terminal, MCP)
				if (chatAgentAutopilot) {
					shouldAutoApprove = true;
				}

				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				const requestContent = riskScore && riskScore.riskLevel !== 'LOW'
					? `(Risk: ${riskScore.riskLevel}, Score: ${riskScore.riskScore.toFixed(2)}, Confidence: ${riskScore.confidenceScore.toFixed(2)})`
					: '(Awaiting user permission...)';
				this._addMessageToThread(threadId, {
					role: 'tool',
					type: 'tool_request',
					content: requestContent,
					result: null,
					name: toolName,
					params: toolParams,
					id: toolId,
					rawParams: opts.unvalidatedToolParams,
					mcpServerName
				});

				if (!shouldAutoApprove) {
					return { awaitingUserApproval: true };
				}
			}
		}
		else {
			toolParams = opts.validatedParams;
		}

		// Check for duplicate read_file calls after validation but before execution
		if (toolName === 'read_file' && isBuiltInTool) {
			const readFileParams = toolParams as BuiltinToolCallParams['read_file'];
			const cacheKey = `${readFileParams.uri.fsPath}|${readFileParams.startLine ?? 'null'}|${readFileParams.endLine ?? 'null'}|${readFileParams.pageNumber ?? 1}`;

			// Check cache
			let threadCache = this._fileReadCache.get(threadId);
			if (!threadCache) {
				threadCache = new Map();
				this._fileReadCache.set(threadId, threadCache);
			}

			const cachedResult = threadCache.get(cacheKey);
			if (cachedResult) {
				// Found cached result - reuse it instead of reading again
				// Update LRU: move to end (most recently used)
				const lruList = this._fileReadCacheLRU.get(threadId) || [];
				const lruIndex = lruList.indexOf(cacheKey);
				if (lruIndex >= 0) {
					lruList.splice(lruIndex, 1);
				}
				lruList.push(cacheKey);
				this._fileReadCacheLRU.set(threadId, lruList);

				toolResult = cachedResult as ToolResult<ToolName>;
				toolResultStr = this._toolsService.stringOfResult['read_file'](readFileParams, cachedResult);

				// Add cached result to thread (mark as cached for transparency)
				this._agentActivityLog.logStarted('read_file (cached result)');
				this._agentActivityLog.logFinished('read_file (cached result)');
				this._updateLatestTool(threadId, {
					role: 'tool',
					type: 'success',
					params: readFileParams,
					result: toolResult,
					name: 'read_file',
					content: toolResultStr + '\n\n(Result reused from cache)',
					id: toolId,
					rawParams: opts.unvalidatedToolParams,
					mcpServerName
				});
				return {};
			}
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const;
		this._updateLatestTool(threadId, runningTool);

		const toolActivityLabel = mcpServerName ? `${toolName} (${mcpServerName})` : toolName;
		this._agentActivityLog.logStarted(toolActivityLabel);

		// DURABLE tool-execution trace (kept — complements [VibeIDE/llmTurn], which only
		// times the LLM turn, not the tool run where the agent actually stalls in
		// phase=tool-running). A hung tool shows `start` with NO matching `done` → the
		// exact tool + input that hung; a slow one shows a large `ms`.
		const _toolExecStartMs = Date.now();
		const _toolHint = (() => {
			try {
				const p: Record<string, unknown> = toolParams ?? {};
				const uriVal = p.uri;
				const fsPath = uriVal && typeof uriVal === 'object' && Object.hasOwn(uriVal, 'fsPath') ? (uriVal as { fsPath?: unknown }).fsPath : undefined;
				const v = fsPath ?? uriVal ?? p.query ?? p.pattern ?? p.command ?? p.search ?? '';
				return typeof v === 'string' ? v.slice(0, 160) : '';
			} catch { return ''; }
		})();
		vibeLog.debug('toolExec', 'start', { tool: toolName, hint: _toolHint, mcp: mcpServerName ?? null }); recordChatTrace('toolExec:start', { tool: toolName, hint: _toolHint });

		let interrupted = false;
		let resolveInterruptor: (r: () => void) => void = () => { };
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res; });
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } });

			if (isBuiltInTool) {
				const { result, interruptTool } = await this._toolsService.callTool[toolName](toolParams as never);
				const interruptor = () => { interrupted = true; interruptTool?.(); };
				resolveInterruptor(interruptor);

				toolResult = await result;
			}
			else {
				const mcpTools = this._mcpService.getMCPTools();
				const mcpTool = mcpTools?.find(t => t.name === toolName);
				if (!mcpTool) {
					// Positional fallback BEFORE giving up: some models (minimax-m2.x,
					// qwen variants) emit numeric tool names that index into the tool
					// array we sent. Map `"5"` → 5-th tool in availableTools order
					// (matches what the model saw in our request body). Same logic
					// as aiSdkAdapter's repair-hook stage 3 — duplicated here for
					// the XML/legacy path which bypasses AI SDK's repair entirely.
					if (/^\d+$/.test(String(toolName))) {
						const idx = parseInt(String(toolName), 10);
						const currentChatMode = this._settingsService.state.globalSettings.chatMode;
						const allTools = availableTools(currentChatMode, mcpTools) ?? [];
						if (idx >= 0 && idx < allTools.length) {
							const positionalToolName = allTools[idx].name as ToolName;
							// Re-dispatch by recursing with the resolved name. Same
							// opts (preapproved status, params) — model's params should
							// match the intended tool since it identified the tool by
							// description in our array before formatting as index.
							return this._runToolCall(threadId, positionalToolName, toolId, mcpServerName, opts);
						}
					}

					// Unknown tool name on legacy channels (XML fallback, Anthropic
					// native, Gemini native, OpenAI native) — emit a soft tool_error,
					// no throw. Format note: numeric tool names that DIDN'T resolve
					// positionally (index out of range) drop here with the inventory
					// hint so the model has a chance to swap to a real identifier.
					resolveInterruptor(() => { });
					const builtinList = builtinToolNames.join(', ');
					const mcpList = (mcpTools ?? []).map(t => t.name).join(', ') || '(none)';
					const isNumericQuirk = /^\d+$/.test(String(toolName));
					const message = isNumericQuirk
						? `Tool name "${toolName}" is invalid. Tool names must be lowercase snake_case identifiers, NEVER numeric indices. Pick one of the available tools by its exact name. Examples: read_file (read file contents), ls_dir (list directory), run_command (run shell command), edit_file (modify file via SEARCH/REPLACE blocks). Full list: ${builtinList}. MCP tools: ${mcpList}.`
						: `The arguments provided to the tool are invalid: Unknown tool name "${toolName}". Available built-in tools: ${builtinList}. Available MCP tools: ${mcpList}.`;
					this._agentActivityLog.logError(`${toolActivityLabel}: ${message}`);
					this._updateLatestTool(threadId, {
						role: 'tool',
						type: 'tool_error',
						params: toolParams,
						result: message,
						name: toolName,
						content: message,
						id: toolId,
						rawParams: opts.unvalidatedToolParams,
						mcpServerName,
					});
					return {};
				}

				resolveInterruptor(() => { });

				toolResult = (await this._mcpService.callMCPTool({
					serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
					// toolName here is the model-facing `<server>_<tool>` prefixed name;
					// the MCP server expects its raw, unprefixed name. Prefer originalName,
					// fall back to the prefixed form for legacy tools without it.
					toolName: mcpTool.originalName ?? toolName,
					params: toolParams
				})).result;
			}

			if (interrupted) {
				this._agentActivityLog.logError(`${toolActivityLabel}: interrupted`);
				return { interrupted: true };
			} // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }); // resolve for the sake of it
			if (interrupted) {
				this._agentActivityLog.logError(`${toolActivityLabel}: interrupted`);
				return { interrupted: true };
			} // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error);
			this._agentActivityLog.logError(`${toolActivityLabel}: ${errorMessage}`);
			vibeLog.debug('toolExec', 'done', { tool: toolName, ms: Date.now() - _toolExecStartMs, ok: false }); this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
			return {};
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as never, toolResult as never);
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall);
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error);
			this._agentActivityLog.logError(`${toolActivityLabel}: stringify ${errorMessage}`);
			vibeLog.debug('toolExec', 'done', { tool: toolName, ms: Date.now() - _toolExecStartMs, ok: false }); this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
			return {};
		}

		// Anti-loop nudge (built-in tools only — MCP result signatures are opaque): if the model keeps
		// re-issuing this exact tool with identical args, the result isn't changing — append guidance so
		// it changes approach instead of spinning (e.g. glob **/* repeated until soft-checkpoint).
		if (isBuiltInTool) {
			toolResultStr = this._maybeAppendToolLoopNudge(threadId, toolName, toolParams, toolResultStr);
		}

		// 5. add to history and keep going
		// run_command / run_nl_command "time out" by KILLING the foreground terminal — output is partial and
		// the step did NOT finish, so the diagnostic trace must not report ok:true (roadmap rc). Persistent /
		// backgrounded commands resolve as 'done' (not 'timeout'), so this only catches the foreground-kill case.
		const _foregroundTerminalTimedOut = (toolName === 'run_command' || toolName === 'run_nl_command')
			&& typeof toolResult === 'object' && toolResult !== null && Object.hasOwn(toolResult, 'resolveReason')
			&& (toolResult as { resolveReason?: TerminalResolveReason }).resolveReason?.type === 'timeout';
		const _toolOk = !_foregroundTerminalTimedOut;
		vibeLog.debug('toolExec', 'done', { tool: toolName, ms: Date.now() - _toolExecStartMs, ok: _toolOk }); recordChatTrace('toolExec:done', { tool: toolName, ms: Date.now() - _toolExecStartMs, ok: _toolOk }); this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
		this._agentActivityLog.logFinished(toolActivityLabel);

		// Cache read_file results to prevent duplicate reads
		if (toolName === 'read_file' && isBuiltInTool) {
			const readFileParams = toolParams as BuiltinToolCallParams['read_file'];
			const readFileResult = toolResult as BuiltinToolResultType['read_file'];
			const cacheKey = `${readFileParams.uri.fsPath}|${readFileParams.startLine ?? 'null'}|${readFileParams.endLine ?? 'null'}|${readFileParams.pageNumber ?? 1}`;

			let threadCache = this._fileReadCache.get(threadId);
			if (!threadCache) {
				threadCache = new Map();
				this._fileReadCache.set(threadId, threadCache);
			}

			// Get or create LRU list for this thread
			let lruList = this._fileReadCacheLRU.get(threadId);
			if (!lruList) {
				lruList = [];
				this._fileReadCacheLRU.set(threadId, lruList);
			}

			// If key already exists, remove from LRU list (will be re-added at end)
			const existingIndex = lruList.indexOf(cacheKey);
			if (existingIndex >= 0) {
				lruList.splice(existingIndex, 1);
			}

			// Add to end of LRU list (most recently used)
			lruList.push(cacheKey);

			// Enforce cache size limit with LRU eviction
			if (lruList.length > ChatThreadService.MAX_FILE_READ_CACHE_ENTRIES_PER_THREAD) {
				// Remove oldest entry (first in list)
				const oldestKey = lruList.shift()!;
				threadCache.delete(oldestKey);
			}

			threadCache.set(cacheKey, readFileResult);
		}

		// Invalidate cache when files are modified or deleted
		if ((toolName === 'edit_file' || toolName === 'rewrite_file' || toolName === 'delete_file_or_folder') && isBuiltInTool) {
			const fileParams = toolParams as BuiltinToolCallParams['edit_file'] | BuiltinToolCallParams['rewrite_file'] | BuiltinToolCallParams['delete_file_or_folder'];
			const fileUri = fileParams.uri;
			const threadCache = this._fileReadCache.get(threadId);
			const lruList = this._fileReadCacheLRU.get(threadId);
			if (threadCache) {
				// Remove all cache entries for this file (any line range/page)
				const keysToDelete: string[] = [];
				for (const [cacheKey] of threadCache.entries()) {
					if (cacheKey.startsWith(fileUri.fsPath + '|')) {
						keysToDelete.push(cacheKey);
						threadCache.delete(cacheKey);
					}
				}
				// Also remove from LRU list
				if (lruList) {
					for (const key of keysToDelete) {
						const lruIndex = lruList.indexOf(key);
						if (lruIndex >= 0) {
							lruList.splice(lruIndex, 1);
						}
					}
				}
			}
		}

		return {};
	};




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
		earlyRequestId,
		isAutoMode,
		repoIndexerPromise,
	}: {
		threadId: string;
		modelSelection: ModelSelection | null;
		modelSelectionOptions: ModelSelectionOptions | undefined;
		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' };
		earlyRequestId?: string;
		isAutoMode?: boolean;
		repoIndexerPromise?: Promise<{ results: string[]; metrics: QueryMetrics } | null>;
	}) {

		// Concurrency guard: ONE agent loop per thread. Observed (2026-06-07): a hard-stall
		// cleared the stream state while the previous loop's HTTP was still in flight; rapid
		// «продолжи» presses then spawned parallel loops that interleaved writes into the
		// same thread (msgs count regressing 40 → 37 in the logs). A second loop never
		// helps — refuse it loudly instead. Only ACTIVE states block: 'idle' must pass
		// (plan pauses park the thread at 'idle' and resume re-enters here).
		// (typed as plain string so the guard's narrowing doesn't leak into the per-turn
		// `isRunning !== 'LLM'` check further down — tsgo propagates alias narrowing).
		const existingRun = this.streamState[threadId]?.isRunning as string | undefined;
		if (existingRun === 'LLM' || existingRun === 'tool') {
			vibeLog.warn('chatThread', `Refusing to start a second agent loop for threadId=${threadId} (existing run state: ${existingRun}).`);
			return;
		}

		// CRITICAL: Validate and resolve model selection BEFORE starting the loop
		// This prevents wasted API calls and ensures we have a valid model
		let resolvedModelSelection = modelSelection;
		let resolvedModelSelectionOptions = modelSelectionOptions;

		// Resolve "auto" model selection using shared utility
		const resolved = this._settingsService.resolveAutoModelSelection(resolvedModelSelection);
		if (!resolved) {
			// No models available
			this._notificationService.error('No models available. Please configure at least one model provider in settings.');
			this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
			return;
		}
		resolvedModelSelection = resolved;

		// Recompute modelSelectionOptions for the resolved model
		// Type assertion is safe because we've already resolved "auto" above
		const resolvedProviderName = resolvedModelSelection.providerName as Exclude<typeof resolvedModelSelection.providerName, 'auto'>;
		resolvedModelSelectionOptions = this._settingsService.state.optionsOfModelSelection['Chat']?.[resolvedProviderName]?.[resolvedModelSelection.modelName];

		// Per-file model routing (L928): if vibeide.model.routing rules are configured, override
		// the resolved model when the primary staged file matches a pattern (first match wins).
		{
			const routingRaw = this._configurationService.getValue<unknown>('vibeide.model.routing');
			const routingDecoded = decodeRoutingRules(routingRaw);
			if (routingDecoded.ok && routingDecoded.value.length > 0) {
				const thread = this.state.allThreads[threadId];
				const fileItem = (thread?.state?.stagingSelections ?? []).find((s): s is StagingSelectionItem & { type: 'File' } => s.type === 'File');
				if (fileItem) {
					const filePath = fileItem.uri.fsPath.replace(/\\/g, '/');
					const decision = resolveModelForPath(filePath, routingDecoded.value, resolvedModelSelection.modelName);
					if (decision.source === 'rule') {
						const routed = this._findModelSelectionForId(decision.resolvedModelId);
						if (routed) {
							resolvedModelSelection = routed;
							const rp = routed.providerName as Exclude<ProviderName, 'auto'>;
							resolvedModelSelectionOptions = this._settingsService.state.optionsOfModelSelection['Chat']?.[rp]?.[routed.modelName];
							vibeLog.info('chatThread', `model-routing: ${filePath} → pattern=${decision.matchedPattern} → ${decision.resolvedModelId}`);
						}
					}
				}
			}
		}

		// Cost forecast confirm — gate before first LLM request.
		{
			const thread = this.state.allThreads[threadId];
			const inputText = (thread?.messages ?? [])
				.map(m => {
					// `content` lives on user/tool messages, `displayContent` on user/assistant — pick
					// whichever is present to assemble the forecast input text. Narrow by role to stay typed.
					if (m.role === 'user' || m.role === 'tool') {
						return m.content;
					}
					if (m.role === 'assistant') {
						return m.displayContent ?? '';
					}
					return '';
				})
				.join(' ');
			const tokenForecast = this._costForecastService.forecast(inputText, resolvedModelSelection.modelName);
			const forecast: CostForecast = {
				estimatedUSD: tokenForecast.worstCaseUsd,
				estimatedTokens: tokenForecast.estimatedInputTokens + tokenForecast.estimatedOutputTokens,
				provider: resolvedProviderName,
				modelId: resolvedModelSelection.modelName,
			};
			const costConfig: CostForecastConfig = {
				confirmUSDThreshold: this._configurationService.getValue<number>('vibeide.cost.confirmThreshold') ?? COST_FORECAST_DEFAULTS.confirmUSDThreshold,
				confirmTokenThreshold: this._configurationService.getValue<number>('vibeide.cost.confirmTokenThreshold') ?? COST_FORECAST_DEFAULTS.confirmTokenThreshold,
				alwaysConfirm: this._configurationService.getValue<boolean>('vibeide.cost.alwaysConfirm') ?? false,
				sessionApprovals: this._costSessionApprovals,
			};
			const costDecision = decideCostConfirm(forecast, costConfig);
			if (costDecision.kind === 'require-confirm') {
				const body = describeCostDecision(forecast, costDecision);
				const result = await this._dialogService.confirm({
					message: localize('vibeide.cost.confirm.title', 'VibeIDE — подтверждение стоимости'),
					detail: body,
					primaryButton: localize('vibeide.cost.confirm.primary', 'Отправить запрос'),
				});
				if (!result.confirmed) {
					// User declined the cost confirmation: no run happened — don't play a run-end sound.
					this._suppressStopSound(threadId);
					this._setStreamState(threadId, { isRunning: undefined });
					return;
				}
				// Cache approval for this (provider, modelId) pair up to current estimate.
				this._costSessionApprovals = [
					...this._costSessionApprovals.filter(a => !(a.provider === forecast.provider && a.modelId === forecast.modelId)),
					{ provider: forecast.provider, modelId: forecast.modelId, approvedUpToUSD: forecast.estimatedUSD },
				];
			}
		}

		// CRITICAL: Create a flag to stop execution immediately when plan is generated
		// NOTE: This flag is reset when plan is approved/executing to allow execution to proceed
		let planWasGenerated = false;

		const checkPlanGenerated = () => {
			const refreshedPlan = this._getCurrentPlan(threadId, true);
			if (refreshedPlan?.plan.steps.some(s => !s.disabled && s.status === 'paused')) {
				return true;
			}

			// Fast path: if flag is already set, check if plan is still pending
			if (planWasGenerated) {
				// Force refresh to check if plan was approved since flag was set
				const plan = this._getCurrentPlan(threadId, true);
				if (plan && plan.plan.approvalState === 'pending') {
					return true; // Still pending
				}
				// Plan was approved - reset flag to allow execution
				planWasGenerated = false;
				return false;
			}

			// Use cached check first for performance - only force refresh if we suspect state changed
			const plan = this._getCurrentPlan(threadId, false); // Use cache for performance
			if (plan && plan.plan.approvalState === 'pending') {
				// Check if this plan was created during this execution session
				// We check the plan's message index - if it's near the end of messages, it's recent
				const thread = this.state.allThreads[threadId];
				if (thread) {
					const totalMessages = thread.messages.length;
					const planIdx = plan.planIdx;
					// If plan is in the last 10 messages, consider it recent (likely from this session)
					// This is safer than using timestamps which might not exist
					const isRecentPlan = (totalMessages - planIdx) <= 10;
					if (isRecentPlan) {
						planWasGenerated = true;
						return true;
					}
				}
			}
			return false;
		};

		let interruptedWhenIdle = false;
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true; });
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings; // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state;

		let nMessagesSent = 0;
		let shouldSendAnotherMessage = true;
		let isRunningWhenEnd: IsRunningType = undefined;

		// Anti-loop guard state (config-driven; default 3, 0 disables). Tracks signatures of
		// tool calls already executed in THIS request so an identical call repeated past the
		// threshold is short-circuited with a hint instead of re-run. Breaks the re-read loop
		// even when context truncation has erased the prior result from the model's view.
		const recentToolSignatures: string[] = [];
		let antiLoopBlocks = 0;
		// Same-signature streak for the tighter escalation (see ANTI_LOOP_MAX_CONSECUTIVE_SAME_BLOCKS).
		// Reset whenever a call PASSES the guard (any executed call = progress).
		let lastBlockedToolSig: string | undefined;
		let consecutiveSameSigBlocks = 0;
		const rawAntiLoop = this._configurationService.getValue<unknown>('vibeide.chat.antiLoopRepeatThreshold');
		const antiLoopThreshold = (typeof rawAntiLoop === 'number' && Number.isFinite(rawAntiLoop) && rawAntiLoop >= 0)
			? Math.min(20, Math.floor(rawAntiLoop))
			: 3;
		// Escalation caps (config-driven; constants are the registered-default mirrors).
		const rawMaxBlocks = this._configurationService.getValue<unknown>('vibeide.chat.antiLoopMaxBlocks');
		const antiLoopMaxBlocks = (typeof rawMaxBlocks === 'number' && Number.isFinite(rawMaxBlocks) && rawMaxBlocks >= 1)
			? Math.min(50, Math.floor(rawMaxBlocks))
			: ANTI_LOOP_MAX_BLOCKS;
		const rawSameBlocks = this._configurationService.getValue<unknown>('vibeide.chat.antiLoopMaxConsecutiveSameBlocks');
		const antiLoopMaxConsecutiveSameBlocks = (typeof rawSameBlocks === 'number' && Number.isFinite(rawSameBlocks) && rawSameBlocks >= 1)
			? Math.min(20, Math.floor(rawSameBlocks))
			: ANTI_LOOP_MAX_CONSECUTIVE_SAME_BLOCKS;

		// PERFORMANCE: Check for plan ONCE at start, not on every tool call
		// Only do plan tracking if an active plan exists
		let activePlanTracking: { planInfo: { plan: PlanMessage; planIdx: number }; currentStep: { plan: PlanMessage; planIdx: number; step: PlanStep; stepIdx: number } | undefined } | undefined;

		// In Plan Mode, ALWAYS generate a plan regardless of task complexity heuristic.
		// In other modes, use the heuristic to decide.
		const isPlanMode = chatMode === 'plan';

		// Check if we should generate a plan for complex tasks
		const existingPlanInfo = this._getCurrentPlan(threadId, false); // Use cache

		// In plan mode: if the last plan was aborted/rejected, treat it as if there is no plan
		// so a new plan is generated for the new user message.
		const hasActivePlan = existingPlanInfo && existingPlanInfo.plan.approvalState !== 'aborted';

		if (!hasActivePlan) {
			// No active plan - check if we should generate one
			const shouldGeneratePlan = isPlanMode || this._shouldGeneratePlan(threadId);
			if (shouldGeneratePlan) {
				await this._generatePlanFromUserRequest(threadId, modelSelection, modelSelectionOptions);
				// CRITICAL: Force cache refresh ONLY here after plan generation
				this._planCache.delete(threadId);
				const planAfterGen = this._getCurrentPlan(threadId, true); // Force refresh
				if (planAfterGen && planAfterGen.plan.approvalState === 'pending') {
					planWasGenerated = true;
					// Plan generated, wait for user approval - don't execute yet
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
					return;
				}
			}
		} else {
			// Existing active plan found - check if it's pending
			if (existingPlanInfo.plan.approvalState === 'pending') {
				planWasGenerated = true;
				// A pre-existing pending plan blocks this NEW user message. Surface the gate
				// (inline error + "Сбросить план и продолжить" button + toast) immediately, so the
				// user recovers WITHOUT a window reload or waiting out the 120s submit-watchdog.
				// Previously this returned `isRunning: 'idle'` silently → message added, nothing
				// happened, no recovery affordance ("text sent, process didn't go" symptom).
				this._surfacePendingPlanGate(threadId);
				return;
			}
		}

		// CRITICAL: Force refresh after approval to get latest plan state (cache was invalidated)
		let planInfo = this._getCurrentPlan(threadId, true);
		if (planInfo && (planInfo.plan.approvalState === 'approved' || planInfo.plan.approvalState === 'executing')) {
			// Only initialize tracking if plan is approved/executing
			if (planInfo.plan.approvalState === 'approved') {
				// Mark plan as executing
				const updatedPlan: PlanMessage = {
					...planInfo.plan,
					approvalState: 'executing',
					executionStartTime: Date.now()
				};
				this._editMessageInThread(threadId, planInfo.planIdx, updatedPlan);
				// PERFORMANCE: Update cache in place instead of invalidating
				const cached = this._planCache.get(threadId);
				if (cached && cached.planIdx === planInfo.planIdx) {
					cached.plan = updatedPlan;
					cached.lastChecked = Date.now();
					planInfo = { plan: updatedPlan, planIdx: planInfo.planIdx };
				} else {
					// Cache miss - refresh
					const refreshed = this._getCurrentPlan(threadId, true);
					if (refreshed) {
						planInfo = refreshed;
					}
				}
			}

			const wfExec = this._primaryWorkspaceFolderUri();
			const execPlan = planInfo.plan;
			if (wfExec && execPlan.persistedPlanId && execPlan.approvalState === 'executing') {
				if (!this._taskDecompositionService.hasPersistedPlanMirror(threadId)) {
					this._taskDecompositionService.startPersistedPlanTask(threadId, execPlan.summary || 'Agent plan', execPlan.steps);
				}
				const { conflict, otherThreadIds } = this._planBindingRegistry.register(wfExec, execPlan.persistedPlanId, threadId);
				if (conflict) {
					this._notificationService.notify({
						severity: Severity.Warning,
						message: localize(
							'vibeide.planSecondExecutorWarning',
							'Plan {0} is already bound to another chat session ({1}). Running both may desynchronize execution; pause one executor first.',
							execPlan.persistedPlanId,
							otherThreadIds.join(', '),
						),
					});
				}
			}

			// PERFORMANCE: Get current step once, reuse result
			const currentStep = this._getCurrentStep(threadId, false); // Try cache first
			if (currentStep && currentStep.step.status === 'queued') {
				// Start next step - returns full step info to avoid re-lookup
				const startedStep = await this._startNextStep(threadId);
				if (startedStep) {
					// Use returned step info directly - no need to re-lookup
					activePlanTracking = {
						planInfo: { plan: startedStep.plan, planIdx: startedStep.planIdx },
						currentStep: {
							plan: startedStep.plan,
							planIdx: startedStep.planIdx,
							step: startedStep.step,
							stepIdx: startedStep.stepIdx
						}
					};
				} else if (planInfo) {
					// Fallback if start failed
					activePlanTracking = {
						planInfo,
						currentStep: this._getCurrentStep(threadId, false)
					};
				}
			} else {
				// planInfo is guaranteed to be defined here due to the outer if check
				activePlanTracking = {
					planInfo,
					currentStep: currentStep || this._getCurrentStep(threadId, false)
				};
			}
		}

		// Helper to update current step after operations
		const refreshPlanStep = () => {
			if (activePlanTracking) {
				activePlanTracking.currentStep = this._getCurrentStep(threadId, true);
			}
		};

		// CRITICAL: Check for pending plan before executing any tools
		// Use fast check (relies on flag and cached plan check)
		if (checkPlanGenerated()) {
			// Plan is pending approval — surface a recoverable error so the user can
			// dismiss-and-continue with one click (toast button + inline chat button).
			this._surfacePendingPlanGate(threadId);
			return;
		}

		// before enter loop, call tool
		if (callThisToolFirst) {
			// Double-check plan status before executing (fast check)
			if (checkPlanGenerated()) {
				this._surfacePendingPlanGate(threadId);
				return;
			}

			if (activePlanTracking?.currentStep && !this._toolMatchesPersistedPlanHints(callThisToolFirst.name, activePlanTracking.currentStep.step)) {
				if (this._pauseRunningPlanStepForToolDrift(threadId, callThisToolFirst.name)) {
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
					return;
				}
			}

			const mcpSrvFirst = this._resolveMcpServerForPlanTool(callThisToolFirst.name, callThisToolFirst.mcpServerName);
			if (activePlanTracking?.currentStep && !this._mcpCallMatchesPlanAllowlist(activePlanTracking.currentStep.step, callThisToolFirst.name, mcpSrvFirst)) {
				if (this._pauseRunningPlanStepForMcpAllowlist(threadId, callThisToolFirst.name, mcpSrvFirst)) {
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
					return;
				}
			}

			if (activePlanTracking?.currentStep) {
				this._linkToolCallToStepInternal(threadId, callThisToolFirst.id, activePlanTracking.currentStep);
			}

			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params });
			if (interrupted) {
				this._setStreamState(threadId, undefined);
				await this._addUserCheckpoint({ threadId });
				if (activePlanTracking?.currentStep) {
					// PERFORMANCE: Use returned step info instead of re-looking up
					const updatedStep = this._markStepCompletedInternal(threadId, activePlanTracking.currentStep, false, 'Interrupted by user');
					if (updatedStep) {
						activePlanTracking.currentStep = updatedStep;
						activePlanTracking.planInfo = { plan: updatedStep.plan, planIdx: updatedStep.planIdx };
					} else {
						refreshPlanStep();
					}
				}
			} else {
				// Mark step as completed on success
				if (activePlanTracking?.currentStep) {
					// PERFORMANCE: Use returned step info instead of re-looking up
					const updatedStep = this._markStepCompletedInternal(threadId, activePlanTracking.currentStep, true);
					if (updatedStep) {
						activePlanTracking.currentStep = updatedStep;
						activePlanTracking.planInfo = { plan: updatedStep.plan, planIdx: updatedStep.planIdx };

						// Start next step - use returned value
						const startedStep = await this._startNextStep(threadId);
						if (startedStep) {
							activePlanTracking.planInfo = { plan: startedStep.plan, planIdx: startedStep.planIdx };
							activePlanTracking.currentStep = {
								plan: startedStep.plan,
								planIdx: startedStep.planIdx,
								step: startedStep.step,
								stepIdx: startedStep.stepIdx
							};
						} else {
							// No more steps - refresh to get final state
							refreshPlanStep();
						}
					} else {
						// Fallback if update failed
						const startedStep = await this._startNextStep(threadId);
						if (startedStep) {
							activePlanTracking.planInfo = { plan: startedStep.plan, planIdx: startedStep.planIdx };
							activePlanTracking.currentStep = {
								plan: startedStep.plan,
								planIdx: startedStep.planIdx,
								step: startedStep.step,
								stepIdx: startedStep.stepIdx
							};
						} else {
							refreshPlanStep();
						}
					}
				}
			}
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });  // just decorative, for clarity


		// Track if we've synthesized tools for this request (prevents infinite loops)
		// This is more reliable than checking message patterns
		let hasSynthesizedToolsInThisRequest = false;
		// #6 — broken-XML tool-call repair fires at most once per request (anti-loop).
		let hasRepairedXmlThisRequest = false;
		// Premature-stop nudge: consecutive agent-mode turns that returned text with NO tool call.
		// Reset to 0 on any executed tool call (progress). Bounds the Autopilot auto-continue.
		let autoContinueOnTextCount = 0;
		// Per-turn force flag: set when the Autopilot premature-stop handler injects a corrective
		// nudge, consumed (and reset) by the very next sendLLMMessage so it requests tool_choice=required.
		let forceToolUseNextTurn = false;
		// Question-ending turns get their own ALWAYS-nudge lane under Autopilot (a closing «…?»
		// is a permission-seeking stall nobody answers in unattended mode). Bounded by the
		// `autoContinueOnQuestion` setting (0 = unlimited); reset on any executed tool call, same as above.
		let questionNudgeCount = 0;

		// Track tools executed in this request to detect incomplete workflows
		const toolsExecutedInRequest: string[] = [];
		// Per-(provider×model) consecutive tool failure counter (tool_error / invalid_params).
		// Reset on `success` per key. Triggers two thresholds:
		//   - AUTO_DOWNGRADE_THRESHOLD (6) → write `specialToolFormat: undefined` override
		//     for that model and continue loop with XML-fallback path. Only fires once per
		//     model per session (downgradedModelsThisSession) AND only for the
		//     `numeric-tool-name` quirk. See roadmap O.1/O.2.
		//   - MAX_CONSECUTIVE_TOOL_ERRORS (15) → abort agent loop with hard message. Last
		//     resort safety net even after downgrade. See roadmap O.3 (circuit-breaker).
		const consecutiveToolErrorsByModel = new Map<string, number>();
		const downgradedModelsThisSession = new Set<string>();
		// O.9 — Periodic re-probe: for models in downgrade mode, count successful tool
		// calls. After RE_PROBE_AFTER_SUCCESSES successes, mark the model for a probe
		// on the next LLM iteration (force native FC for that single call by stripping
		// the auto-detected override from effectiveOverrides passed to sendLLMMessage).
		// If the probe call's first tool returns `success` → clear the persistent
		// override entirely (model has recovered). If it returns `tool_error` →
		// keep override, reset counter, try again later in the session.
		// Config-driven (default 5). See `vibeide.agent.reprobeAfterSuccesses`.
		const rawReprobe = this._configurationService.getValue<unknown>('vibeide.agent.reprobeAfterSuccesses');
		const RE_PROBE_AFTER_SUCCESSES = (typeof rawReprobe === 'number' && Number.isFinite(rawReprobe) && rawReprobe >= 1)
			? Math.min(100, Math.floor(rawReprobe))
			: 5;
		const successCountForDowngradedModel = new Map<string, number>();
		const probeRequestedForModel = new Set<string>();
		// O.11 — Cross-session recovery. A persisted `_autoDetected` override written in a
		// PRIOR session would otherwise keep the model in XML-fallback until the 7-day TTL,
		// because the success-based re-probe above is session-scoped (downgradedModelsThisSession
		// is empty after a window restart) — and a model that can't reliably emit tool calls in
		// XML never accumulates the successes needed to trigger it. So instead of a success-gated
		// probe, the loop CLEARS such a stale auto-override once per session (giving native FC a
		// clean slate; reason-specific auto-downgrade re-applies it if the quirk is real). This set
		// tracks which models already had that one-shot cross-session clear attempted this session.
		const persistentOverrideProbedThisSession = new Set<string>();

		// Resolve max iterations once per run. Reading on every iteration would let a mid-run
		// settings tweak chop off an in-flight loop unexpectedly.
		const rawMaxIter = this._configurationService.getValue<unknown>('vibeide.agent.maxLoopIterations');
		const maxLoopIterations = (typeof rawMaxIter === 'number' && Number.isFinite(rawMaxIter) && rawMaxIter >= 0)
			? Math.min(MAX_AGENT_LOOP_ITERATIONS_UPPER_BOUND, Math.floor(rawMaxIter))
			: DEFAULT_MAX_AGENT_LOOP_ITERATIONS;
		// 0 = no cap (user opted out)

		// Auto-downgrade-to-XML threshold (config-driven; default AUTO_DOWNGRADE_THRESHOLD).
		// `0` disables auto-downgrade entirely → model stays on native FC no matter what, like
		// opencode CLI (which has no breaker). See `vibeide.agent.autoDowngradeThreshold`.
		const rawAutoDowngrade = this._configurationService.getValue<unknown>('vibeide.agent.autoDowngradeThreshold');
		const autoDowngradeThreshold = (typeof rawAutoDowngrade === 'number' && Number.isFinite(rawAutoDowngrade) && rawAutoDowngrade >= 0)
			? Math.min(50, Math.floor(rawAutoDowngrade))
			: AUTO_DOWNGRADE_THRESHOLD;

		// Circuit-breaker threshold resolved ONCE per run (mirrors maxLoopIterations rationale:
		// a mid-run settings tweak shouldn't abort an in-flight loop). Default MAX_CONSECUTIVE_TOOL_ERRORS.
		const maxConsecutiveToolErrors = Math.max(1, Math.min(100, this._configurationService.getValue<number>('vibeide.chat.maxConsecutiveToolErrors') ?? MAX_CONSECUTIVE_TOOL_ERRORS));

		// tool use loop
		// Soft checkpoint (B): pause-and-ask after N iterations or M tokens in a single run, so a
		// non-converging autopilot run can't silently grind dozens of steps / millions of tokens.
		// Independent of the hard maxLoopIterations cap (which the user may have disabled with 0).
		const rawSoftIter = this._configurationService.getValue<unknown>('vibeide.agent.softCheckpointIterations');
		// Fallback mirrors the registered config default (0 = no pauses, full-autonomy default).
		const softCheckpointIterations = (typeof rawSoftIter === 'number' && Number.isFinite(rawSoftIter) && rawSoftIter >= 0) ? Math.floor(rawSoftIter) : 0;
		const rawSoftTok = this._configurationService.getValue<unknown>('vibeide.agent.softCheckpointTokens');
		const softCheckpointTokens = (typeof rawSoftTok === 'number' && Number.isFinite(rawSoftTok) && rawSoftTok >= 0) ? Math.floor(rawSoftTok) : 1_000_000;
		let nextSoftIterCheckpoint = softCheckpointIterations > 0 ? softCheckpointIterations : Number.POSITIVE_INFINITY;
		// D.30: the toolbar exposes a SINGLE iterations counter; `0` means "full autonomy / no pauses".
		// The token checkpoint is config-only (invisible in the toolbar), so it must follow the same
		// switch — otherwise full autonomy still pauses at softCheckpointTokens, which surprised the
		// user (toast at ~1M tokens despite the counter showing 0/∞). Arm tokens only when iterations
		// are also armed.
		let nextSoftTokenCheckpoint = (softCheckpointTokens > 0 && softCheckpointIterations > 0) ? softCheckpointTokens : Number.POSITIVE_INFINITY;
		let tokensAtRunStart = 0;
		try { tokensAtRunStart = this._tokenBudgetService.getStatus().sessionTokensUsed; } catch { /* best-effort baseline */ }

		while (shouldSendAnotherMessage) {
			// CRITICAL: Check for maximum iterations to prevent infinite loops (skipped when user disabled the cap with 0)
			if (maxLoopIterations > 0 && nMessagesSent >= maxLoopIterations) {
				this._notificationService.warn(`Agent loop reached maximum iterations (${maxLoopIterations}). Stopping to prevent infinite loop.`);
				this._setStreamState(threadId, { isRunning: undefined });
				return;
			}

			// CRITICAL: Check stream state first - if execution was interrupted/aborted, stop immediately
			const currentStreamState = this.streamState[threadId];
			if (!currentStreamState || currentStreamState.isRunning === undefined) {
				// Execution was aborted/interrupted - stop immediately
				return;
			}

			// CRITICAL: Check for pending plan before each iteration - don't execute tools if plan is pending approval
			// Use fast check (flag + cached check) - only force refresh every few iterations to save performance
			if (checkPlanGenerated()) {
				// Plan is pending approval - stop execution and wait
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
				return;
			}

			// Soft checkpoint (B): once this run crosses the iteration or token threshold, pause and
			// ask before doing more work. The token side is only probed when that checkpoint is armed.
			// D.2b: autopilot may auto-reset the session token counter mid-run (it drops below our
			// baseline). Re-baseline so the token checkpoint keeps firing instead of silently going
			// dead (spent would otherwise clamp to 0 forever after a reset).
			if (nextSoftTokenCheckpoint !== Number.POSITIVE_INFINITY) {
				let nowTok = tokensAtRunStart;
				try { nowTok = this._tokenBudgetService.getStatus().sessionTokensUsed; } catch { /* keep prev baseline */ }
				if (nowTok < tokensAtRunStart) {
					tokensAtRunStart = nowTok;
					nextSoftTokenCheckpoint = softCheckpointTokens;
				}
			}

			if (nMessagesSent >= nextSoftIterCheckpoint ||
				(nextSoftTokenCheckpoint !== Number.POSITIVE_INFINITY && this._tokensSpentThisRun(tokensAtRunStart) >= nextSoftTokenCheckpoint)) {
				const spent = this._tokensSpentThisRun(tokensAtRunStart);
				const keepGoing = await this._promptAgentSoftCheckpoint(threadId, nMessagesSent, spent);
				// The user may have interrupted while the prompt was open — re-check before continuing.
				const ss = this.streamState[threadId];
				if (!keepGoing || !ss || ss.isRunning === undefined) {
					this._setStreamState(threadId, { isRunning: undefined });
					return;
				}
				if (nMessagesSent >= nextSoftIterCheckpoint) { nextSoftIterCheckpoint = nMessagesSent + softCheckpointIterations; }
				if (spent >= nextSoftTokenCheckpoint) { nextSoftTokenCheckpoint = spent + softCheckpointTokens; }
			}

			void this._touchPersistedExecutionLease(threadId);

			// false by default each iteration
			shouldSendAnotherMessage = false;
			isRunningWhenEnd = undefined;
			nMessagesSent += 1;

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor });

			// Drain any context the user queued mid-run (without aborting) — becomes a real user
			// message this hop. See docs/knowledge/chat-ux/chat-interrupt-and-inject.md.
			this._drainPendingInjections(threadId);

			const chatMessages = this.state.allThreads[threadId]?.messages ?? [];

			// Check if we've already synthesized a tool for this original request (prevent infinite loops)
			const allUserMessages = chatMessages.filter(m => m.role === 'user');
			const originalUserMessage = allUserMessages.find(m =>
				!m.displayContent?.includes('⚠️ CRITICAL') &&
				!m.displayContent?.includes('You did not use tools')
			);
			const originalRequestId = originalUserMessage ? `${originalUserMessage.displayContent}` : null;

			// Also check message history as a fallback (more reliable than pattern matching)
			const hasSynthesizedForRequest = hasSynthesizedToolsInThisRequest || (originalRequestId && chatMessages.some((msg, idx) => {
				if (msg.role === 'assistant' && msg.displayContent?.includes('Let me start by')) {
					// Check if there's a tool message right after this assistant message
					const nextMsg = chatMessages[idx + 1];
					return nextMsg?.role === 'tool';
				}
				return false;
			}));

			// Preprocess images through QA pipeline if present
			let preprocessedMessages = chatMessages;
			if (originalUserMessage && originalUserMessage.images && originalUserMessage.images.length > 0) {
				try {
					const settings = this._settingsService.state.globalSettings;
					const preprocessed = await preprocessImagesForQA(
						originalUserMessage.images,
						originalUserMessage.displayContent || '',
						resolvedModelSelection,
						settings.imageQADevMode,
						{
							pipelineEnabled: settings.imageQAPipelineEnabled,
							allowRemoteModels: settings.imageQAAllowRemoteModels,
							enableHybridMode: settings.imageQAEnableHybridMode,
							settingsOfProvider: this._settingsService.state.settingsOfProvider,
							overridesOfModel: this._settingsService.state.overridesOfModel,
						}
					);

					if (preprocessed.shouldUsePipeline) {
						// Log QA response in dev mode for debugging
						if (settings.imageQADevMode && preprocessed.qaResponse) {
							vibeLog.info('chatThread', '[ImageQA] Pipeline response:', {
								confidence: preprocessed.qaResponse.confidence,
								needsLLM: !!preprocessed.qaResponse._needsLLM,
								needsVLM: !!preprocessed.qaResponse._needsVLM,
								answer: preprocessed.qaResponse.answer?.substring(0, 100),
							});
						}

						// Update the user message content with processed text if available
						// Use images from preprocessing (will be undefined if not needed)
						if (preprocessed.processedText !== undefined) {
							preprocessedMessages = chatMessages.map(msg => {
								if (msg === originalUserMessage) {
									return {
										...msg,
										content: preprocessed.processedText!,
										images: preprocessed.images, // Preprocessing decides if images are needed
										displayContent: originalUserMessage.displayContent || '',
									};
								}
								return msg;
							});
						}
					}
				} catch (error) {
					vibeLog.error('chatThread', '[ImageQA] Error preprocessing images:', error);
					// Continue with original messages on error
				}
			}

			// CRITICAL: Check for pending plan BEFORE preparing LLM messages (saves API calls)
			// checkPlanGenerated() already checks planWasGenerated internally, no need to check twice
			if (checkPlanGenerated()) {
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
				return;
			}

			// Use resolved model selection (already validated before loop)
			// Use let so we can update it in retry logic
			let modelSelection = resolvedModelSelection;
			const modelSelectionOptions = resolvedModelSelectionOptions;

			// Start latency audit tracking (reuse earlyRequestId if provided for router tracking, otherwise generate new)
			const finalRequestId = earlyRequestId || generateUuid();
			const providerName = modelSelection.providerName;
			const modelName = modelSelection.modelName;
			// Only start new request if we didn't already start it for router tracking
			if (!earlyRequestId) {
				chatLatencyAudit.startRequest(finalRequestId, providerName, modelName);
				// For manual selection, router time is 0 (instant)
				chatLatencyAudit.markRouterStart(finalRequestId);
				chatLatencyAudit.markRouterEnd(finalRequestId);
			} else {
				// Update provider/model info if we started request early for router tracking
				const context = chatLatencyAudit.getContext(finalRequestId);
				if (context) {
					context.providerName = providerName;
					context.modelName = modelName;
				}
			}
			chatLatencyAudit.markPromptAssemblyStart(finalRequestId);

			// PERFORMANCE: Check cache for prepared messages before expensive preparation
			// Get repoIndexer results if promise is available (for cache key)
			let repoIndexerResults: { results: string[]; metrics: QueryMetrics } | null | undefined = undefined;
			if (repoIndexerPromise) {
				try {
					repoIndexerResults = await repoIndexerPromise;
				} catch {
					// Ignore errors - will prepare without cache
				}
			}

			const cacheKey = this._getMessagePrepCacheKey(preprocessedMessages, modelSelection, chatMode, repoIndexerResults);
			const cached = this._messagePrepCache.get(cacheKey);
			const now = Date.now();

			let messages: LLMChatMessage[];
			let separateSystemMessage: string | undefined;
			let promptTokens: number;
			let contextSize: number;

			// Use cached result if available and not expired
			if (cached && (now - cached.timestamp) < ChatThreadService.MESSAGE_PREP_CACHE_TTL) {
				messages = cached.messages;
				separateSystemMessage = cached.separateSystemMessage;
				promptTokens = cached.tokenCount;
				contextSize = cached.contextSize;
			} else {
				// Prepare messages (expensive operation)
				const prepResult = await this._convertToLLMMessagesService.prepareLLMChatMessages({
					chatMessages: preprocessedMessages,
					modelSelection,
					chatMode,
					repoIndexerPromise: repoIndexerResults ? Promise.resolve(repoIndexerResults) : repoIndexerPromise
				});
				messages = prepResult.messages;
				separateSystemMessage = prepResult.separateSystemMessage;

				// Compute token count and context size
				const tokenResult = this._computeTokenCount(messages);
				promptTokens = tokenResult.tokenCount;
				contextSize = tokenResult.contextSize;

				// Cache result (with LRU eviction)
				if (this._messagePrepCache.size >= ChatThreadService.MESSAGE_PREP_CACHE_MAX_SIZE) {
					// Remove oldest entry (simple FIFO eviction)
					const firstKey = this._messagePrepCache.keys().next().value;
					if (firstKey !== undefined) {
						this._messagePrepCache.delete(firstKey);
					}
				}
				this._messagePrepCache.set(cacheKey, {
					messages,
					separateSystemMessage,
					tokenCount: promptTokens,
					contextSize,
					timestamp: now
				});
			}

			// L881 — AI Debugging Context inject with token-budget gate. Skip injection when
			// the prompt is already near context capacity (≥70%); the debug snapshot is the
			// least-load-bearing piece of context and should yield first. Budget headroom is
			// computed from the model's reported context size when available.
			try {
				const used = promptTokens ?? 0;
				const capacity = contextSize && contextSize > 0 ? contextSize : 0;
				const usageRatio = capacity > 0 ? used / capacity : 0;
				const TOKEN_BUDGET_GATE = 0.70;
				if (capacity > 0 && usageRatio >= TOKEN_BUDGET_GATE) {
					vibeLog.info('chatThread', `debug-context skipped (token-budget gate: ${used}/${capacity} = ${(usageRatio * 100).toFixed(1)}%)`);
				} else {
					const dbgMarkdown = this._aiDebuggingService.getContextMarkdown();
					if (dbgMarkdown && dbgMarkdown.length > 0) {
						// Shrink budget further when usage is between 50% and 70% — use 4KB instead of 8KB.
						const HARD_MAX = 8 * 1024;
						const SOFT_MAX = 4 * 1024;
						const cap = usageRatio >= 0.5 ? SOFT_MAX : HARD_MAX;
						const body = dbgMarkdown.length > cap ? dbgMarkdown.slice(0, cap) + '\n…[truncated]' : dbgMarkdown;
						const section = `\n\n<!-- vibeide:debug-context -->\n${body}\n<!-- /vibeide:debug-context -->`;
						separateSystemMessage = (separateSystemMessage ?? '') + section;
					}
				}
			} catch (e) {
				vibeLog.warn('chatThread', 'AI debug context inject failed:', e);
			}

			// CRITICAL: Validate that messages are not empty before sending to API
			// Empty messages cause "invalid message format" errors
			if (!messages || messages.length === 0) {
				this._notificationService.error('Failed to prepare messages. Please check your message content.');
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
				return;
			}

			// CRITICAL: Check again after async operation (plan might have been added during prep)
			// Invalidate cache in case plan was added during message prep, then use fast check
			this._planCache.delete(threadId);
			if (checkPlanGenerated()) {
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
				return;
			}

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined);
				return;
			}

			// PERFORMANCE: Token count and context size already computed (from cache or preparation)
			// No need to recompute - use cached values
			chatLatencyAudit.markPromptAssemblyEnd(finalRequestId, promptTokens, 0, contextSize, false);

			// Audit log: record prompt
			// PERFORMANCE: Cache isEnabled() check to avoid repeated calls
			const auditEnabled = this._auditLogService.isEnabled();
			if (auditEnabled && modelSelection) {
				await this._auditLogService.append({
					ts: Date.now(),
					action: 'prompt',
					model: `${modelSelection.providerName}/${modelSelection.modelName}`,
					ok: true,
					meta: {
						threadId,
						requestId: finalRequestId,
						promptTokens,
						contextSize,
					},
				});
			}

			let shouldRetryLLM = true;
			let nAttempts = 0;
			let firstTokenReceived = false;
			// Track models we've tried (for auto mode fallback)
			const triedModels: Set<string> = new Set();
			// Retry cache: accumulates streamed text so a retry can resume rather than restart.
			let _retryPartial: PartialResponse | undefined = undefined;
			let _retryLastTextLen = 0;
			// Store original routing decision for fallback chain (only in auto mode)
			let originalRoutingDecision: RoutingDecision | null = null;
			// Track if we're in auto mode (user selected "auto")
			const isAutoMode = !modelSelection || (modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto') ||
				(this._settingsService.state.modelSelectionOfFeature['Chat']?.providerName === 'auto' &&
					this._settingsService.state.modelSelectionOfFeature['Chat']?.modelName === 'auto');

			// If in auto mode and we have a model selection, try to get the routing decision for fallback chain
			if (isAutoMode && modelSelection && modelSelection.providerName !== 'auto') {
				// We'll get the routing decision when we need it (on first error)
			}

			// Track previous model to detect switches
			let previousModelKey: string | null = null;

			// Streaming gap watchdog: flag is set when the watchdog triggers an auto-retry so
			// the llmAborted early-return is skipped and the while-loop can iterate again.
			let watchdogRetry = false;

			// O.9 — per-call probe state. Set when the LLM call for this iteration
			// strips the auto-detected override (one-shot native-FC retry); cleared
			// after the outcome is processed in the post-tool-call block.
			let probeActiveThisCall: string | undefined = undefined;
			while (shouldRetryLLM) {
				shouldRetryLLM = false;
				nAttempts += 1;

				// Track this model attempt
				if (modelSelection && modelSelection.providerName !== 'auto') {
					const modelKey = `${modelSelection.providerName}/${modelSelection.modelName}`;
					triedModels.add(modelKey);

					// Re-prepare messages if we switched models (for auto mode fallback)
					// This ensures messages are formatted correctly for the new model
					if (previousModelKey !== null && previousModelKey !== modelKey) {
						try {
							vibeLog.info('chatThread', `[ChatThreadService] Re-preparing messages for new model: ${modelKey}`);
							// PERFORMANCE: Use cache for model switch too
							const switchCacheKey = this._getMessagePrepCacheKey(preprocessedMessages, modelSelection, chatMode, repoIndexerResults);
							const switchCached = this._messagePrepCache.get(switchCacheKey);
							const switchNow = Date.now();

							if (switchCached && (switchNow - switchCached.timestamp) < ChatThreadService.MESSAGE_PREP_CACHE_TTL) {
								// Use cached result
								messages = switchCached.messages;
								separateSystemMessage = switchCached.separateSystemMessage;
								promptTokens = switchCached.tokenCount;
								contextSize = switchCached.contextSize;
							} else {
								// Prepare messages (cache miss)
								const prepResult = await this._convertToLLMMessagesService.prepareLLMChatMessages({
									chatMessages: preprocessedMessages,
									modelSelection,
									chatMode,
									repoIndexerPromise: repoIndexerResults ? Promise.resolve(repoIndexerResults) : repoIndexerPromise
								});
								messages = prepResult.messages;
								separateSystemMessage = prepResult.separateSystemMessage;

								// Compute token count
								const tokenResult = this._computeTokenCount(messages);
								promptTokens = tokenResult.tokenCount;
								contextSize = tokenResult.contextSize;

								// Cache result
								if (this._messagePrepCache.size >= ChatThreadService.MESSAGE_PREP_CACHE_MAX_SIZE) {
									const firstKey = this._messagePrepCache.keys().next().value;
									if (firstKey !== undefined) {
										this._messagePrepCache.delete(firstKey);
									}
								}
								this._messagePrepCache.set(switchCacheKey, {
									messages,
									separateSystemMessage,
									tokenCount: promptTokens,
									contextSize,
									timestamp: switchNow
								});
							}

							// Only update if we got valid messages
							if (messages && messages.length > 0) {
								// Update finalRequestId context with new prompt tokens
								const promptTokens = messages.reduce((acc, m) => {
									// Handle Gemini messages (use 'parts' instead of 'content')
									if (isGeminiLLMChatMessage(m)) {
										return acc + m.parts.reduce((sum, part) => {
											if (isGeminiTextPart(part)) {
												return sum + Math.ceil(part.text.length / 4);
											} else if (isGeminiInlineDataPart(part)) {
												return sum + 100;
											}
											return sum;
										}, 0);
									}
									// Handle Anthropic/OpenAI messages (use 'content')
									if (typeof m.content === 'string') {
										return acc + Math.ceil(m.content.length / 4);
									} else if (Array.isArray(m.content)) {
										return acc + m.content.reduce((sum, part) => {
											if (part.type === 'text') {
												return sum + Math.ceil(part.text.length / 4);
											} else if (part.type === 'image_url') {
												return sum + 100;
											}
											return sum;
										}, 0);
									}
									return acc + Math.ceil(JSON.stringify(m.content).length / 4);
								}, 0);
								chatLatencyAudit.markPromptAssemblyEnd(finalRequestId, promptTokens, 0, 0, false);
							}
						} catch (prepError) {
							vibeLog.error('chatThread', '[ChatThreadService] Error re-preparing messages for new model:', prepError);
							// Continue with existing messages if re-prep fails
						}
					}
					previousModelKey = modelKey;
				}

				type ResTypes =
					| { type: 'llmDone'; toolCall?: RawToolCallObj; info: { fullText: string; fullReasoning: string; anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError'; error?: { message: string; fullError: Error | null } }
					| { type: 'llmAborted' };

				let resMessageIsDonePromise: (res: ResTypes) => void; // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res; });

				// Track if message is done to prevent late onText updates
				let messageIsDone = false;

				// Track network request start (when we actually send to the LLM)
				chatLatencyAudit.markNetworkStart(finalRequestId);
				// Track network start time for timeout fallback (if no tokens arrive)
				const networkTimeout = setTimeout(() => {
					// Fallback: if no tokens arrive within 30s, mark network end anyway
					const context = chatLatencyAudit.getContext(finalRequestId);
					if (context && !context.networkEndTime) {
						chatLatencyAudit.markNetworkEnd(finalRequestId);
					}
				}, 30000);

				// Stall watchdog: notify user if the LLM stops producing tokens unexpectedly.
				// earlyStallTimer fires after `earlyStallMs` — sets inline banner only (no toast).
				// firstTokenStallTimer fires once if no first token arrives within `firstTokenStallMs`.
				// midStreamStallTimer is reset on every onText call; fires if streaming freezes mid-way.
				// All thresholds read fresh from settings per agent run (S.2 — closed in this session).
				const earlyStallSeconds = readClampedNumberSetting(this._configurationService, 'vibeide.chat.streamEarlyStallSeconds', DEFAULT_EARLY_STALL_SECONDS, 5, 120);
				const firstTokenStallSeconds = readClampedNumberSetting(this._configurationService, 'vibeide.chat.streamFirstTokenStallSeconds', DEFAULT_FIRST_TOKEN_STALL_SECONDS, 10, 300);
				const midStreamStallSeconds = readClampedNumberSetting(this._configurationService, 'vibeide.chat.streamMidStreamStallSeconds', DEFAULT_MID_STREAM_STALL_SECONDS, 15, 600);
				const earlyStallMs = earlyStallSeconds * 1000;
				const firstTokenStallMs = firstTokenStallSeconds * 1000;
				const midStreamStallMs = midStreamStallSeconds * 1000;

				let stallNotificationHandle: INotificationHandle | undefined;
				const clearStallNotification = () => { stallNotificationHandle?.close(); stallNotificationHandle = undefined; };
				const setInlineStall = () => {
					const cur = this.streamState[threadId];
					if (cur?.isRunning !== 'LLM' || cur.stallInfo) { return; }
					this._setStreamState(threadId, { ...cur, stallInfo: { stalledAt: Date.now() } });
				};
				const clearInlineStall = () => {
					const cur = this.streamState[threadId];
					if (cur?.isRunning !== 'LLM' || !cur.stallInfo) { return; }
					this._setStreamState(threadId, { ...cur, stallInfo: undefined });
				};
				const notifyStall = (kind: 'noFirstToken' | 'midStream') => {
					clearStallNotification();
					setInlineStall();
					// Diagnostics: make the silent gap explicit in the chat-run trace timeline (it otherwise
					// shows llmTurn:start → nothing until done/hard-stall). See vibeStallDiagnostics.
					recordChatTrace('llmTurn:soft-stall', { kind, sec: kind === 'noFirstToken' ? firstTokenStallSeconds : midStreamStallSeconds, provider: modelSelection?.providerName, model: modelSelection?.modelName });
					const msg = kind === 'noFirstToken'
						? localize('agentStall.noFirstToken', 'Агент ждёт ответ модели (>{0}с). Модель может быть медленной, либо соединение зависло.', firstTokenStallSeconds)
						: localize('agentStall.midStream', 'Стрим ответа модели приостановился (>{0}с без новых токенов). Модель могла зависнуть.', midStreamStallSeconds);
					stallNotificationHandle = this._notificationService.notify({ severity: Severity.Warning, message: msg });
				};
				let earlyStallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(setInlineStall, earlyStallMs);
				let firstTokenStallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { notifyStall('noFirstToken'); }, firstTokenStallMs);
				let midStreamStallTimer: ReturnType<typeof setTimeout> | undefined;

				// Hard-stall watchdog: auto-abort the stream if no new tokens arrive within the
				// user-configurable timeout. Reset on every onText chunk; cleared on complete/abort/error.
				// Without this, a provider hang (silent upstream drop, payload too large, etc.) leaves
				// `isRunning='LLM'` latched forever and blocks every subsequent submit in the app.
				// `llmCancelToken` is assigned right below (just before sendLLMMessage); the timer
				// fires seconds later, so the captured ref is always populated by then.
				const hardStallEnabled = this._configurationService.getValue<boolean>('vibeide.chat.streamHardStallEnabled') ?? true;
				const hardStallSeconds = readClampedNumberSetting(this._configurationService, 'vibeide.chat.streamHardStallSeconds', DEFAULT_HARD_STALL_SECONDS, 30, 1800);
				let hardStallTimer: ReturnType<typeof setTimeout> | undefined;
				const onHardStall = () => {
					// No partial content commit: hardStall resets on every token, so reaching it
					// means nothing arrived. Abort the LLM call, drop the stream state, then either
					// auto-retry the turn ONCE (Zen holds large payloads without a single byte —
					// observed repeatedly on 40-90k-token requests; a fresh attempt usually goes
					// through) or surface the error so the user can retry / switch models.
					try { if (llmCancelToken) { this._llmMessageService.abort(llmCancelToken); } } catch { /* already aborted */ }
					clearTimeout(earlyStallTimer); earlyStallTimer = undefined;
					clearTimeout(firstTokenStallTimer); firstTokenStallTimer = undefined;
					clearTimeout(midStreamStallTimer); midStreamStallTimer = undefined;
					clearTimeout(hardStallTimer); hardStallTimer = undefined;
					clearStallNotification();

					// Diagnostics: record the hard-stall in the chat-run trace (anyToken=false confirms a
					// truly silent send-path hang vs a mid-stream freeze). See vibeStallDiagnostics.
					recordChatTrace('llmTurn:hard-stall', { sec: hardStallSeconds, anyToken: firstTokenReceived, provider: modelSelection?.providerName, model: modelSelection?.modelName });
					vibeLog.warn('chatThread', `[stall] hard-stall after ${hardStallSeconds}s, anyToken=${firstTokenReceived}, provider=${modelSelection?.providerName}, model=${modelSelection?.modelName}`);

					// Single retry by design: a SECOND hard-stall right after a fresh attempt means
					// the hang is systemic (payload/provider), not transient — surface it instead of
					// burning another silent 120s window. Streak resets on any successful reply.
					const autoRetryEnabled = this._configurationService.getValue<boolean>('vibeide.chat.hardStallAutoRetry') !== false;
					const stallStreak = this._hardStallAutoRetryStreak.get(threadId) ?? 0;
					if (autoRetryEnabled && stallStreak < HARD_STALL_AUTO_RETRY_MAX) {
						this._hardStallAutoRetryStreak.set(threadId, stallStreak + 1);
						vibeLog.warn('chatThread', `Hard-stall auto-retry: re-sending the turn (attempt ${stallStreak + 1}/${HARD_STALL_AUTO_RETRY_MAX}, threadId=${threadId}).`);
						this._notificationService.notify({
							severity: Severity.Info,
							message: localize('vibeide.chatThread.hardStallAutoRetry', 'Стрим завис ({0}с без токенов) — пробую отправить ход заново автоматически.', String(hardStallSeconds)),
						});
						// Non-terminal clear: the turn is about to be re-sent — don't play a run-end sound.
						this._suppressStopSound(threadId);
						this._setStreamState(threadId, { isRunning: undefined });
						const retryTimer = setTimeout(async () => {
							if (this.streamState[threadId]?.isRunning !== undefined) { return; }
							// Phase-3 durable fix: a silent stall on a cloud provider is most often a wedged
							// shared undici keep-alive pool — reusing it would just stall again. Recreate the
							// transport BEFORE the retry (the user's manual workaround was switching provider /
							// restart, both of which got a fresh pool). Gated so it can be disabled.
							await this._maybeResetTransportForStall(threadId, 'auto-retry');
							if (this.streamState[threadId]?.isRunning === undefined) {
								this._runChatAgent({ threadId, ...this._currentModelSelectionProps() });
							}
						}, 2_000);
						this._register(toDisposable(() => clearTimeout(retryTimer)));
						return;
					}

					this._setStreamState(threadId, {
						isRunning: undefined,
						error: {
							message: localize('vibeide.chatThread.streamHardStall', 'Стрим завис — нет токенов уже {0}с. Провайдер может быть недоступен, перегружен или отклонил слишком большой запрос. Повторите попытку, переключите модель или сократите переписку.', String(hardStallSeconds)),
							fullError: null,
							// 'retry' marker so the terminal error renders a "Повторить запрос" button
							// (retryStalledStream) — recovery without a window reload, since the StallBanner
							// is gone once the stream is terminated here.
							recoverable: 'retry',
						},
					});
					// Diagnostic mode (armed by "Повторить с диагностикой"): auto-build the stall report so the
					// user doesn't have to click after the second stall. One-shot — disarm after firing.
					if (this._autoCollectStallDiagByThread.has(threadId)) {
						this._autoCollectStallDiagByThread.delete(threadId);
						// Literal (not imported) to avoid a circular import with vibeStallDiagnosticsAction,
						// which imports IChatThreadService. Canonical id: VIBE_COLLECT_STALL_DIAGNOSTICS_ID.
						void this._commandService.executeCommand('vibeide.chat.collectStallDiagnostics');
					}
				};
				if (hardStallEnabled) { hardStallTimer = setTimeout(onHardStall, hardStallSeconds * 1000); }

				// Streaming-gap watchdog FSM (common/streamingGapWatchdog.ts).
				let watchdogState: WatchdogState = { kind: 'idle' };
				let watchdogAbortFn: (() => void) | undefined;  // set after sendLLMMessage returns
				const applyWatchdogEffects = (effects: readonly WatchdogSideEffect[]) => {
					for (const fx of effects) {
						if (fx.kind === 'show-waiting') {
							setInlineStall();
						} else if (fx.kind === 'show-retrying') {
							this._notificationService.notify({ severity: Severity.Info, message: localize('vibeide.streamRetrying', 'Переподключение к AI-провайдеру (попытка {0})…', fx.attempt) });
						} else if (fx.kind === 'auto-retry-scheduled') {
							watchdogRetry = true;
							shouldRetryLLM = true;
							watchdogAbortFn?.();
						} else if (fx.kind === 'audit') {
							void this._auditLogService.append({ ts: Date.now(), action: fx.event as unknown as AuditEvent['action'], ok: true });
						}
					}
				};
				const watchdogTimerWindow = getActiveWindow();
				let watchdogTickTimer: number | undefined = watchdogTimerWindow.setInterval(() => {
					const { state, effects } = transitionWatchdog(watchdogState, { kind: 'tick', now: Date.now() });
					watchdogState = state;
					applyWatchdogEffects(effects);
				}, 5_000);
				const clearWatchdogTimer = () => { if (watchdogTickTimer) { watchdogTimerWindow.clearInterval(watchdogTickTimer); watchdogTickTimer = undefined; } };
				const { state: wds0, effects: wde0 } = transitionWatchdog(watchdogState, { kind: 'start', now: Date.now() });
				watchdogState = wds0;
				applyWatchdogEffects(wde0);

				// O.6 + O.9: read overrides fresh per iteration (auto-downgrade may have
				// written a new override mid-loop, the captured `overridesOfModel` from
				// _runChatAgent setup would be stale). For probe iterations (O.9), strip
				// the auto-detected override so this single LLM call uses native FC.
				const iterationModelKey = `${modelSelection.providerName}:${modelSelection.modelName}`;
				// O.11 — Cross-session recovery: clear a STALE persisted `_autoDetected` override
				// (auto-downgrade from a PRIOR session) ONCE per session, BEFORE reading overrides for
				// this call. The success-gated re-probe (O.9) can't rescue a model that never yields a
				// tool success in XML (it emits malformed tags instead) — so for cross-session recovery
				// we hand a clean native-FC slate outright. Reason-specific auto-downgrade (numeric-tool-
				// name, threshold 6) re-applies within the session if the quirk is real. Manual/pinned
				// overrides (no `_autoDetected`) are never cleared. Skip models downgraded *this* session.
				// Keyed by resolvedModelSelection (const) to align with downgradedModelsThisSession,
				// which the downgrade block keys the same way.
				const recoveryKey = `${resolvedModelSelection.providerName}:${resolvedModelSelection.modelName}`;
				if (
					resolvedModelSelection.providerName !== 'auto'
					&& !persistentOverrideProbedThisSession.has(recoveryKey)
					&& !downgradedModelsThisSession.has(recoveryKey)
					// No-tools downgrades are deliberate and re-run the turn in a NEW run, where
					// the run-local sets above are fresh — without this session-wide check the
					// recovery cleared the just-written override seconds later and the model
					// 404'd again (downgrade → rerun → recovery undid it → error, 2026-06-08).
					&& !this._noToolsDowngradedModels.has(recoveryKey)
				) {
					persistentOverrideProbedThisSession.add(recoveryKey);
					// Use resolvedModelSelection (const) — NOT the mutable `modelSelection` let. Passing
					// the let into setOverridesOfModel's typed params creates a circular inference that
					// collapses `modelSelection` to `any`. Cast mirrors the downgrade/probe write sites.
					const prov = resolvedModelSelection.providerName as Exclude<typeof resolvedModelSelection.providerName, 'auto'>;
					const persisted = this._settingsService.state.overridesOfModel?.[prov]?.[resolvedModelSelection.modelName];
					// Age guard: «cross-session recovery» exists for STALE overrides (yesterday's
					// aggregator quirk may be fixed today). An override written minutes ago — e.g.
					// just before a window reload or by a downgrade-rerun — is not stale; clearing
					// it only re-triggers the original failure chain.
					const RECOVERY_MIN_OVERRIDE_AGE_MS = 10 * 60 * 1000;
					const isFreshOverride = typeof persisted?._detectedAt === 'number' && (Date.now() - persisted._detectedAt) < RECOVERY_MIN_OVERRIDE_AGE_MS;
					if (persisted?._autoDetected && !isFreshOverride) {
						try {
							await this._settingsService.setOverridesOfModel(prov, resolvedModelSelection.modelName, undefined);
							this._agentActivityLog.logFinished(`Cross-session recovery: cleared stale XML override for ${recoveryKey} → native FC this session`);
						} catch (e) {
							this._agentActivityLog.logError(`Cross-session override clear failed for ${recoveryKey}: ${getErrorMessage(e)}`);
						}
					}
				}
				let effectiveOverridesForCall = this._settingsService.state.overridesOfModel;
				probeActiveThisCall = undefined;
				if (probeRequestedForModel.has(iterationModelKey)) {
					const providerOverrides = effectiveOverridesForCall?.[modelSelection.providerName as Exclude<typeof modelSelection.providerName, 'auto'>];
					const existing = providerOverrides?.[modelSelection.modelName];
					if (existing?._autoDetected) {
						effectiveOverridesForCall = { ...effectiveOverridesForCall };
						effectiveOverridesForCall[modelSelection.providerName as Exclude<typeof modelSelection.providerName, 'auto'>] = {
							...providerOverrides,
						};
						delete effectiveOverridesForCall[modelSelection.providerName as Exclude<typeof modelSelection.providerName, 'auto'>]![modelSelection.modelName];
						probeActiveThisCall = iterationModelKey;
						probeRequestedForModel.delete(iterationModelKey); // one-shot — consumed
						this._agentActivityLog.logStarted(`Re-probe: ${iterationModelKey} → native FC attempt`);
					}
				}

				// DURABLE turn trace (kept intentionally — this pipeline breaks often and
				// the timeline is the only way to stop guessing). Renderer-side, so it
				// surfaces in DevTools. Measures the silent reasoning-warmup gap (start →
				// first-activity) that has been mistaken for a hang.
				const _turnStartMs = Date.now();
				vibeLog.debug('llmTurn', 'start', { iter: nMessagesSent, msgs: messages.length, model: modelSelection?.modelName, provider: modelSelection?.providerName, chatMode }); recordChatTrace('llmTurn:start', { iter: nMessagesSent, msgs: messages.length, model: modelSelection?.modelName, provider: modelSelection?.providerName });
				// Consume the one-shot force flag (set by the premature-stop nudge below): this turn
				// requests tool_choice=required so a weak caller can't return prose again.
				const forceThisTurn = forceToolUseNextTurn;
				forceToolUseNextTurn = false;
				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel: effectiveOverridesForCall,
					forceToolUse: forceThisTurn,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode, requestId: finalRequestId } },
					separateSystemMessage: separateSystemMessage,
					onText: ({ fullText, fullReasoning, toolCall }) => {
						// Guard: Don't update stream state if message is already done (prevents late onText calls from requestAnimationFrame)
						if (messageIsDone) {
							return;
						}

						// Clear timeout once we receive first chunk
						clearTimeout(networkTimeout);
						// Track first token (TTFS) and network end (when we receive first chunk)
						// Check both fullText and fullReasoning - first token might be in either
						if (!firstTokenReceived && (fullText.length > 0 || fullReasoning.length > 0)) {
							firstTokenReceived = true;
							chatLatencyAudit.markNetworkEnd(finalRequestId); // Network complete when first token arrives
							vibeLog.debug('llmTurn', 'first-activity', { afterMs: Date.now() - _turnStartMs, kind: fullText.length > 0 ? 'text' : 'reasoning' }); recordChatTrace('llmTurn:first-activity', { afterMs: Date.now() - _turnStartMs });
							chatLatencyAudit.markFirstToken(finalRequestId);
						}

						// Accumulate streamed text into the retry cache so a stream-error retry
						// can resume from where the previous attempt left off (L1185).
						if (fullText.length > _retryLastTextLen) {
							const delta = fullText.slice(_retryLastTextLen);
							_retryPartial = appendChunk(_retryPartial, finalRequestId, delta, Date.now());
							_retryLastTextLen = fullText.length;
						}

						// Stall watchdog: cancel first-token stall timer, reset early + mid-stream + hard-stall timers, drop inline banner.
						if (firstTokenStallTimer !== undefined) { clearTimeout(firstTokenStallTimer); firstTokenStallTimer = undefined; clearStallNotification(); }
						clearTimeout(earlyStallTimer); earlyStallTimer = setTimeout(setInlineStall, earlyStallMs);
						clearTimeout(midStreamStallTimer);
						midStreamStallTimer = setTimeout(() => { notifyStall('midStream'); }, midStreamStallMs);
						if (hardStallTimer !== undefined) { clearTimeout(hardStallTimer); hardStallTimer = setTimeout(onHardStall, hardStallSeconds * 1000); }
						clearInlineStall();

						// Streaming gap watchdog: record incoming chunk.
						{
							const { state, effects } = transitionWatchdog(watchdogState, { kind: 'chunk', now: Date.now() });
							watchdogState = state;
							applyWatchdogEffects(effects);
						}

						// Batch token updates for smooth 60 FPS rendering
						const context = chatLatencyAudit.getContext(finalRequestId);
						if (context) {
							context.currentBatchSize++;
							const now = performance.now();
							// Flush batch if enough time has passed (target 60fps = ~16.67ms)
							if (now - context.lastBatchTime >= 16.67) {
								if (context.renderBatchSizes.length < 100) {
									context.renderBatchSizes.push(context.currentBatchSize);
								}
								context.currentBatchSize = 0;
								context.lastBatchTime = now;
							}
						}

						// Use requestAnimationFrame for smooth updates
						getActiveWindow().requestAnimationFrame(() => {
							// Guard again: Check if message is done before updating state (prevents race conditions)
							if (messageIsDone) {
								return;
							}
							// Also check if stream state is still 'LLM' (another guard against late updates)
							const currentState = this.streamState[threadId];
							if (currentState?.isRunning !== 'LLM') {
								return;
							}

							// Record render frame for FPS tracking
							chatLatencyAudit.recordRenderFrame(finalRequestId);
							this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) { this._llmMessageService.abort(llmCancelToken); } }) });
						});
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, usage }) => {
						vibeLog.debug('llmTurn', 'done', { afterMs: Date.now() - _turnStartMs, toolCall: toolCall?.name ?? null, textLen: fullText?.length ?? 0, reasoningLen: fullReasoning?.length ?? 0 }); recordChatTrace('llmTurn:done', { afterMs: Date.now() - _turnStartMs, toolCall: toolCall?.name ?? null });
						// Mark message as done to prevent late onText updates
						messageIsDone = true;

						// Reset empty-response streak for this (thread × provider × model)
						// combo on any successful response. The breaker only trips on
						// CONSECUTIVE empties; one good reply means the model is alive again.
						if (modelSelection) {
							this._emptyResponseStreak.delete(`${threadId}:${modelSelection.providerName}:${modelSelection.modelName}`);
							this._rateLimitAutoWaitStreak.delete(threadId);
							this._hardStallAutoRetryStreak.delete(threadId);
							// Also reset the cross-thread health tracker for this combo. One good
							// response means the aggregator route is healthy again; next failure
							// cycle starts fresh.
							const wasDegraded = this._modelHealthTracker.isDegraded(modelSelection.providerName, modelSelection.modelName);
							this._modelHealthTracker.recordSuccess(modelSelection.providerName, modelSelection.modelName);
							if (wasDegraded) { this._onDidChangeProviderHealth.fire(); }
						}

						// Persist provider-reported token usage on the thread so the UI
						// context-usage indicator can show real numbers instead of length/4
						// estimates. `usage` is undefined on early-timeout / non-AI-SDK paths.
						if (usage && (typeof usage.promptTokens === 'number' || typeof usage.completionTokens === 'number' || typeof usage.totalTokens === 'number')) {
							this._setThreadState(threadId, { lastUsage: usage });
							// Feed the real promptTokens back to the token-budget estimator so it self-calibrates
							// per (provider×model) — closes the gap between our length/4 estimate and the
							// provider's true count (tool schemas, formatting, tokenizer). Roadmap "provider-reported usage".
							if (modelSelection && typeof usage.promptTokens === 'number' && usage.promptTokens > 0) {
								this._convertToLLMMessagesService.recordActualPromptTokens(modelSelection.providerName, modelSelection.modelName, usage.promptTokens);
							}
						}

						// Clear timeout
						clearTimeout(networkTimeout);
						// Clear stall watchdog timers
						clearTimeout(earlyStallTimer); earlyStallTimer = undefined;
						clearTimeout(firstTokenStallTimer); firstTokenStallTimer = undefined;
						clearTimeout(midStreamStallTimer); midStreamStallTimer = undefined;
						clearTimeout(hardStallTimer); hardStallTimer = undefined;
						clearStallNotification();
						clearWatchdogTimer();
						{
							const { state, effects } = transitionWatchdog(watchdogState, { kind: 'complete', now: Date.now() });
							watchdogState = state;
							applyWatchdogEffects(effects);
						}
						// Ensure network end and first token are tracked (fallback for non-streaming responses)
						// If onText was never called, this is a non-streaming response - treat final message as first token
						if (!firstTokenReceived) {
							chatLatencyAudit.markNetworkEnd(finalRequestId);
							// For non-streaming responses, the final message IS the first token
							// Only mark if we actually have content (not an empty response)
							const hasContent = (fullText && fullText.length > 0) || (fullReasoning && fullReasoning.length > 0);
							if (hasContent) {
								chatLatencyAudit.markFirstToken(finalRequestId);
							}
						}
						// Track completion (TTS) and output tokens
						// Use fullText length, or fallback to reasoning if text is empty
						const textToCount = fullText || fullReasoning || '';
						// More accurate token estimation: account for markdown, code blocks, etc.
						const outputTokens = textToCount.length > 0 ? Math.max(1, Math.ceil(textToCount.length / 3.5)) : 0;
						chatLatencyAudit.markStreamComplete(finalRequestId, outputTokens);
						// W.20 fix — completeRequest unconditionally drops the context
						// (and stops the 60fps render-monitoring interval when contexts
						// drain to zero). Pre-W.20 it was gated on `auditEnabled`, so with
						// audit disabled the context (and interval) leaked forever.
						const metrics = chatLatencyAudit.completeRequest(finalRequestId);
						if (auditEnabled && metrics) {
							chatLatencyAudit.logMetrics(metrics);
						}

						// Audit log: record reply
						// PERFORMANCE: Reuse cached auditEnabled check from earlier in function
						if (auditEnabled && modelSelection) {
							await this._auditLogService.append({
								ts: Date.now(),
								action: 'reply',
								model: `${modelSelection.providerName}/${modelSelection.modelName}`,
								latencyMs: metrics ? metrics.tts : undefined,
								ok: true,
								meta: {
									threadId,
									requestId: finalRequestId,
									outputTokens,
									ttfs: metrics?.ttfs,
									// Real provider-reported usage when available (AI SDK `finish` part).
									// Lets downstream stats distinguish heuristic from authoritative counts.
									...(usage ? {
										promptTokens: usage.promptTokens,
										completionTokens: usage.completionTokens,
										totalTokens: usage.totalTokens,
									} : {}),
								},
							});
						}

						// Vision-drop heuristic: if the user attached an image and the reply reads as
						// an apology for not receiving one, the provider likely silently stripped the
						// image despite advertising vision support. Offer a one-click block.
						if (modelSelection && originalUserMessage && originalUserMessage.images && originalUserMessage.images.length > 0) {
							this._maybeShowVisionDropWarning(modelSelection, fullText);
						}

						resMessageIsDonePromise({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, anthropicReasoning } }); // resolve with tool calls
					},
					onError: async (error) => {
						// Clear timeout
						clearTimeout(networkTimeout);
						// Clear stall watchdog timers
						clearTimeout(earlyStallTimer); earlyStallTimer = undefined;
						clearTimeout(firstTokenStallTimer); firstTokenStallTimer = undefined;
						clearTimeout(midStreamStallTimer); midStreamStallTimer = undefined;
						clearTimeout(hardStallTimer); hardStallTimer = undefined;
						clearStallNotification();
						clearWatchdogTimer();
						{
							const { state, effects } = transitionWatchdog(watchdogState, { kind: 'provider-error', now: Date.now() });
							watchdogState = state;
							applyWatchdogEffects(effects);
						}
						// Ensure network end is tracked even on error (idempotent - safe to call multiple times)
						chatLatencyAudit.markNetworkEnd(finalRequestId);
						// Mark stream as complete with 0 tokens on error
						chatLatencyAudit.markStreamComplete(finalRequestId, 0);
						// Diagnostic breadcrumb: which error reached the chat-level handler and with
						// what classification inputs. Debug-gated; invaluable when a run "just stops"
						// (the 2026-06-07 rate-limit auto-wait silently not firing took a session to
						// reconstruct without this line).
						vibeLog.debug('chatThread', 'onError', {
							requestId: finalRequestId,
							msgHead: (error?.message ?? '').slice(0, 100),
							status: (error?.fullError as { statusCode?: number } | null | undefined)?.statusCode,
							autopilot: this._settingsService.state.globalSettings.chatAgentAutopilot === true,
							rateWaitStreak: this._rateLimitAutoWaitStreak.get(threadId) ?? 0,
						});

						// Empty-response circuit breaker. Parse provider/model out of OUR
						// own error template (no hardcoded names). If the same combo
						// returns "Empty response" N times in a row, swap the toast for
						// a sticky inline error with `recoverable: 'switchModel'` so the
						// user sees one clear "open settings" affordance instead of
						// hammering Send on a model the aggregator clearly can't drive
						// right now. Counter is reset on the next successful response
						// (onFinalMessage below). Type widened to include `recoverable`
						// since the source `error` parameter (from LLMMessageService
						// onError contract) doesn't expose that field.
						type StreamError = { message: string; fullError: Error | null; recoverable?: 'dismissPlan' | 'forceReset' | 'switchModel' | 'retry' };
						let effectiveError: StreamError | undefined = error as StreamError | undefined;
						// Parse via shared helper — single source of truth with the four
						// emission sites that build the message via `buildEmptyResponseError`.
						// If anyone changes the template, only sendLLMMessageTypes.ts needs
						// touching; this consumer stays correct.
						// Context-overflow classification — distinct from generic "empty response".
						// Emitted by the LLM layer when an upstream finishReason / error body
						// matches the OVERFLOW_PATTERNS catalogue (see sendLLMMessageTypes.ts).
						// Surface as a sticky inline error immediately (no streak counter):
						// the next attempt will overflow again until the user actually
						// compacts the chat or switches model, so escalating right away is
						// strictly better UX than N toasts in a row.
						const overflowMatch = error?.message ? parseContextOverflowError(error.message) : null;
						if (overflowMatch) {
							const { providerName: overflowProvider, modelName: overflowModel } = overflowMatch;
							this._modelHealthTracker.recordFailure(overflowProvider, overflowModel, 'context-overflow');
							effectiveError = {
								message: localize(
									'vibeide.chatThread.contextOverflow',
									'Контекст превысил окно модели {0} через {1}. Сожмите историю чата (Compact) или переключитесь на модель с большим контекстным окном — следующая попытка без действий упрётся в тот же лимит.',
									overflowModel,
									overflowProvider,
								),
								fullError: error?.fullError ?? null,
								recoverable: 'switchModel',
							};
							vibeLog.warn('chatThread', `Context overflow: ${overflowProvider}/${overflowModel} (threadId=${threadId}).`);
							this._metricsService.capture('Context Overflow', {
								providerName: overflowProvider,
								modelName: overflowModel,
							});
						}

						const emptyMatch = !overflowMatch && error?.message ? parseEmptyResponseError(error.message) : null;
						if (emptyMatch) {
							const { providerName: errProvider, modelName: errModel } = emptyMatch;
							this._modelHealthTracker.recordFailure(errProvider, errModel, 'empty-response');
							const key = `${threadId}:${errProvider}:${errModel}`;
							const streak = (this._emptyResponseStreak.get(key) ?? 0) + 1;
							this._emptyResponseStreak.set(key, streak);
							const threshold = Math.max(1, Math.min(20,
								this._configurationService.getValue<number>('vibeide.chat.emptyResponseCircuitBreakerThreshold') ?? 3
							));
							if (streak >= threshold) {
								this._emptyResponseStreak.delete(key);
								effectiveError = {
									message: localize(
										'vibeide.chatThread.emptyResponseCircuitBreaker',
										'Модель {0} через {1} вернула пустой ответ {2} раз подряд. Это известный паттерн отказа aggregator-проксированных моделей (минимакс/qwen через openCodeGo-zen и др.) — обычно временный сбой провайдера или несовместимость wire-протокола. Откройте настройки и выберите другую модель, либо подождите и попробуйте позже.',
										errModel,
										errProvider,
										String(streak),
									),
									fullError: error?.fullError ?? null,
									recoverable: 'switchModel',
								};
								vibeLog.warn('chatThread', `Empty-response circuit breaker tripped: ${errProvider}/${errModel} × ${streak} (threadId=${threadId}).`);
								this._metricsService.capture('Circuit Breaker Tripped — Empty Response', {
									providerName: errProvider,
									modelName: errModel,
									streak,
									breakerLimit: threshold,
								});
							}
						}

						// Auto-wait on minute-window rate limits (token-economy follow-up): a 429
						// whose retry-after is SECONDS (day-scale ones are re-statused to 402
						// upstream — see customFetch) means «slow down», not «broken». Stopping the
						// run over a transient TPM window forces the user to babysit «продолжи»
						// (observed: Anthropic org limit 30k input-tokens/min at ~23k-token turns,
						// 3-4 manual resumes per task). Deliberately NOT gated on Autopilot — this
						// is an infrastructure retry of the same LLM turn, no tools are executed
						// during the pause, so it is safe in supervised mode too.
						if (!overflowMatch && !emptyMatch
							&& /rate.?limit|too many requests|\b429\b/i.test(error?.message ?? '')) {
							const rawWaitMax = this._configurationService.getValue<unknown>('vibeide.chat.rateLimitAutoWaitMaxSeconds');
							const waitMaxSec = (typeof rawWaitMax === 'number' && Number.isFinite(rawWaitMax) && rawWaitMax >= 0) ? Math.floor(rawWaitMax) : 120;
							const rawWaitRetries = this._configurationService.getValue<unknown>('vibeide.chat.rateLimitAutoWaitMaxRetries');
							const waitMaxRetries = (typeof rawWaitRetries === 'number' && Number.isFinite(rawWaitRetries) && rawWaitRetries >= 0) ? Math.floor(rawWaitRetries) : 3;
							const streak = this._rateLimitAutoWaitStreak.get(threadId) ?? 0;
							// retry-after may sit on the wrapper, the last inner error, or be absent
							// (default 30s ≈ a minute-window half-life).
							const rawErr0 = error?.fullError as { responseHeaders?: Record<string, string>; lastError?: unknown; errors?: unknown[] } | null | undefined;
							const candidates = [rawErr0, rawErr0?.lastError, ...(Array.isArray(rawErr0?.errors) ? rawErr0.errors : [])] as Array<{ responseHeaders?: Record<string, string> } | null | undefined>;
							let retryAfterSec: number | undefined;
							for (const c of candidates) {
								const ra = Number(c?.responseHeaders?.['retry-after']);
								if (Number.isFinite(ra) && ra > 0) { retryAfterSec = ra; break; }
							}
							// A retry-after beyond the wait cap is a period quota in rate-limit clothing
							// («Rate limit exceeded: Monthly usage limit…») — waiting the capped time is
							// hopeless, fall through to the regular error instead of burning retries.
							const hopelesslyFar = retryAfterSec !== undefined && retryAfterSec > waitMaxSec;
							if (waitMaxSec > 0 && streak < waitMaxRetries && !hopelesslyFar) {
								const waitSec = Math.min(Math.max(retryAfterSec ?? 30, 5), waitMaxSec);
								this._rateLimitAutoWaitStreak.set(threadId, streak + 1);
								vibeLog.warn('chatThread', `Rate-limit auto-wait: resuming in ${waitSec}s (attempt ${streak + 1}/${waitMaxRetries}, threadId=${threadId}).`);
								// Inline pauseInfo drives the visible countdown banner; the toast stays as an
								// out-of-focus signal. resumeAtMs lets the UI tick down without extra state.
								this._setStreamState(threadId, {
									isRunning: undefined,
									pauseInfo: { resumeAtMs: Date.now() + waitSec * 1000, attempt: streak + 1, maxAttempts: waitMaxRetries, reason: 'rateLimit' },
								});
								this._notificationService.notify({
									severity: Severity.Info,
									message: localize('vibeide.chatThread.rateLimitAutoWait', 'Провайдер взял паузу (лимит запросов) на {0}с — продолжу автоматически (попытка {1} из {2}).', String(waitSec), String(streak + 1), String(waitMaxRetries)),
								});
								this._clearRateLimitResumeTimer(threadId);
								const resumeTimer = setTimeout(() => {
									this._rateLimitResumeTimers.delete(threadId);
									// Resume only if the user hasn't already restarted the thread manually.
									if (this.streamState[threadId]?.isRunning === undefined) {
										this._runChatAgent({ threadId, ...this._currentModelSelectionProps() });
									}
								}, waitSec * 1000);
								this._rateLimitResumeTimers.set(threadId, resumeTimer);
								this._register(toDisposable(() => clearTimeout(resumeTimer)));
								return;
							}
						}

						// Tools-unsupported endpoint (observed: OpenRouter free variants → 404
						// «No endpoints found that support the provided 'tool_choice'»). Native FC
						// can never work on this route — flip the model to the XML tool-format
						// override (same mechanism as the numeric-tool-name auto-downgrade) and
						// re-run the turn automatically. Once per model per session.
						const noToolsEndpoint = /no endpoints found that support.{0,40}tool|does not support tool(?:s| use| calling)/i.test(error?.message ?? '');
						// Guard MUST be class-level (_noToolsDowngradedModels): the retry below starts a
						// NEW _runChatAgent whose run-local `downgradedModelsThisSession` is fresh — a
						// run-local guard let the downgrade toast loop forever (observed 2026-06-07).
						if (noToolsEndpoint && modelSelection && modelSelection.providerName !== 'auto'
							&& !this._noToolsDowngradedModels.has(`${modelSelection.providerName}:${modelSelection.modelName}`)) {
							const modelKey = `${modelSelection.providerName}:${modelSelection.modelName}`;
							try {
								await this._settingsService.setOverridesOfModel(modelSelection.providerName, modelSelection.modelName, {
									// null, NOT undefined — undefined keys are dropped by JSON/IPC
									// serialization and the override never reached the main process.
									specialToolFormat: null,
									_autoDetected: true,
									_detectedAt: Date.now(),
									_reason: 'other',
								});
								this._noToolsDowngradedModels.add(modelKey);
								downgradedModelsThisSession.add(modelKey);
								vibeLog.warn('chatThread', `No-tools endpoint: ${modelKey} → XML tool format, re-running the turn.`);
								this._notificationService.notify({
									severity: Severity.Info,
									message: localize('vibeide.chatThread.noToolsEndpointDowngrade', 'Эндпоинт модели {0} не поддерживает native-вызов инструментов (типично для free-вариантов OpenRouter) — переключаю на XML-формат тулов и повторяю ход автоматически.', modelSelection.modelName),
								});
								this._setStreamState(threadId, { isRunning: undefined });
								const downgradeRetryTimer = setTimeout(() => {
									if (this.streamState[threadId]?.isRunning === undefined) {
										this._runChatAgent({ threadId, ...this._currentModelSelectionProps() });
									}
								}, 1_000);
								this._register(toDisposable(() => clearTimeout(downgradeRetryTimer)));
								return;
							} catch (e) {
								this._agentActivityLog.logError(`No-tools downgrade failed for ${modelKey}: ${getErrorMessage(e)}`);
							}
						}

						// Cross-thread health notification — fires once per (provider,model) every
						// SUPPRESSION_WINDOW_MS when failures cross HEALTH_FAILURE_THRESHOLD within
						// HEALTH_WINDOW_MS. Catches the case where user spread failures across multiple
						// chats but it's the same broken route. Doesn't suppress the inline error in
						// effectiveError (different concern — that's per-thread escalation).
						// 3099: count provider-degradation errors (520/529, rate/usage limit, overload, stream stall,
						// retries-exhausted) toward health so the model-selector chip warns. These errors carry no
						// model in the text → use the run's current selection.
						const providerErrKind = (!overflowMatch && !emptyMatch && modelSelection) ? classifyProviderError(error?.message) : undefined;
						if (providerErrKind && modelSelection) {
							this._modelHealthTracker.recordFailure(modelSelection.providerName, modelSelection.modelName, providerErrKind);
						}

						const healthMatch = overflowMatch ?? emptyMatch ?? (providerErrKind && modelSelection ? { providerName: modelSelection.providerName, modelName: modelSelection.modelName } : null);
						if (healthMatch) { this._onDidChangeProviderHealth.fire(); }
						if (healthMatch && this._modelHealthTracker.shouldNotify(healthMatch.providerName, healthMatch.modelName)) {
							const count = this._modelHealthTracker.getFailureCount(healthMatch.providerName, healthMatch.modelName);
							const windowMin = Math.round(HEALTH_WINDOW_MS / 60_000);
							this._notificationService.notify({
								severity: Severity.Warning,
								message: localize(
									'vibeide.chatThread.modelHealthDegraded',
									'Модель {0} через {1} дала {2} ошибок за последние {3} минут. Возможен временный сбой aggregator-роута — рекомендуем переключиться на другую модель или подождать ~{3} минут.',
									healthMatch.modelName,
									healthMatch.providerName,
									String(count),
									String(windowMin),
								),
							});
							this._metricsService.capture('Model Health Degraded', {
								providerName: healthMatch.providerName,
								modelName: healthMatch.modelName,
								failureCount: count,
								windowMs: HEALTH_WINDOW_MS,
								threshold: HEALTH_FAILURE_THRESHOLD,
							});
							vibeLog.warn('chatThread', `Model health degraded: ${healthMatch.providerName}/${healthMatch.modelName} (${count} failures in ${windowMin} min).`);
						}

						// Translate well-known RAW provider error texts to Russian (deterministic
						// dictionary — no LLM on the error path: the model is what just failed).
						// Our own localized messages (overflow/breaker above) contain Cyrillic and
						// pass through untouched; unmatched English stays as-is.
						if (effectiveError?.message) {
							const translated = translateProviderError(effectiveError.message);
							if (translated) { effectiveError = { ...effectiveError, message: translated }; }
						}

						// Clear stream state immediately so submit button becomes active (avoids stuck "Waiting for model response..." if audit or resolve fails)
						this._setStreamState(threadId, { isRunning: undefined, error: effectiveError });

						// Unified error toast via agentErrorClassifier (L294).
						// SUPPRESSED when the circuit breaker tripped — the sticky inline
						// error (effectiveError.recoverable === 'switchModel') already
						// communicates the situation more clearly than a transient toast.
						if (effectiveError?.recoverable !== 'switchModel') {
							const rawErr = error?.fullError as { statusCode?: unknown; status?: unknown; code?: unknown; errorCode?: unknown } | null | undefined;
							const httpStatus = rawErr?.statusCode ?? rawErr?.status;
							const errorCode = rawErr?.code ?? rawErr?.errorCode;
							const { toast } = classifyAndBuildToast({
								source: 'provider',
								httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
								errorMessage: error?.message,
								errorCode: typeof errorCode === 'string' ? errorCode : undefined,
								requestId: finalRequestId,
							});
							if (toast.severity !== 'info') {
								this._notificationService.notify({
									severity: toast.severity === 'error' ? Severity.Error : Severity.Warning,
									message: `${toast.headline}${toast.body ? ': ' + toast.body : ''}`,
								});
							}
						}

						try {
							// Audit log: record error
							if (auditEnabled && modelSelection) {
								await this._auditLogService.append({
									ts: Date.now(),
									action: 'reply',
									model: `${modelSelection.providerName}/${modelSelection.modelName}`,
									ok: false,
									meta: {
										threadId,
										requestId: finalRequestId,
										error: error?.message,
									},
								});
							}
						} finally {
							resMessageIsDonePromise({ type: 'llmError', error: error });
						}
					},
					onAbort: () => {
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						clearWatchdogTimer();
						const { state: _ws, effects: _we } = transitionWatchdog(watchdogState, { kind: 'cancel', now: Date.now() });
						watchdogState = _ws;
						applyWatchdogEffects(_we);
						resMessageIsDonePromise({ type: 'llmAborted' });
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode });
					},
				});

				// Register abort fn for watchdog-triggered retry.
				if (llmCancelToken) { watchdogAbortFn = () => this._llmMessageService.abort(llmCancelToken); }

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: localize('vibeide.chatThread.send.unexpectedError', 'Непредвиденная ошибка при отправке сообщения в чат.'), fullError: null } });
					break;
				}

				// Update status to show we're waiting for the model response
				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: WAITING_FOR_MODEL_RESPONSE_SENTINEL, reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) });
				const llmRes = await messageIsDonePromise; // wait for message to complete

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return;
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					if (watchdogRetry) {
						// Watchdog triggered the abort for an auto-retry — let the while-loop iterate.
						watchdogRetry = false;
						watchdogAbortFn = undefined;
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor });
						continue;
					}
					this._setStreamState(threadId, undefined);
					return;
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					const { error } = llmRes;
					// Check if this is a rate limit error (429)
					const isRateLimitError = error?.message?.includes('429') ||
						error?.message?.toLowerCase().includes('rate limit') ||
						error?.message?.toLowerCase().includes('tokens per min') ||
						error?.message?.toLowerCase().includes('tpm');

					// In auto mode, try fallback models for ALL errors (not just rate limits)
					// This ensures auto mode is resilient even if one model is failing
					if (isAutoMode) {
						// Get routing decision if we don't have it yet
						if (!originalRoutingDecision && originalUserMessage) {
							try {
								const taskType = this._detectTaskType(originalUserMessage.content, originalUserMessage.images, originalUserMessage.pdfs);
								const hasImages = originalUserMessage.images && originalUserMessage.images.length > 0;
								const hasPDFs = originalUserMessage.pdfs && originalUserMessage.pdfs.length > 0;
								const hasCode = this._detectCodeInMessage(originalUserMessage.content);
								const lowerMessage = originalUserMessage.content.toLowerCase().trim();
								const isCodebaseQuestion = /\b(codebase|code base|repository|repo|project)\b/.test(lowerMessage) ||
									/\b(architecture|structure|organization|layout)\b.*\b(project|codebase|repo|code)\b/.test(lowerMessage);
								const requiresComplexReasoning = isCodebaseQuestion;
								const isLongMessage = originalUserMessage.content.length > 500;

								const context: TaskContext = {
									taskType,
									hasImages,
									hasPDFs,
									hasCode,
									requiresPrivacy: false,
									preferLowLatency: false,
									preferLowCost: false,
									userOverride: null,
									requiresComplexReasoning,
									isLongMessage,
								};

								originalRoutingDecision = await this._modelRouter.route(context);
							} catch (routerError) {
								vibeLog.error('chatThread', '[ChatThreadService] Error getting routing decision for fallback:', routerError);
							}
						}

						// Try next model from fallback chain
						let nextModel: ModelSelection | null = null;
						if (originalRoutingDecision?.fallbackChain && originalRoutingDecision.fallbackChain.length > 0) {
							// Find first model in fallback chain that we haven't tried
							const fallbackChain: ModelSelection[] = originalRoutingDecision.fallbackChain;
							for (const fallbackModel of fallbackChain) {
								const modelKey = `${fallbackModel.providerName}/${fallbackModel.modelName}`;
								if (!triedModels.has(modelKey)) {
									nextModel = fallbackModel;
									break;
								}
							}
						}

						// If no fallback model available, try to get a new routing decision excluding tried models
						if (!nextModel && originalUserMessage) {
							try {
								// Get all available models
								const settingsState = this._settingsService.state;
								const availableModels: ModelSelection[] = [];
								for (const providerName of Object.keys(settingsState.settingsOfProvider) as ProviderName[]) {
									const providerSettings = settingsState.settingsOfProvider[providerName];
									if (!providerSettings._didFillInProviderSettings) { continue; }
									for (const modelInfo of providerSettings.models) {
										if (!modelInfo.isHidden) {
											const modelKey = `${providerName}/${modelInfo.modelName}`;
											if (!triedModels.has(modelKey)) {
												availableModels.push({
													providerName,
													modelName: modelInfo.modelName,
												});
											}
										}
									}
								}

								// If we have other models available, try to route to one
								if (availableModels.length > 0) {
									const taskType = this._detectTaskType(originalUserMessage.content, originalUserMessage.images, originalUserMessage.pdfs);
									const hasImages = originalUserMessage.images && originalUserMessage.images.length > 0;
									const hasPDFs = originalUserMessage.pdfs && originalUserMessage.pdfs.length > 0;
									const hasCode = this._detectCodeInMessage(originalUserMessage.content);
									const lowerMessage = originalUserMessage.content.toLowerCase().trim();
									const isCodebaseQuestion = /\b(codebase|code base|repository|repo|project)\b/.test(lowerMessage);
									const requiresComplexReasoning = isCodebaseQuestion;
									const isLongMessage = originalUserMessage.content.length > 500;

									const context: TaskContext = {
										taskType,
										hasImages,
										hasPDFs,
										hasCode,
										requiresPrivacy: false,
										preferLowLatency: false,
										preferLowCost: false,
										userOverride: null,
										requiresComplexReasoning,
										isLongMessage,
									};

									const newRoutingDecision = await this._modelRouter.route(context);
									if (newRoutingDecision.modelSelection.providerName !== 'auto') {
										const modelKey = `${newRoutingDecision.modelSelection.providerName}/${newRoutingDecision.modelSelection.modelName}`;
										if (!triedModels.has(modelKey)) {
											nextModel = newRoutingDecision.modelSelection;
											originalRoutingDecision = newRoutingDecision; // Update for next fallback
										}
									}
								}
							} catch (routerError) {
								vibeLog.error('chatThread', '[ChatThreadService] Error getting new routing decision:', routerError);
							}
						}

						// If we found a next model, switch to it and retry
						if (nextModel) {
							// Safety check: prevent infinite loops by limiting total model switches
							if (triedModels.size >= 10) {
								vibeLog.warn('chatThread', '[ChatThreadService] Auto mode: Too many model switches, stopping fallback attempts');
								// Fall through to show error
							} else {
								vibeLog.info('chatThread', `[ChatThreadService] Auto mode: Model ${modelSelection?.providerName}/${modelSelection?.modelName} failed, trying fallback: ${nextModel.providerName}/${nextModel.modelName}`);
								modelSelection = nextModel;
								// Update resolvedModelSelection and options for next iteration
								resolvedModelSelection = nextModel;
								// Type assertion is safe because nextModel is not "auto" (it came from fallback chain)
								const nextProviderName = nextModel.providerName as Exclude<typeof nextModel.providerName, 'auto'>;
								resolvedModelSelectionOptions = this._settingsService.state.optionsOfModelSelection['Chat']?.[nextProviderName]?.[nextModel.modelName];
								// Update request ID for new model.
								// W.20 fix — drain the previous context first; the fallback
								// path used to start a new request without closing the old
								// one, leaking 60fps render-monitoring contexts on every
								// model switch.
								chatLatencyAudit.completeRequest(finalRequestId);
								const newRequestId = generateUuid();
								chatLatencyAudit.startRequest(newRequestId, nextModel.providerName, nextModel.modelName);
								chatLatencyAudit.markRouterStart(newRequestId);
								chatLatencyAudit.markRouterEnd(newRequestId);
								// Reset attempt counter for new model (but keep triedModels to avoid retrying same model)
								nAttempts = 0;
								shouldRetryLLM = true;
								this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor });
								// Short delay before trying next model
								await timeout(500);
								if (interruptedWhenIdle) {
									this._setStreamState(threadId, undefined);
									return;
								}
								continue; // retry with new model
							}
						}
					}

					// If we're in auto mode and didn't find a fallback model, or if we're not in auto mode:
					// For rate limit errors in non-auto mode, show error immediately
					if (isRateLimitError && !isAutoMode) {
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo;
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null });
						if (toolCallSoFar) { this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) }); }

						this._setStreamState(threadId, { isRunning: undefined, error });
						await this._addUserCheckpoint({ threadId });
						return;
					}

					// For non-rate-limit errors in non-auto mode, or if we're in auto mode but no fallback was found:
					// Retry the same model if we haven't exceeded retry limit (only for non-auto mode or if no fallback available)
					const maxChatRetries = Math.max(0, Math.min(10, this._configurationService.getValue<number>('vibeide.chat.maxRetries') ?? CHAT_RETRIES));
					if (!isAutoMode && nAttempts < maxChatRetries) {
						// Compute resume strategy before the delay so any prefill/skip info is
						// ready when the while-loop iterates. Anthropic prefill injection would
						// require provider-API support; for now we log the decision (L1185).
						const resumeDecision = decideResume(_retryPartial, false, Date.now());
						if (resumeDecision.kind === 'resume-replay') {
							vibeLog.info('chatThread', `[ChatThreadService] Retry ${nAttempts}: resume-replay, skip ${resumeDecision.alreadyRenderedChars} chars`);
						} else if (resumeDecision.kind === 'expired-partial') {
							vibeLog.info('chatThread', `[ChatThreadService] Retry ${nAttempts}: partial expired (${resumeDecision.previousChars} chars), restarting`);
						}
						shouldRetryLLM = true;
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor });
						// Faster retries for local models (they fail fast if not available)
						const isLocalProvider = modelSelection && (modelSelection.providerName === 'ollama' || modelSelection.providerName === 'vLLM' || modelSelection.providerName === 'lmStudio' || modelSelection.providerName === 'openAICompatible' || modelSelection.providerName === 'liteLLM');
						// Use shorter delays for local models: 0.5s, 1s, 2s (vs 1s, 2s, 4s for remote)
						const initialRetryDelay = Math.max(0, Math.min(60_000, this._configurationService.getValue<number>('vibeide.chat.retryInitialDelayMs') ?? INITIAL_RETRY_DELAY));
						const maxRetryDelay = Math.max(0, Math.min(120_000, this._configurationService.getValue<number>('vibeide.chat.retryMaxDelayMs') ?? MAX_RETRY_DELAY));
						const baseDelay = isLocalProvider ? 500 : initialRetryDelay;
						const retryDelay = Math.min(baseDelay * Math.pow(2, nAttempts - 1), maxRetryDelay);
						await timeout(retryDelay);
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined);
							return;
						}
						else { continue; } // retry
					}
					// error, but too many attempts or no fallback available in auto mode
					else {
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo;
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null });
						if (toolCallSoFar) { this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) }); }

						this._setStreamState(threadId, { isRunning: undefined, error });
						await this._addUserCheckpoint({ threadId });
						return;
					}
				}

				// CRITICAL: Check for pending plan before executing any tool from LLM response
				// Use fast check - flag should catch most cases
				if (checkPlanGenerated()) {
					// Plan is pending approval - stop execution and wait
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
					return;
				}

				// llm res success
				let { toolCall, info } = llmRes;

				// CRITICAL: Check if model output JSON tool call format as text
				// Some models output tool calls as JSON text instead of using native tool calling
				// Parse it and convert to proper tool call format
				if (!toolCall && info.fullText.trim()) {
					const parsedToolCall = this._parseJSONToolCallFromText(info.fullText);
					if (parsedToolCall) {
						// Found JSON tool call in text - convert to proper format
						const toolId = generateUuid();
						toolCall = {
							name: parsedToolCall.toolName,
							rawParams: parsedToolCall.toolParams,
							id: toolId,
							isDone: true,
							doneParams: Object.keys(parsedToolCall.toolParams)
						};
						// Remove the JSON from text since we're executing it as a tool call
						// Try to remove just the JSON part, keep any surrounding text
						const openBraceIdx = info.fullText.indexOf('{');
						if (openBraceIdx !== -1) {
							// Find matching closing brace
							let braceCount = 0;
							let closeBraceIdx = -1;
							for (let i = openBraceIdx; i < info.fullText.length; i++) {
								if (info.fullText[i] === '{') { braceCount++; }
								if (info.fullText[i] === '}') {
									braceCount--;
									if (braceCount === 0) {
										closeBraceIdx = i;
										break;
									}
								}
							}

							if (closeBraceIdx !== -1) {
								const beforeJson = info.fullText.substring(0, openBraceIdx).trim();
								const afterJson = info.fullText.substring(closeBraceIdx + 1).trim();
								info = {
									...info,
									fullText: [beforeJson, afterJson].filter(s => s.length > 0).join('\n\n').trim() || ''
								};
							}
						}
					}
				}

				// Deterministic end-of-turn: the model explicitly called `vibe_complete`. Stop the
				// run cleanly — no tool dispatch, no auto-continue nudge. A native tool call is an
				// UNAMBIGUOUS completion intent, so this replaces brittle "Готово"-text matching:
				// a thinking model can no longer get re-nudged into a loop after declaring done.
				// Placed after the JSON-in-text parse so both native and JSON-shaped calls are caught.
				if (chatMode === 'agent' && toolCall && (toolCall.name.toLowerCase() === 'vibe_complete' || TOOL_NAME_ALIASES[toolCall.name.toLowerCase()] === 'vibe_complete')) {
					const rp: unknown = toolCall.rawParams;
					const summary = (rp && typeof rp === 'object' && typeof (rp as { summary?: unknown }).summary === 'string')
						? String((rp as { summary?: unknown }).summary).trim()
						: '';
					const body = info.fullText.trim() || summary;
					this._addMessageToThread(threadId, {
						role: 'assistant',
						displayContent: body,
						reasoning: info.fullReasoning || '',
						anthropicReasoning: info.anthropicReasoning ?? null,
					});
					// Run-end via explicit completion: finalize the plan (status/lease/.plan.md) so an
					// executing plan doesn't stay stuck after the model declares done.
					this._finalizePlanIfComplete(threadId);
					this._setStreamState(threadId, { isRunning: undefined });
					return;
				}

				// Track if we synthesized a tool and added a message (to prevent duplicate messages)
				let toolSynthesizedAndMessageAdded = false;

				// Check if model supports tool calling before synthesizing tools
				// This prevents infinite loops when models don't support tools
				// CRITICAL: Only synthesize tools if:
				// 1. Model has specialToolFormat set (native tool calling support)
				// 2. We haven't already synthesized tools for this request (prevents loops)
				// 3. Model actually responded (not an error case)
				// 4. User opted in via `vibeide.chat.autoToolSynthesis` (default OFF — synthesis
				//    is a relic for weak tool-callers and tends to confuse modern models by
				//    replacing the real reply with hardcoded "I'll help…" text).
				const autoToolSynthesisEnabled = this._configurationService.getValue<boolean>('vibeide.chat.autoToolSynthesis') ?? false;
				let modelSupportsTools = false;
				if (autoToolSynthesisEnabled && modelSelection && modelSelection.providerName !== 'auto') {
					const { getModelCapabilities } = await import('../common/modelCapabilities.js');
					const capabilities = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);
					// Model supports tools if it has specialToolFormat set (native tool calling)
					// BUT: If we've already synthesized tools once and model didn't use them, don't try again
					// This prevents infinite loops when models have specialToolFormat set but don't actually support tools
					modelSupportsTools = !!capabilities.specialToolFormat && !hasSynthesizedForRequest;
				}

				// Check if we're in normal mode and user is trying to do something that requires tools
				if (chatMode === 'normal' && !toolCall && info.fullText.trim() && originalUserMessage) {
					const userRequest = originalUserMessage.displayContent?.toLowerCase() || '';
					const actionWords = ['add', 'create', 'edit', 'delete', 'remove', 'update', 'modify', 'change', 'make', 'write', 'build', 'implement', 'fix', 'run', 'execute'];
					const isActionRequest = actionWords.some(word => userRequest.includes(word));

					if (isActionRequest) {
						// User is trying to do something that requires tools, but we're in normal mode.
						// Preserve reasoning captured from the model stream so subsequent turns
						// don't break the thinking-mode contract (DeepSeek et al. require
						// reasoning_content roundtrip on every prior assistant turn).
						this._addMessageToThread(threadId, {
							role: 'assistant',
							displayContent: `I understand you want to ${originalUserMessage.displayContent}, but I'm currently in **Normal** mode which doesn't allow file operations.\n\nTo perform file edits, create files, or run commands, please switch to **Agent** mode using the dropdown in the chat interface.\n\n**Normal mode**: Chat only, no file operations\n**Explore mode**: Search and read the codebase with tools; can't edit files or run commands\n**Agent mode**: Full access to edit files, create files, and run commands`,
							reasoning: info.fullReasoning || '',
							anthropicReasoning: info.anthropicReasoning ?? null
						});
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
						await this._addUserCheckpoint({ threadId });
						return;
					}
				}

				// #6 (Design 2) — broken XML tool-call repair. The model emitted a tool tag the XML
				// parser couldn't extract (e.g. truncated <invoke> from deepseek): no toolCall, and
				// extractGrammar substituted the unclaimed-tag placeholder. Rather than stall the
				// agent, inject ONE corrective turn so the model re-emits a canonical tool call.
				// Once per request (anti-loop); opt-out via vibeide.llm.repairBrokenToolCalls.
				if (chatMode === 'agent' && !toolCall && !hasRepairedXmlThisRequest
					&& info.fullText.includes(unclaimedToolTagPlaceholder())
					&& this._configurationService.getValue<boolean>('vibeide.llm.repairBrokenToolCalls') !== false) {
					hasRepairedXmlThisRequest = true;
					// On-fire attribution: the repair adds a round-trip → latency. Tell the user once/session
					// so slowness is attributable to this debug-mode feature, not blamed on the app at large.
					if (!this._xmlRepairFiredNotified) {
						this._xmlRepairFiredNotified = true;
						this._notificationService.notify({
							severity: Severity.Info,
							message: localize('vibeide.llm.repairFired', 'VibeIDE переотправил модели запрос на исправление битого tool-call (доп. обращение — медленнее). Это режим отладки совместимости; отключить — настройка vibeide.llm.repairBrokenToolCalls.'),
						});
					}
					// Preserve the model's (malformed) turn, then add a corrective user turn so the next
					// iteration re-emits. Reasoning preserved for thinking-mode providers (same contract
					// as the synthesis paths below). Mirrors their addMessage + shouldSendAnotherMessage flow.
					this._addMessageToThread(threadId, {
						role: 'assistant',
						displayContent: info.fullText,
						reasoning: info.fullReasoning || '',
						anthropicReasoning: info.anthropicReasoning ?? null,
					});
					const corrective = '⚙️ Авто-исправление: твой предыдущий tool-call был в некорректном/обрезанном XML и не распознан. Переотправь РОВНО ОДИН валидный tool-call в каноническом формате. Если инструмент не нужен — ответь обычным текстом.';
					this._addMessageToThread(threadId, { role: 'user', content: corrective, displayContent: corrective, selections: null, isSyntheticNudge: true, state: defaultMessageState });
					shouldSendAnotherMessage = true;
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
					continue;
				}

				// Detect if Agent Mode should have used tools but didn't
				// Only synthesize ONCE per original request to prevent infinite loops
				// CRITICAL: Only synthesize tools if the model actually supports them
				if (chatMode === 'agent' && !toolCall && info.fullText.trim() && !hasSynthesizedForRequest && modelSupportsTools) {
					if (originalUserMessage) {
						const userRequest = originalUserMessage.displayContent?.toLowerCase() || '';
						const actionWords = ['add', 'create', 'edit', 'delete', 'remove', 'update', 'modify', 'change', 'make', 'write', 'build', 'implement', 'fix', 'run', 'execute', 'install', 'setup', 'configure',
							// Russian action verbs (substring match covers common inflections, e.g. "создай"/"создать")
							'созда', 'добав', 'удали', 'измени', 'обнови', 'перенес', 'замен', 'исправ', 'запусти', 'собери', 'напиши', 'написать', 'реализ', 'настрой', 'импортир', 'адаптир', 'сделай', 'построй'];
						const codebaseQueryWords = ['codebase', 'code base', 'repository', 'repo', 'project', 'endpoint', 'endpoints', 'api', 'route', 'routes', 'files', 'structure', 'architecture', 'what is', 'about',
							// Russian codebase nouns
							'кодовая база', 'репозитор', 'проект', 'структур', 'файл', 'эндпоинт', 'маршрут', 'архитектур'];
						const webQueryWords = ['search the web', 'search online', 'check the web', 'check the internet', 'check internet', 'look up', 'google', 'duckduckgo', 'browse url', 'fetch url', 'open url'];

						const isActionRequest = actionWords.some(word => userRequest.includes(word)) &&
							!userRequest.startsWith('explain') &&
							!userRequest.startsWith('what') &&
							!userRequest.startsWith('how') &&
							!userRequest.startsWith('why');

						// Also treat codebase queries as requiring tools (need to read files to answer accurately)
						// BUT: If images are present, "what" questions are likely about the image, not the codebase
						const hasImages = originalUserMessage.images && originalUserMessage.images.length > 0;
						const isCodebaseQuery = codebaseQueryWords.some(word => userRequest.includes(word)) &&
							(userRequest.includes('what') || userRequest.includes('how many') || userRequest.includes('about')) &&
							!(hasImages && (userRequest.includes('image') || userRequest.includes('this') || userRequest.includes('that')));

						// Treat web search queries as requiring tools (need to search the web to answer)
						const isWebQuery = webQueryWords.some(word => userRequest.includes(word)) ||
							(userRequest.includes('search for') && (userRequest.includes('on the web') || userRequest.includes('on the internet'))) ||
							(userRequest.includes('tell me what you know about') || userRequest.includes('what do you know about')) ||
							((userRequest.includes('what is') || userRequest.includes('who is') || userRequest.includes('when did')) &&
								(userRequest.includes('latest') || userRequest.includes('current') || userRequest.includes('recent') || userRequest.includes('2024') || userRequest.includes('2025')));

						const shouldUseTools = (isActionRequest || isCodebaseQuery || isWebQuery) &&
							!info.fullText.toLowerCase().includes('<read_file>') &&
							!info.fullText.toLowerCase().includes('<edit_file>') &&
							!info.fullText.toLowerCase().includes('<search_for_files>') &&
							!info.fullText.toLowerCase().includes('<create_file') &&
							!info.fullText.toLowerCase().includes('<run_command>') &&
							!info.fullText.toLowerCase().includes('<web_search>') &&
							!info.fullText.toLowerCase().includes('<browse_url>');

						// If model refused to use tools after first attempt, synthesize immediately
						// Skip the retry loop entirely for stubborn models
						// BUT: Don't synthesize file search tools if images are present (user likely wants image analysis, not file search)
						const isEmptyOrShort = !userRequest || userRequest.trim().length < 20;
						const isImageAnalysisQuery = hasImages && (
							isEmptyOrShort ||
							userRequest.toLowerCase().includes('image') ||
							userRequest.toLowerCase().includes('what') && (userRequest.toLowerCase().includes('about') || userRequest.toLowerCase().includes('show')) ||
							userRequest.toLowerCase().includes('describe') ||
							userRequest.toLowerCase().includes('analyze')
						);

						// Skip synthesis if user has images and is asking about them
						if (shouldUseTools && nAttempts >= 1 && !isImageAnalysisQuery) {
							const synthesizedToolCall = this._synthesizeToolCallFromIntent(userRequest, originalUserMessage.displayContent || '');
							// Also skip if synthesized call is search_for_files and images are present
							if (synthesizedToolCall && !(hasImages && synthesizedToolCall.toolName === 'search_for_files')) {
								const { toolName, toolParams } = synthesizedToolCall;
								const toolId = generateUuid();

								// Add assistant message explaining we're auto-executing
								let actionMessage = 'taking action';
								if (toolName === 'search_for_files') {
									actionMessage = 'finding relevant files';
								} else if (toolName === 'read_file') {
									actionMessage = 'reading the file';
								} else if (toolName === 'web_search') {
									actionMessage = 'searching the web';
								} else if (toolName === 'browse_url') {
									actionMessage = 'fetching the web page';
								}
								// Preserve reasoning captured from the model stream — thinking-mode
								// providers (DeepSeek via openCodeGo/zen, vLLM, liteLLM) reject
								// continuations when reasoning_content is absent on any prior turn.
								this._addMessageToThread(threadId, {
									role: 'assistant',
									displayContent: `I'll help you with that. Let me start by ${actionMessage}...`,
									reasoning: info.fullReasoning || '',
									anthropicReasoning: info.anthropicReasoning ?? null
								});
								toolSynthesizedAndMessageAdded = true;
								// Mark that we've synthesized tools for this request (prevents infinite loops)
								hasSynthesizedToolsInThisRequest = true;

								// CRITICAL: Check for pending plan before executing synthesized tool
								// Use fast check
								if (checkPlanGenerated()) {
									this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
									return;
								}

								// Execute the synthesized tool
								const mcpTools = this._mcpService.getMCPTools();
								const mcpTool = mcpTools?.find(t => t.name === toolName as ToolName);
								const { awaitingUserApproval, interrupted } = await this._runToolCall(
									threadId,
									toolName as ToolName,
									toolId,
									mcpTool?.mcpServerName,
									{ preapproved: false, unvalidatedToolParams: toolParams }
								);

								if (interrupted) {
									this._setStreamState(threadId, undefined);
									return;
								}
								if (awaitingUserApproval) {
									isRunningWhenEnd = 'awaiting_user';
								} else {
									shouldSendAnotherMessage = true;
								}

								this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
								// Skip adding the failed assistant message and break out of retry loop
								// Tool result is already in thread via _runToolCall, so we'll send another message
								break; // Exit inner retry loop, continue outer loop with tool results
							}
						}
					}
				}

				// Add assistant message (only if not already added during streaming or tool synthesis)
				// Check if message was already added to avoid duplication
				// Skip if we synthesized a tool and added a message (to prevent duplicate responses)
				if (!toolSynthesizedAndMessageAdded) {
					const thread = this.state.allThreads[threadId];
					const lastMessage = thread?.messages[thread.messages.length - 1];
					const messageAlreadyAdded = lastMessage?.role === 'assistant' &&
						lastMessage.displayContent === info.fullText;

					if (!messageAlreadyAdded) {
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning });
					}
				}

				// PERFORMANCE: Clear stream state immediately to stop showing "running" status
				// This prevents the UI from continuing to show streaming state after completion
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });

				// Premature-stop handling (agent mode, model returned text with NO tool call).
				// Weak tool-callers (deepseek/minimax via openCodeGo) sometimes narrate a turn as
				// plain text instead of emitting the next tool call, which would silently end the
				// run mid-task. Behaviour splits on Autopilot:
				//   - Autopilot ON  → inject ONE corrective "continue" turn (capped, anti-loop).
				//   - Autopilot OFF → stop, but explain why + surface a one-click «Продолжить».
				// The model's real reply is already saved above; we only add a nudge/notice on top.
				// Skipped when a synthesis path already handled this turn (those own their own flow).
				// COMPLETELY EMPTY turns (no text AND no tool call — Zen degradation artifact,
				// observed on sonnet mid-task) take the same path: previously they fell through
				// and the run died SILENTLY with no notice and no «Продолжить» affordance.
				if (chatMode === 'agent' && !toolCall
					&& !hasSynthesizedToolsInThisRequest && !toolSynthesizedAndMessageAdded) {
					const autopilotOn = this._settingsService.state.globalSettings.chatAgentAutopilot === true;
					const rawMaxNudges = this._configurationService.getValue<unknown>('vibeide.agent.autoContinueMaxNudges');
					const maxNudges = (typeof rawMaxNudges === 'number' && Number.isFinite(rawMaxNudges) && rawMaxNudges >= 0) ? Math.floor(rawMaxNudges) : 2;

					// A turn that ENDS with a question («Приступать к реализации?») is a permission-seeking
					// stall: under Autopilot nobody answers, so it is ALWAYS nudged — independent of the
					// regular nudge budget (works even at maxNudges=0). Bounded by its own CONSECUTIVE
					// counter from `vibeide.agent.autoContinueOnQuestion` (toolbar «подпин?», default 3,
					// 0 = unlimited), reset on every executed tool call like the regular nudge counter.
					const rawQuestionNudges = this._configurationService.getValue<unknown>('vibeide.agent.autoContinueOnQuestion');
					const maxQuestionNudges = (typeof rawQuestionNudges === 'number' && Number.isFinite(rawQuestionNudges) && rawQuestionNudges >= 0) ? Math.floor(rawQuestionNudges) : QUESTION_AUTO_CONTINUE_DEFAULT;
					const askedQuestion = endsWithQuestion(info.fullText);
					const withinNudgeBudget = maxNudges > 0 && autoContinueOnTextCount < maxNudges;
					const questionOverride = askedQuestion && (maxQuestionNudges === 0 || questionNudgeCount < maxQuestionNudges);

					// Early clean completion: once the model has had at least ONE forced-tool nudge
					// (`tool_choice=required` — its explicit chance to emit `vibe_complete`) and STILL ends a
					// NON-question turn with terminal completion prose («Готово», «Задача выполнена», …),
					// accept it as an implicit vibe_complete now instead of spending the rest of the nudge
					// budget. The extra «продолжай!» nudges only push an already-done model to invent
					// busywork. Questions never match here — they keep their own nudge path below.
					if (autopilotOn
						&& !askedQuestion
						&& autoContinueOnTextCount >= 1
						&& this._configurationService.getValue<boolean>('vibeide.agent.implicitCompleteAfterFirstNudge') !== false
						&& looksLikeCompletionText(info.fullText)) {
						vibeLog.warn('chatThread', `[autopilot] early implicit vibe_complete: terminal completion prose after ${autoContinueOnTextCount} forced nudge(s) — ending cleanly instead of nudging the full budget.`);
						this._finalizePlanIfComplete(threadId);
						this._setStreamState(threadId, { isRunning: undefined });
						return;
					}

					if (autopilotOn && (withinNudgeBudget || questionOverride)) {
						autoContinueOnTextCount += 1;
						if (askedQuestion) { questionNudgeCount += 1; }
						// Weak XML-mode callers can't be forced via tool_choice (no native tools are sent)
						// and don't map "вызови vibe_complete" to an emission — so when THIS turn ran in XML
						// tool mode, spell out the exact tags to output. See docs/knowledge/chat-ux/chat-interrupt-and-inject.md.
						let xmlCompleteHint = '';
						try {
							if (modelSelection && modelSelection.providerName !== 'auto') {
								const { getModelCapabilities } = await import('../common/modelCapabilities.js');
								const caps = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);
								if (!caps.specialToolFormat) {
									xmlCompleteHint = '\n\nТы в XML-режиме инструментов: чтобы ЗАВЕРШИТЬ ход, выведи РОВНО это и больше ничего —\n<vibe_complete>\n<summary>что сделано, 1–3 предложения</summary>\n</vibe_complete>';
								}
							}
						} catch { /* capabilities unavailable → plain nudge */ }
						let corrective = askedQuestion
							? '⚙️ Авто-продолжение (автопилот): ты завершил ход вопросом, но автопилот включён — пользователь в этом режиме не отвечает. Прими решение самостоятельно (выбери разумный вариант по умолчанию, зафиксируй его одной строкой) и продолжай работу инструментами. Не жди подтверждения.'
							: info.fullText.trim().length === 0
								? '⚙️ Авто-продолжение (автопилот): твой предыдущий ход пришёл ПУСТЫМ (ни текста, ни вызова инструмента) — вероятно, сбой доставки ответа. Продолжай выполнение задачи с того места, где остановился: вызови следующий нужный инструмент или дай финальный ответ.'
								: '⚙️ Авто-продолжение (автопилот): ты завершил ход текстом без вызова инструмента. Если задача НЕ закончена — продолжай, вызвав нужный инструмент. Если задача ПОЛНОСТЬЮ выполнена — вызови инструмент `vibe_complete` (но сначала перепроверь, что всё действительно сделано: правки применены, сборка/тесты проходят, шагов не осталось). Не пиши «Готово» просто текстом — это завершит ход только через `vibe_complete`. Если не хватает данных — прими разумное решение сам и продолжай.';
						// Text-only completion case only (not the question / empty-turn variants) gets the XML hint.
						if (!askedQuestion && info.fullText.trim().length !== 0) { corrective += xmlCompleteHint; }
						this._addMessageToThread(threadId, { role: 'user', content: corrective, displayContent: corrective, selections: null, isSyntheticNudge: true, state: defaultMessageState });
						shouldSendAnotherMessage = true;
						// Force the follow-up turn to emit a tool call (vibe_complete or a real tool) so a
						// weak caller can't return prose AGAIN. No-op in XML mode (no native tools sent).
						forceToolUseNextTurn = this._configurationService.getValue<boolean>('vibeide.agent.forceToolUseOnNudge') !== false;
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
						continue;
					}

					// Autopilot ON but nudge budget spent: if the model is plainly DECLARING completion in
					// prose (weak tool-caller that just won't emit the vibe_complete call), accept it as an
					// implicit completion instead of stranding the unattended autopilot at «Продолжить».
					// Narrow scope (autopilot + exhausted budget + terminal completion text) so this does
					// NOT resurrect the always-on «Готово»-match that vibe_complete replaced — a mid-task
					// narration would have been nudged to continue and the model would have acted.
					if (autopilotOn
						&& this._configurationService.getValue<boolean>('vibeide.agent.implicitCompleteOnExhaustedNudge') !== false
						&& looksLikeCompletionText(info.fullText)) {
						vibeLog.warn('chatThread', `[autopilot] implicit vibe_complete: model declared completion in prose after ${autoContinueOnTextCount} exhausted nudge(s) — ending run cleanly instead of «Продолжить».`);
						// Same as the explicit vibe_complete path: finalize an executing plan on this exit.
						this._finalizePlanIfComplete(threadId);
						this._setStreamState(threadId, { isRunning: undefined });
						return;
					}

					// Autopilot OFF, or the auto-continue budget is spent → stop with an explanation
					// + a one-click resume affordance (rendered by SidebarChat on the last message).
					this._addMessageToThread(threadId, {
						role: 'assistant',
						displayContent: localize('vibeide.agent.stoppedNoToolCall', 'Прогон завершён: модель закончила ход текстом без вызова инструмента. Если задача не доделана — нажмите «Продолжить» или напишите следующий шаг.'),
						reasoning: '',
						anthropicReasoning: null,
						agentStoppedNoToolCall: true,
					});
					this._setStreamState(threadId, { isRunning: undefined });
					return;
				}

				// CRITICAL: Check if model responded with text but no tool call after executing tools
				// This can happen when model explores codebase but doesn't continue to answer the question
				// For "how many endpoints" type questions, we need to ensure model searches for endpoints
				// Gated by `vibeide.chat.autoToolSynthesis` (default OFF) — same reasoning as the
				// agent-tool-synth branch above. The model's real reply is preserved on the canonical
				// save path (above this block) when synthesis is disabled.
				if (autoToolSynthesisEnabled && !toolCall && info.fullText.trim() && toolsExecutedInRequest.length > 0 && originalUserMessage) {
					const userRequest = originalUserMessage.displayContent?.toLowerCase() || '';

					// Check if this is a "how many" question that requires searching files
					// Expanded pattern matching for better detection
					const isHowManyQuestion = userRequest.includes('how many') && (
						userRequest.includes('endpoint') || userRequest.includes('api') || userRequest.includes('route') ||
						userRequest.includes('file') || userRequest.includes('function') || userRequest.includes('class') ||
						userRequest.includes('method') || userRequest.includes('component') || userRequest.includes('module') ||
						userRequest.includes('service') || userRequest.includes('controller') || userRequest.includes('handler')
					);

					// Check if we've searched or read files (needed to determine if more search is needed)
					const hasSearched = toolsExecutedInRequest.includes('search_for_files') || toolsExecutedInRequest.includes('search_pathnames_only');
					const hasRead = toolsExecutedInRequest.includes('read_file');

					// Check if model's response actually contains an answer (has numbers or count indicators)
					const responseText = info.fullText.toLowerCase();
					const hasCountInResponse = /\d+/.test(responseText) && (
						responseText.includes('endpoint') || responseText.includes('api') || responseText.includes('route') ||
						responseText.includes('file') || responseText.includes('function') || responseText.includes('class') ||
						responseText.includes('there are') || responseText.includes('i found') || responseText.includes('total')
					);

					// If it's a "how many" question and we haven't searched/read, and response doesn't contain answer, synthesize search
					const needsMoreSearch = isHowManyQuestion && !hasSearched && !hasRead && !hasCountInResponse && !hasSynthesizedForRequest;

					if (needsMoreSearch) {
						const synthesizedToolCall = this._synthesizeToolCallFromIntent(userRequest, originalUserMessage.displayContent || '');
						if (synthesizedToolCall && synthesizedToolCall.toolName === 'search_for_files') {
							const { toolName, toolParams } = synthesizedToolCall;
							const toolId = generateUuid();

							// Add assistant message explaining we're continuing the search.
							// Preserve reasoning captured from the model stream — thinking-mode
							// providers (DeepSeek via openCodeGo/zen, vLLM, liteLLM) reject
							// continuations when reasoning_content is absent on any prior turn.
							this._addMessageToThread(threadId, {
								role: 'assistant',
								displayContent: `I'll search for files to answer your question.`,
								reasoning: info.fullReasoning || '',
								anthropicReasoning: info.anthropicReasoning ?? null
							});

							// Execute the synthesized tool
							const mcpTools = this._mcpService.getMCPTools();
							const mcpTool = mcpTools?.find(t => t.name === toolName as ToolName);
							const { awaitingUserApproval, interrupted } = await this._runToolCall(
								threadId,
								toolName as ToolName,
								toolId,
								mcpTool?.mcpServerName,
								{ preapproved: false, unvalidatedToolParams: toolParams }
							);

							if (interrupted) {
								this._setStreamState(threadId, undefined);
								return;
							}

							(toolsExecutedInRequest as string[]).push(toolName);
							hasSynthesizedToolsInThisRequest = true;

							if (awaitingUserApproval) {
								isRunningWhenEnd = 'awaiting_user';
							} else {
								shouldSendAnotherMessage = true;
							}

							this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
							continue; // Continue loop with the new tool result
						}
					}
				}

				// CRITICAL: Only stop loop if tools were synthesized AND model explicitly indicates task is complete
				// Don't stop just because tools were synthesized - model might need another iteration
				// Only stop if model's response clearly indicates completion AND no more tools needed
				if (hasSynthesizedToolsInThisRequest && !toolCall && info.fullText.trim()) {
					// Check if model's response indicates the task is actually complete
					const responseText = info.fullText.toLowerCase();
					const indicatesCompletion =
						responseText.includes('i cannot') ||
						responseText.includes('i don\'t have') ||
						responseText.includes('i\'m unable') ||
						responseText.includes('i need more information') ||
						responseText.includes('please provide') ||
						// If we've executed multiple tools and model gives a clear answer, it's likely complete
						(toolsExecutedInRequest.length >= 3 && (
							responseText.includes('here') ||
							responseText.includes('found') ||
							responseText.includes('result') ||
							responseText.includes('answer')
						));

					// Only stop if model explicitly indicates completion or we've done substantial work
					// Don't stop if model just responded with text after first tool synthesis
					if (indicatesCompletion || (toolsExecutedInRequest.length >= 3 && !originalUserMessage?.displayContent?.toLowerCase().includes('how many'))) {
						// Model has given its final answer - stop here
						this._setStreamState(threadId, { isRunning: undefined });
						return;
					}
					// Otherwise, continue loop to give model another chance to use tools or complete the task
				}

				// call tool if there is one
				if (toolCall) {
					// CRITICAL: Check for pending plan before executing tool (fast check)
					if (checkPlanGenerated()) {
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
						return;
					}

					if (activePlanTracking?.currentStep && !this._toolMatchesPersistedPlanHints(toolCall.name, activePlanTracking.currentStep.step)) {
						if (this._pauseRunningPlanStepForToolDrift(threadId, toolCall.name)) {
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
							return;
						}
					}

					const mcpTools = this._mcpService.getMCPTools();
					const mcpTool = mcpTools?.find(t => t.name === toolCall.name);
					const mcpSrvLoop = this._resolveMcpServerForPlanTool(toolCall.name, mcpTool?.mcpServerName);
					if (activePlanTracking?.currentStep && !this._mcpCallMatchesPlanAllowlist(activePlanTracking.currentStep.step, toolCall.name, mcpSrvLoop)) {
						if (this._pauseRunningPlanStepForMcpAllowlist(threadId, toolCall.name, mcpSrvLoop)) {
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
							return;
						}
					}

					// Anti-loop guard — short-circuit a tool call repeated VERBATIM past the
					// threshold within this request. The deterministic re-read loop (model
					// re-issuing the same read_file/run_command because truncation erased the
					// prior result) is broken here even if context never recovered: instead of
					// re-running, we hand the model a tool result telling it the call is a
					// no-op and to use the result it already has or move on.
					if (antiLoopThreshold > 0) {
						// Per-tool threshold (roadmap G extension): strict for run_command/run_nl_command
						// (verbatim repeat == loop), lenient for read_file/edit_file (legit re-read/retry).
						const effectiveThreshold = resolveAntiLoopThreshold(toolCall.name, antiLoopThreshold);
						const toolSig = toolCallSignature(toolCall.name, toolCall.rawParams);
						const priorSameCount = recentToolSignatures.reduce((n, s) => s === toolSig ? n + 1 : n, 0);
						recentToolSignatures.push(toolSig);
						if (recentToolSignatures.length > ANTI_LOOP_SIGNATURE_RING) { recentToolSignatures.shift(); }
						if (priorSameCount >= effectiveThreshold) {
							antiLoopBlocks += 1;
							consecutiveSameSigBlocks = (toolSig === lastBlockedToolSig) ? consecutiveSameSigBlocks + 1 : 1;
							lastBlockedToolSig = toolSig;
							this._metricsService.capture('Anti-Loop Guard Tripped', {
								toolName: toolCall.name,
								repeats: priorSameCount,
								totalBlocks: antiLoopBlocks,
								consecutiveSameSigBlocks,
								threshold: antiLoopThreshold,
								effectiveThreshold,
								chatMode,
							});

							// Hard-abort ONLY on the TOTAL-blocks ceiling — the model ignored many nudges across
							// the whole request. Verbatim replay (consecutiveSameSigBlocks) no longer hard-stops:
							// instead we ESCALATE the nudge below and KEEP GOING, because models routinely break
							// the loop after a stronger directive — the same recovery a manual «Continue» produces
							// (observed: the model switched to different arguments immediately after continuing).
							if (antiLoopBlocks > antiLoopMaxBlocks) {
								const abortMsg = localize('vibeide.antiLoop.aborted', 'Прогон агента остановлен: модель повторяла один и тот же tool-call (`{0}` и др.), игнорируя результаты — {1} заблокированных повторов. Обычно это значит, что задача сформулирована неоднозначно или модель застряла. Переформулируйте запрос, сузьте область или переключите модель.', toolCall.name, String(antiLoopBlocks));
								this._notificationService.warn(abortMsg);
								this._addMessageToThread(threadId, {
									role: 'tool',
									type: 'tool_error',
									params: {},
									rawParams: {},
									result: abortMsg,
									name: toolCall.name,
									content: abortMsg,
									id: toolCall.id,
									mcpServerName: undefined,
								});
								this._agentActivityLog.logError(`Anti-loop: aborting loop after ${antiLoopBlocks} blocked repetitions`);
								this._setStreamState(threadId, { isRunning: undefined });
								return;
							}

							// After several verbatim replays in a row the gentle hint clearly isn't landing —
							// escalate to a hard directive (mid-turn equivalent of a manual «Continue» nudge)
							// instead of aborting the whole run.
							const escalate = consecutiveSameSigBlocks >= antiLoopMaxConsecutiveSameBlocks;
							const hint = escalate
								? `STOP — you have called \`${toolCall.name}\` with these EXACT arguments ${priorSameCount} times in a row and it is now blocked: it will NOT execute again and the result will NOT change. Do NOT repeat it. Pick ONE now: (a) use the result you already have, (b) call a DIFFERENT tool — or the same tool with MEANINGFULLY different arguments, or (c) give your final answer. Repeating this identical call only wastes the turn.`
								: `Anti-loop guard: you have already called \`${toolCall.name}\` with these exact arguments ${priorSameCount} time(s) in this turn, so this call was NOT executed again — the result will not change. Use the result you already obtained, or move on to the next step / give your final answer. If you actually meant a DIFFERENT target (another folder, file, command or query), change the arguments to match it instead of repeating these. Do not repeat this call.`;
							this._addMessageToThread(threadId, {
								role: 'tool',
								type: 'tool_error',
								params: {},
								rawParams: {},
								result: hint,
								name: toolCall.name,
								content: hint,
								id: toolCall.id,
								mcpServerName: undefined,
							});
							this._agentActivityLog.logError(`Anti-loop: blocked repeated ${toolCall.name} (×${priorSameCount} identical args)`);
							shouldSendAnotherMessage = true;
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
							continue;
						}
						// Call passed the guard → the model changed its arguments or tool: progress.
						// Break the same-signature streak so only UNINTERRUPTED replays escalate.
						consecutiveSameSigBlocks = 0;
						lastBlockedToolSig = undefined;
					}

					// PERFORMANCE: Use cached step from activePlanTracking, don't lookup every time
					if (activePlanTracking?.currentStep) {
						this._linkToolCallToStepInternal(threadId, toolCall.id, activePlanTracking.currentStep);
					}

					const { awaitingUserApproval, interrupted } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams });

					// Tool-call resilience post-dispatch logic (roadmap O.1–O.7):
					//   - Increment per-(provider×model) counter on tool_error/invalid_params,
					//     reset on success.
					//   - On AUTO_DOWNGRADE_THRESHOLD: classify reason, write `_autoDetected`
					//     override switching the model to XML-fallback mode, notify user, reset
					//     counter so the XML path gets a fair shot. Fires once per model per
					//     session (downgradedModelsThisSession set).
					//   - On MAX_CONSECUTIVE_TOOL_ERRORS: abort agent loop with hard message —
					//     last-resort safety net if even XML-fallback can't recover.
					{
						const modelKey = `${resolvedModelSelection.providerName}:${resolvedModelSelection.modelName}`;
						const thread = this.state.allThreads[threadId];
						const lastMsg = thread?.messages[thread.messages.length - 1];
						let curCount = consecutiveToolErrorsByModel.get(modelKey) ?? 0;
						if (lastMsg?.role === 'tool') {
							if (lastMsg.type === 'tool_error' || lastMsg.type === 'invalid_params') {
								curCount += 1;
								consecutiveToolErrorsByModel.set(modelKey, curCount);
							} else if (lastMsg.type === 'success') {
								curCount = 0;
								consecutiveToolErrorsByModel.set(modelKey, 0);
							}
						}

						// O.9 — Re-probe outcome handling.
						// Two flows:
						//   (a) This iteration WAS a probe (probeActiveThisCall === modelKey):
						//       outcome determines whether to clear the persistent override.
						//       Success → clear override (model recovered native FC).
						//       Error → keep override, reset success counter (start fresh).
						//   (b) Normal downgraded-mode run + tool succeeded: increment success
						//       counter; at RE_PROBE_AFTER_SUCCESSES, queue probe for next iter.
						if (probeActiveThisCall === modelKey && lastMsg?.role === 'tool') {
							if (lastMsg.type === 'success') {
								try {
									const providerForOverride = resolvedModelSelection.providerName as Exclude<typeof resolvedModelSelection.providerName, 'auto'>;
									await this._settingsService.setOverridesOfModel(providerForOverride, resolvedModelSelection.modelName, undefined);
									downgradedModelsThisSession.delete(modelKey);
									successCountForDowngradedModel.delete(modelKey);
									probeActiveThisCall = undefined;
									this._notificationService.info(
										`Модель ${resolvedModelSelection.modelName} (${resolvedModelSelection.providerName}) успешно прошла re-probe на native function-calling. Auto-detected override снят, модель возвращена в native режим.`
									);
									this._agentActivityLog.logFinished(`Re-probe success: ${modelKey} → native restored`);
								} catch (e) {
									this._agentActivityLog.logError(`Re-probe override-clear failed for ${modelKey}: ${getErrorMessage(e)}`);
									probeActiveThisCall = undefined;
								}
							} else if (lastMsg.type === 'tool_error' || lastMsg.type === 'invalid_params') {
								successCountForDowngradedModel.set(modelKey, 0);
								probeActiveThisCall = undefined;
								this._agentActivityLog.logError(`Re-probe failed: ${modelKey} → keeping XML override`);
							}
						} else if (
							lastMsg?.role === 'tool'
							&& lastMsg.type === 'success'
							&& downgradedModelsThisSession.has(modelKey)
						) {
							// Normal downgraded-mode success — count toward next re-probe.
							const successCur = (successCountForDowngradedModel.get(modelKey) ?? 0) + 1;
							if (successCur >= RE_PROBE_AFTER_SUCCESSES) {
								probeRequestedForModel.add(modelKey);
								successCountForDowngradedModel.set(modelKey, 0);
								this._agentActivityLog.logStarted(`Re-probe queued: ${modelKey} reached ${RE_PROBE_AFTER_SUCCESSES} successes on XML; next iteration will retry native FC`);
							} else {
								successCountForDowngradedModel.set(modelKey, successCur);
							}
						}

						// Stage 1: auto-downgrade trigger (skipped entirely when threshold is 0 — native-only mode)
						if (
							autoDowngradeThreshold > 0
							&& curCount >= autoDowngradeThreshold
							&& !downgradedModelsThisSession.has(modelKey)
							&& lastMsg?.role === 'tool'
							&& (lastMsg.type === 'tool_error' || lastMsg.type === 'invalid_params')
							// Only downgrade for the numeric-tool-name quirk — the one failure mode XML naming
							// genuinely fixes. Other reasons are transient/self-correcting on native FC (opencode
							// just retries through them); shoving capable models like deepseek-v4-pro into XML for
							// those was the root cause of "agent stops at every step" (model-stalls #008).
							&& classifyToolErrorReason(String(lastMsg.name), String(lastMsg.content ?? '')) === 'numeric-tool-name'
						) {
							const reason = classifyToolErrorReason(String(lastMsg.name), String(lastMsg.content ?? ''));
							const reasonHuman = (() => {
								switch (reason) {
									case 'numeric-tool-name': return 'эмитит численные имена тулов (например "0", "1", "5") — типичный quirk минимакс/qwen-моделей через aggregator';
									case 'missing-required-field': return 'не передаёт обязательные параметры тула';
									case 'wrong-tool-name': return 'эмитит несуществующие имена тулов';
									case 'other': return 'повторно ломается на tool-call';
								}
							})();
							try {
								// providerName is narrowed at resolve time (line ~3505), but
								// the type still admits 'auto'. Cast away because we know we're
								// past the resolveAutoModelSelection step.
								const providerForOverride = resolvedModelSelection.providerName as Exclude<typeof resolvedModelSelection.providerName, 'auto'>;
								await this._settingsService.setOverridesOfModel(
									providerForOverride,
									resolvedModelSelection.modelName,
									{
										// null, NOT undefined: undefined keys are dropped by JSON/IPC
										// serialization, so the override never reached the main process
										// (getModelCapabilities normalizes null→undefined on read).
										specialToolFormat: null,
										_autoDetected: true,
										_detectedAt: Date.now(),
										_reason: reason,
									}
								);
								downgradedModelsThisSession.add(modelKey);
								consecutiveToolErrorsByModel.set(modelKey, 0);
								this._notificationService.warn(
									`Модель ${resolvedModelSelection.modelName} (${resolvedModelSelection.providerName}) ${reasonHuman}. Переключили её на XML-формат тулов (медленнее, но совместимее). Откат: Settings → Models → Overrides → этот провайдер/модель → сбросить specialToolFormat.`
								);
								this._agentActivityLog.logFinished(`Auto-downgrade: ${modelKey} → XML (${reason})`);
								// Don't return — continue loop. Next LLM call picks up the override
								// via getModelCapabilities and routes through XML-fallback path.
							} catch (e) {
								// Setting write failed (rare). Fall through to circuit-breaker if
								// errors keep coming; don't mark this model as downgraded so a
								// later attempt may try again.
								this._agentActivityLog.logError(`Auto-downgrade write failed for ${modelKey}: ${getErrorMessage(e)}`);
							}
						}

						// Stage 2: circuit-breaker (last resort)
						if (curCount >= maxConsecutiveToolErrors) {
							const abortMsg = `Agent loop aborted: ${maxConsecutiveToolErrors} consecutive tool failures on ${resolvedModelSelection.modelName} (${resolvedModelSelection.providerName}). Even after auto-downgrade to XML-fallback the model couldn't recover. Switch to a different model (Claude, GPT, Gemini, DeepSeek) or simplify the request.`;
							this._notificationService.warn(abortMsg);
							this._addMessageToThread(threadId, {
								role: 'tool',
								type: 'tool_error',
								params: {},
								rawParams: {},
								result: abortMsg,
								name: 'invalid' as ToolName,
								content: abortMsg,
								id: generateUuid(),
								mcpServerName: undefined,
							});
							this._setStreamState(threadId, { isRunning: undefined });
							return;
						}
					}

					if (interrupted) {
						this._setStreamState(threadId, undefined);
						if (activePlanTracking?.currentStep) {
							// PERFORMANCE: Use returned step info instead of re-looking up
							const updatedStep = this._markStepCompletedInternal(threadId, activePlanTracking.currentStep, false, 'Interrupted by user');
							if (updatedStep) {
								activePlanTracking.currentStep = updatedStep;
								activePlanTracking.planInfo = { plan: updatedStep.plan, planIdx: updatedStep.planIdx };
							} else {
								refreshPlanStep();
							}
						}
						return;
					}

					// Track that this tool was executed (even if it failed - we still tried)
					// Tool errors are handled by _runToolCall which adds error messages to the thread
					// The loop will continue so the model can process the error
					toolsExecutedInRequest.push(toolCall.name);
					// Real progress — reset the premature-stop nudge budgets so only CONSECUTIVE
					// text-only / question-only turns (no tool call between them) are auto-continued.
					autoContinueOnTextCount = 0;
					questionNudgeCount = 0;

					// Only update plan step status if we have an active plan (skip if no plan)
					if (activePlanTracking?.currentStep) {
						const thread = this.state.allThreads[threadId];
						if (thread) {
							const lastMsg = thread.messages[thread.messages.length - 1];
							if (lastMsg && lastMsg.role === 'tool') {
								const toolMsg = lastMsg as ToolMessage<ToolName>;
								if (toolMsg.type === 'tool_error') {
									// PERFORMANCE: Use returned step info instead of re-looking up
									const updatedStep = this._markStepCompletedInternal(threadId, activePlanTracking.currentStep, false, toolMsg.result || 'Tool execution failed');
									if (updatedStep) {
										activePlanTracking.currentStep = updatedStep;
									} else {
										refreshPlanStep();
									}
								} else if (toolMsg.type === 'success') {
									// PERFORMANCE: Use returned step info instead of re-looking up
									const updatedStep = this._markStepCompletedInternal(threadId, activePlanTracking.currentStep, true);
									if (updatedStep) {
										activePlanTracking.currentStep = updatedStep;
										// Update planInfo to match updated plan
										activePlanTracking.planInfo = { plan: updatedStep.plan, planIdx: updatedStep.planIdx };

										// Start next step if available - use returned value
										const startedStep = await this._startNextStep(threadId);
										if (startedStep) {
											activePlanTracking.planInfo = { plan: startedStep.plan, planIdx: startedStep.planIdx };
											activePlanTracking.currentStep = {
												plan: startedStep.plan,
												planIdx: startedStep.planIdx,
												step: startedStep.step,
												stepIdx: startedStep.stepIdx
											};
										} else {
											// No more steps - refresh to get final state
											refreshPlanStep();
										}
									} else {
										// Fallback if update failed
										refreshPlanStep();
										if (activePlanTracking.currentStep && activePlanTracking.currentStep.step.status === 'queued') {
											const startedStep = await this._startNextStep(threadId);
											if (startedStep) {
												activePlanTracking.planInfo = { plan: startedStep.plan, planIdx: startedStep.planIdx };
												activePlanTracking.currentStep = {
													plan: startedStep.plan,
													planIdx: startedStep.planIdx,
													step: startedStep.step,
													stepIdx: startedStep.stepIdx
												};
											} else {
												refreshPlanStep();
											}
										}
									}
								}
							}
						}
					}

					if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user'; }
					else { shouldSendAnotherMessage = true; }

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }); // just decorative, for clarity
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		// Use undefined instead of 'idle' to properly clear the state and hide the stop button
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd || undefined });

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) {
			// Finalize an executing+complete plan on the natural loop exit. Extracted into a helper
			// so the `vibe_complete` and implicit-completion early-exits finalize IDENTICALLY (they
			// used to skip this block, leaving the plan + lease + .plan.md stuck). Self-guards: no-op
			// when there is no executing+complete plan, so the old `activePlanTracking` gate is moot.
			this._finalizePlanIfComplete(threadId);
			await this._addUserCheckpoint({ threadId });
		}

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode });
	}


	// Checkpoint storage limits
	private static readonly MAX_CHECKPOINTS_PER_THREAD = 50;
	private static readonly MAX_TOTAL_CHECKPOINT_SIZE_MB = 100;
	private static readonly BYTES_PER_MB = 1024 * 1024;

	private async _addCheckpoint(threadId: string, checkpoint: CheckpointEntry, holderLabel: string): Promise<void> {
		await this._checkpointCoordinator.runExclusive(
			{ op: 'chatThreadCheckpoint', holderLabel },
			async () => {
				this._addCheckpointSync(threadId, checkpoint);
			},
		);
	}

	private _addCheckpointSync(threadId: string, checkpoint: CheckpointEntry) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		// Count existing checkpoints in this thread
		const existingCheckpoints = thread.messages.filter(m => m.role === 'checkpoint');

		// Estimate checkpoint size (rough approximation)
		const checkpointSize = this._estimateCheckpointSize(checkpoint);
		const totalSizeMB = this._getTotalCheckpointSizeMB();

		// Enforce per-thread limit
		if (existingCheckpoints.length >= ChatThreadService.MAX_CHECKPOINTS_PER_THREAD) {
			// Evict oldest checkpoint in this thread (LRU)
			const oldestCheckpointIdx = thread.messages.findIndex(m => m.role === 'checkpoint');
			if (oldestCheckpointIdx >= 0) {
				// Remove oldest checkpoint
				const newMessages = [...thread.messages];
				newMessages.splice(oldestCheckpointIdx, 1);
				this._setState({
					allThreads: {
						...this.state.allThreads,
						[threadId]: {
							...thread,
							messages: newMessages,
						},
					},
				});
				this._storeAllThreads(this.state.allThreads);
			}
		}

		// Enforce global size limit
		if (totalSizeMB + checkpointSize / ChatThreadService.BYTES_PER_MB > ChatThreadService.MAX_TOTAL_CHECKPOINT_SIZE_MB) {
			// Evict oldest checkpoints across all threads (LRU)
			this._evictOldestCheckpoints(checkpointSize / ChatThreadService.BYTES_PER_MB);
		}

		this._addMessageToThread(threadId, checkpoint);
	}

	private _estimateCheckpointSize(checkpoint: CheckpointEntry): number {
		// Rough size estimation: JSON string length
		try {
			return JSON.stringify(checkpoint).length;
		} catch {
			return 1000; // Fallback estimate
		}
	}

	private _getTotalCheckpointSizeMB(): number {
		let totalBytes = 0;
		for (const thread of Object.values(this.state.allThreads)) {
			if (!thread) { continue; }
			for (const msg of thread.messages) {
				if (msg.role === 'checkpoint') {
					totalBytes += this._estimateCheckpointSize(msg as CheckpointEntry);
				}
			}
		}
		return totalBytes / ChatThreadService.BYTES_PER_MB;
	}

	private _evictOldestCheckpoints(neededMB: number): void {
		// Collect all checkpoints with their thread and index
		const checkpointList: Array<{ threadId: string; index: number; checkpoint: CheckpointEntry; size: number }> = [];

		for (const [threadId, thread] of Object.entries(this.state.allThreads)) {
			if (!thread) { continue; }
			for (let i = 0; i < thread.messages.length; i++) {
				const msg = thread.messages[i];
				if (msg.role === 'checkpoint') {
					const checkpoint = msg as CheckpointEntry;
					checkpointList.push({
						threadId,
						index: i,
						checkpoint,
						size: this._estimateCheckpointSize(checkpoint),
					});
				}
			}
		}

		// Sort by index (older = lower index, earlier in thread)
		checkpointList.sort((a, b) => a.index - b.index);

		// Evict oldest until we have enough space
		let freedMB = 0;
		const toEvict = new Map<string, Set<number>>(); // threadId -> Set<indices>

		for (const item of checkpointList) {
			if (freedMB >= neededMB) { break; }

			if (!toEvict.has(item.threadId)) {
				toEvict.set(item.threadId, new Set());
			}
			toEvict.get(item.threadId)!.add(item.index);
			freedMB += item.size / ChatThreadService.BYTES_PER_MB;
		}

		// Remove evicted checkpoints
		const newThreads = { ...this.state.allThreads };
		for (const [threadId, indices] of toEvict.entries()) {
			const thread = newThreads[threadId];
			if (!thread) { continue; }

			// Remove in reverse order to preserve indices
			const sortedIndices = Array.from(indices).sort((a, b) => b - a);
			const newMessages = [...thread.messages];
			for (const idx of sortedIndices) {
				newMessages.splice(idx, 1);
			}

			newThreads[threadId] = {
				...thread,
				messages: newMessages,
			};
		}

		this._setState({ allThreads: newThreads });
		this._storeAllThreads(newThreads);
	}

	private _generateReviewMessage(threadId: string, plan: PlanMessage): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		const succeededSteps = plan.steps.filter(s => s.status === 'succeeded');
		const failedSteps = plan.steps.filter(s => s.status === 'failed');
		const skippedSteps = plan.steps.filter(s => s.status === 'skipped' || s.disabled);
		const completed = failedSteps.length === 0;

		const executionTime = plan.executionStartTime ? Date.now() - plan.executionStartTime : undefined;
		const stepsCompleted = succeededSteps.length;
		const stepsTotal = plan.steps.length;

		// Collect files changed from checkpoints
		const filesChanged: Array<{ path: string; changeType: 'created' | 'modified' | 'deleted' }> = [];
		const fileSet = new Set<string>();

		// Check all checkpoints created during plan execution
		const planIdx = findLastIdx(thread.messages, (m: ChatMessage) => m.role === 'plan' && (m as PlanMessage).summary === plan.summary);
		if (planIdx >= 0) {
			// Find checkpoints after plan message
			for (let i = planIdx + 1; i < thread.messages.length; i++) {
				const msg = thread.messages[i];
				if (msg.role === 'checkpoint') {
					const checkpoint = msg as CheckpointEntry;
					for (const fsPath in checkpoint.voidFileSnapshotOfURI) {
						if (!fileSet.has(fsPath)) {
							fileSet.add(fsPath);
							// For now, mark as modified (could enhance to detect created/deleted by comparing with initial state)
							filesChanged.push({
								path: fsPath,
								changeType: 'modified'
							});
						}
					}
				}
			}
		}

		// Collect issues from failed steps
		const issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; file?: string }> = [];
		for (const step of failedSteps) {
			issues.push({
				severity: 'error',
				message: step.error || `Step ${step.stepNumber} failed: ${step.description}`,
				file: step.files?.[0]
			});
		}

		// Generate summary
		let summary = completed
			? `Successfully completed all ${stepsCompleted} step${stepsCompleted !== 1 ? 's' : ''} of the plan: ${plan.summary}`
			: `Completed ${stepsCompleted} of ${stepsTotal} steps. ${failedSteps.length} step${failedSteps.length !== 1 ? 's' : ''} failed.`;

		if (skippedSteps.length > 0) {
			summary += ` ${skippedSteps.length} step${skippedSteps.length !== 1 ? 's were' : ' was'} skipped.`;
		}

		// Find last checkpoint index
		const lastCheckpointIdx = findLastIdx(thread.messages, (m: ChatMessage) => m.role === 'checkpoint');

		const reviewMessage: ReviewMessage = {
			role: 'review',
			type: 'agent_review',
			completed,
			summary,
			issues,
			filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
			executionTime,
			stepsCompleted,
			stepsTotal,
			checkpointCount: lastCheckpointIdx >= 0 ? lastCheckpointIdx - (planIdx >= 0 ? planIdx : 0) : 0,
			lastCheckpointIdx: lastCheckpointIdx >= 0 ? lastCheckpointIdx : null,
			nextSteps: failedSteps.length > 0 ? [
				'Review failed steps and retry if needed',
				'Check error messages for details',
				failedSteps.length === 1 ? 'Consider skipping the failed step if it\'s not critical' : ''
			].filter(Boolean) : [
				'Review the changes made',
				'Test the implementation',
				'Continue with additional improvements if needed'
			]
		};

		this._addMessageToThread(threadId, reviewMessage);
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state;
		const oldThread = allThreads[threadId];
		if (!oldThread) { return; } // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads }); // the current thread just changed (it had a message added to it)
		// Invalidate plan cache when plan messages are edited
		if (newMessage.role === 'plan') {
			this._planCache.delete(threadId);
		}
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null;
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, }; }

		const userModifiedVibeideFileSnapshot = Object.hasOwn(checkpointMessage.userModifications.voidFileSnapshotOfURI, fsPath) ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null;
		return { voidFileSnapshot: userModifiedVibeideFileSnapshot ?? voidFileSnapshot, };
	};

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1;
		if (lastCheckpointIdx === -1) { return; }

		const voidFileSnapshotOfURI: { [fsPath: string]: VibeideFileSnapshot | undefined } = {};

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {};
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._vibeideModelService.getModelFromFsPath(fsPath);
			if (!model) { continue; }
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null;
			if (!checkpoint2) { continue; }
			if (checkpoint2.role !== 'checkpoint') { continue; }
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false });
			if (!res) { continue; }
			const { voidFileSnapshot: oldVibeideFileSnapshot } = res;

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVibeideFileSnapshot(URI.file(fsPath));
			if (oldVibeideFileSnapshot === voidFileSnapshot) { continue; }
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot;
		}

		return { voidFileSnapshotOfURI };
	}


	private async _addUserCheckpoint({ threadId }: { threadId: string }): Promise<void> {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {};
		await this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		}, `chat:userEdit:${threadId}`);
	}
	// call this right after LLM edits a file
	private async _addToolEditCheckpoint({ threadId, uri, }: { threadId: string; uri: URI }): Promise<void> {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const { model } = this._vibeideModelService.getModel(uri);
		if (!model) { return; } // should never happen
		const diffAreasSnapshot = this._editCodeService.getVibeideFileSnapshot(uri);
		await this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voidFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voidFileSnapshotOfURI: {} },
		}, `chat:toolEdit:${threadId}`);
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string; messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return undefined; }
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i];
			if (message.role === 'checkpoint') {
				return [message, i];
			}
		}
		return undefined;
	};

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string; loIdx: number; hiIdx: number }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return { lastIdxOfURI: {} }; } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {};
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i];
			if (message?.role !== 'checkpoint') { continue; }
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i;
			}
		}
		return { lastIdxOfURI };
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		const { currCheckpointIdx } = thread.state;
		if (currCheckpointIdx === null) { return; }

		const checkpoint = thread.messages[currCheckpointIdx];
		if (!checkpoint) { return; }
		if (checkpoint.role !== 'checkpoint') { return; }
		return [checkpoint, currCheckpointIdx];
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {};
		const res = this._readCurrentCheckpoint(threadId);
		if (!res) { return; }
		const [checkpoint, checkpointIdx] = res;
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		});
	}


	private async _makeUsStandOnCheckpoint({ threadId }: { threadId: string }): Promise<void> {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1];
			if (lastMsg?.role !== 'checkpoint') { await this._addUserCheckpoint({ threadId }); }
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 });
		}
	}

	async jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string; messageIdx: number; jumpToUserModified: boolean }): Promise<void> {

		// if null, add a new temp checkpoint so user can jump forward again
		await this._makeUsStandOnCheckpoint({ threadId });

		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		if (this.streamState[threadId]?.isRunning) { return; }

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx });
		if (c === undefined) { return; } // should never happen

		const fromIdx = thread.state.currCheckpointIdx;
		if (fromIdx === null) { return; } // should never happen

		const [_, toIdx] = c;
		if (toIdx === fromIdx) { return; }

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId });

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx });

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k;
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k;
				}
			};

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k];
					if (message.role !== 'checkpoint') { continue; }
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified });
					if (!res) { continue; }
					const { voidFileSnapshot } = res;
					if (!voidFileSnapshot) { continue; }
					this._editCodeService.restoreVibeideFileSnapshot(URI.file(fsPath), voidFileSnapshot);
					break;
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx });
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k];
					if (message.role !== 'checkpoint') { continue; }
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified });
					if (!res) { continue; }
					const { voidFileSnapshot } = res;
					if (!voidFileSnapshot) { continue; }
					this._editCodeService.restoreVibeideFileSnapshot(URI.file(fsPath), voidFileSnapshot);
					break;
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx });
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId];
			if (!thread) { return; }
			const userMsg = findLast(thread.messages, m => m.role === 'user');
			if (!userMsg) { return; }
			if (userMsg.role !== 'user') { return; }
			const messageContent = truncate(userMsg.displayContent, 50, '...');

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? localize('vibeide.chatThread.notify.errorPrefix', 'Ошибка: {0} ', error) : localize('vibeide.chatThread.notify.resultReady', 'Готов новый ответ в чате.'),
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'vibe.goToChat',
						enabled: true,
						label: localize('vibeide.chatThread.notify.jumpToChat', 'Перейти к чату'),
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId);
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom();
							});
						}
					}]
				},
			});
		};

		p.then(() => {
			if (threadId !== this.state.currentThreadId) { notify({ error: null }); }
		}).catch((e) => {
			// Context overflow surfaced from prepareLLMChatMessages: always notify the
			// active user (not just other threads) and stop the stream cleanly, since
			// the request never reached the model — no provider-level abort to chain.
			if (e instanceof ContextOverflowError) {
				this._notificationService.error(e.message);
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
				return;
			}
			if (threadId !== this.state.currentThreadId) { notify({ error: getErrorMessage(e) }); }
			throw e;
		});
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined);
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, images, pdfs, noPlan, displayContent }: { userMessage: string; _chatSelections?: StagingSelectionItem[]; threadId: string; images?: ChatImageAttachment[]; pdfs?: ChatPDFAttachment[]; noPlan?: boolean; displayContent?: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		// A fresh submit supersedes any pending rate-limit auto-resume — cancel it so it can't
		// fire a duplicate turn on top of this one.
		this._clearRateLimitResumeTimer(threadId);

		// Submit-level watchdog: start a safety timer covering the whole prep pipeline
		// (file reads in chat_userMessageContent, search-mention resolution, PDF processing,
		// router selection, prompt building) up to the moment the stream transitions to
		// an active state. _setStreamState clears this timer once isRunning becomes
		// 'LLM'/'tool'/'awaiting_user'/'idle' — NOT on 'preparing', because preparation
		// can still hang for a long time after preparing-state is set (router LLM call,
		// vision-capability dynamic import, _runChatAgent's checkPlanGenerated() gate, etc.).
		const submitWatchdogEnabled = this._configurationService.getValue<boolean>('vibeide.chat.streamHardStallEnabled') ?? true;
		const submitWatchdogSeconds = Math.max(30, Math.min(1800, this._configurationService.getValue<number>('vibeide.chat.streamHardStallSeconds') ?? DEFAULT_HARD_STALL_SECONDS));
		if (submitWatchdogEnabled) {
			const prev = this._submitWatchdogByThread.get(threadId);
			if (prev !== undefined) { clearTimeout(prev); }
			const timer = setTimeout(() => {
				this._submitWatchdogByThread.delete(threadId);
				const currentState = this.streamState[threadId];
				// Two flavours of stuck:
				//  (A) isRunning is undefined — preparation pipeline died silently before
				//      setting any state. The old behaviour: just surface a hard-stall error.
				//  (B) isRunning is STILL in a running state ('preparing'/'LLM'/'tool'/
				//      'awaiting_user') after the full timeout — pipeline hung inside that
				//      stage and the normal post-preparation clear never fired. Previously
				//      we bailed silently here, leaving the chat locked. Now we ALSO surface
				//      an error with `recoverable: 'forceReset'` so the UI can offer a
				//      one-click recovery button instead of forcing an IDE restart.
				if (currentState?.isRunning === undefined) {
					this._setStreamState(threadId, {
						isRunning: undefined,
						error: {
							message: localize('vibeide.chatThread.submitHardStall', 'Отправка зависла — этап подготовки не завершился за {0}с (нет прогресса до «Подготовка запроса…»). Вероятно, завис чтение файла, роутер моделей или сборка промпта. Повторите попытку, переключите модель или уберите прикреплённые файлы/контекст.', String(submitWatchdogSeconds)),
							fullError: null,
						},
					});
					return;
				}
				vibeLog.warn('chatThread', `Submit watchdog fired with isRunning=${currentState.isRunning} (threadId=${threadId}, after ${submitWatchdogSeconds}s). Surfacing forceReset error.`);
				this._setStreamState(threadId, {
					isRunning: undefined,
					error: {
						message: localize('vibeide.chatThread.submitHardStallStuck', 'Чат завис на этапе подготовки ({0}) дольше {1}с — нормально это не должно занимать столько. Состояние можно сбросить кнопкой ниже и попробовать снова.', String(currentState.isRunning), String(submitWatchdogSeconds)),
						fullError: null,
						recoverable: 'forceReset',
					},
				});
			}, submitWatchdogSeconds * 1000);
			this._submitWatchdogByThread.set(threadId, timer);
		}

		// interrupt existing stream. If we detect the thread has been "running"
		// for an implausibly long time (e.g. previous send hung in 'preparing'
		// because the LLM call never resolved AND the interruptor never fired),
		// don't even attempt abortRunning — go straight to forceResetChatState.
		// abortRunning has its own 2s timeout on interrupt, but it also does
		// work like committing partial assistant content which can itself hang
		// against bad state. Threshold REUSES `vibeide.chat.streamHardStallSeconds`
		// (default 120s) — same semantic ("how long is too long for a stream to
		// be active without finishing"), so the two settings stay in sync. User
		// raising hard-stall timeout to 300s also extends the stuck-detection
		// threshold, no separate knob needed.
		const stuckThresholdMs = (Math.max(30, Math.min(1800,
			this._configurationService.getValue<number>('vibeide.chat.streamHardStallSeconds') ?? DEFAULT_HARD_STALL_SECONDS
		))) * 1000;
		const setAt = this._streamStateSetAt.get(threadId);
		const ageMs = setAt !== undefined ? Date.now() - setAt : 0;
		if (this.streamState[threadId]?.isRunning && ageMs > stuckThresholdMs) {
			vibeLog.warn('chatThread', `Detected stuck running state on send (age=${Math.floor(ageMs / 1000)}s > ${stuckThresholdMs / 1000}s threshold, isRunning=${this.streamState[threadId]?.isRunning}). Force-resetting instead of awaiting abortRunning.`);
			this.forceResetChatState(threadId);
		} else if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId);
		}

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			await this._addUserCheckpoint({ threadId });
		}


		// Optionally suppress plan generation for this message
		if (noPlan) {
			this._suppressPlanOnceByThread[threadId] = true;
		}

		// add user's message to chat history
		const instructions = userMessage;
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections;

		let userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }); // user message + names of files (NOT content)

		// @search mention dispatcher (roadmap §L932): resolve workspace literal-grep mentions before sending to LLM.
		const searchMentions = this._mentionService.parseMentions(instructions).filter(m => m.type === 'search' && m.value);
		if (searchMentions.length > 0) {
			const searchFragments = await Promise.all(
				searchMentions.map(m => this._searchContextService.searchAndRender(m.value).catch(() => ''))
			);
			const combined = searchFragments.filter(Boolean).join('\n\n');
			if (combined) {
				userMessageContent += '\n\n' + combined;
			}
		}

		// Append PDF extracted text to message content for context
		if (pdfs && pdfs.length > 0) {
			const pdfTexts: string[] = [];
			for (const pdf of pdfs) {
				if (pdf.extractedText && pdf.extractedText.trim().length > 0) {
					// Only include selected pages if specified
					let textToInclude = pdf.extractedText;
					if (pdf.selectedPages && pdf.selectedPages.length > 0 && pdf.pageCount) {
						// Filter text by selected pages
						const pageTexts = pdf.extractedText.split(/\n\n\[Page \d+\]\n/);
						const selectedTexts: string[] = [];
						for (const pageNum of pdf.selectedPages) {
							const pageIndex = pageNum - 1; // Convert to 0-based index
							if (pageIndex >= 0 && pageIndex < pageTexts.length) {
								selectedTexts.push(`[Page ${pageNum}]\n${pageTexts[pageIndex]}`);
							}
						}
						if (selectedTexts.length > 0) {
							textToInclude = selectedTexts.join('\n\n');
						}
					}
					const pageInfo = pdf.pageCount ? ` (${pdf.pageCount} page${pdf.pageCount !== 1 ? 's' : ''})` : '';
					pdfTexts.push(`\n\n[PDF: ${pdf.filename}${pageInfo}]\n${textToInclude}`);
				} else {
					vibeLog.warn('chatThread', `PDF ${pdf.filename} has no extracted text - it may not have been processed correctly`);
				}
			}
			if (pdfTexts.length > 0) {
				userMessageContent += '\n\n' + pdfTexts.join('\n\n');
			} else {
				vibeLog.warn('chatThread', 'PDFs were attached but no extracted text was available to send to the model');
			}
		}

		const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: displayContent || instructions, selections: currSelns, images, pdfs, state: defaultMessageState };
		this._addMessageToThread(threadId, userHistoryElt);

		this._setThreadState(threadId, { currCheckpointIdx: null }); // no longer at a checkpoint because started streaming

		// Set early preparing state to give immediate feedback
		let preparationCancelled = false;
		const preparationInterruptor = Promise.resolve(() => { preparationCancelled = true; });
		this._setStreamState(threadId, {
			isRunning: 'preparing',
			llmInfo: {
				displayContentSoFar: 'Preparing request...',
				reasoningSoFar: '',
				toolCallSoFar: null
			},
			interrupt: preparationInterruptor
		});

		// Check if user selected "Auto" mode
		const userModelSelection = this._currentModelSelectionProps().modelSelection;
		const isAutoMode = userModelSelection?.providerName === 'auto' && userModelSelection?.modelName === 'auto';

		// Auto-select model based on task context if in auto mode, otherwise use user's selection
		// Generate requestId early for router tracking in auto mode, then reuse it in _runChatAgent
		const earlyRequestId = isAutoMode ? generateUuid() : undefined;
		let modelSelection: ModelSelection | null;

		// PERFORMANCE: Start prompt prep in parallel with router decision for auto mode
		// This can save 50-200ms by doing work that doesn't need model selection
		let repoIndexerPromise: Promise<{ results: string[]; metrics: QueryMetrics } | null> | undefined;
		if (isAutoMode && earlyRequestId) {
			// Update status to show model selection in progress
			if (!preparationCancelled) {
				this._setStreamState(threadId, {
					isRunning: 'preparing',
					llmInfo: {
						displayContentSoFar: 'Selecting best model for this task...',
						reasoningSoFar: '',
						toolCallSoFar: null
					},
					interrupt: preparationInterruptor
				});
			}

			// Track router timing for auto mode
			chatLatencyAudit.startRequest(earlyRequestId, 'auto', 'auto');
			chatLatencyAudit.markRouterStart(earlyRequestId);

			// Start router decision and repo indexer query in parallel
			// PERFORMANCE: Repo indexer query doesn't need model selection - start it early
			const routerPromise = this._autoSelectModel(instructions, images, pdfs);
			const thread = this.state.allThreads[threadId];
			const chatMessages = thread?.messages ?? [];
			const { chatMode } = this._settingsService.state.globalSettings;

			// Start repo indexer query in parallel (saves 50-200ms)
			repoIndexerPromise = this._convertToLLMMessagesService.startRepoIndexerQuery(chatMessages, chatMode);

			// Wait for router decision
			const autoSelectedModel = await routerPromise;
			chatLatencyAudit.markRouterEnd(earlyRequestId);
			modelSelection = autoSelectedModel;

			// CRITICAL: If auto selection failed, we need a fallback to prevent null modelSelection
			// This ensures we never send empty messages to the API (which causes "invalid message format" error)
			if (!modelSelection) {
				// Try to get any available model as fallback using shared utility
				const fallbackModel = this._settingsService.resolveAutoModelSelection(null);
				if (fallbackModel) {
					modelSelection = fallbackModel;
					this._notificationService.warn('Auto model selection failed. Using fallback model. Please configure your model providers.');
				} else {
					// Last resort: show error and don't proceed
					this._notificationService.error('No models available. Please configure at least one model provider in settings.');
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
					return;
				}
			}
		} else {
			modelSelection = userModelSelection;
		}

		// Final validation: ensure modelSelection is not null before proceeding
		if (!modelSelection) {
			this._notificationService.error('No model selected. Please select a model in settings.');
			this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
			return;
		}

		// Validate model capabilities if attachments are present
		// This applies to both auto and manual mode to ensure images are handled correctly
		if ((images && images.length > 0 || pdfs && pdfs.length > 0) && modelSelection && !(modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto')) {
			const { getModelCapabilities } = await import('../common/modelCapabilities.js');
			const capabilities = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, this._settingsService.state.overridesOfModel);

			// Check if model is vision-capable using the same logic as modelRouter
			const isVisionCapable = this._isModelVisionCapable(modelSelection, capabilities);

			if (!isVisionCapable) {
				// For PDFs, we can still send them as text (extractedText), so no warning needed
				if (images && images.length > 0) {
					// Hard-block: silently dropping images and continuing leads to the model hallucinating
					// "what it sees" based on the system prompt. Refuse the request and tell the user how to fix it.
					const modelLabel = `${modelSelection.providerName}/${modelSelection.modelName}`;
					const message = isAutoMode
						? localize('vibeide.chat.autoModelNoImageSupport', 'Авто-выбранная модель ({0}) не поддерживает изображения. Настройте vision-провайдера (Anthropic, OpenAI, Gemini или OpenRouter с vision-моделью) и повторите отправку.', modelLabel)
						: localize('vibeide.chat.selectedModelNoImageSupport', 'Выбранная модель ({0}) не поддерживает изображения. Переключитесь на vision-модель (Claude, GPT-4o/4.1/5, Gemini, vision-модель OpenRouter или Ollama llava/bakllava) либо удалите вложение.', modelLabel);
					this._notificationService.error(message);
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });
					return;
				}
				// PDFs are sent as extracted text, so they work fine with non-vision models
				// No notification needed - PDFs will be processed correctly via text extraction
			}
		}

		// Check if preparation was cancelled
		if (preparationCancelled) {
			this._setStreamState(threadId, undefined);
			return;
		}

		// Update status to show request preparation
		this._setStreamState(threadId, {
			isRunning: 'preparing',
			llmInfo: {
				displayContentSoFar: 'Preparing request...',
				reasoningSoFar: '',
				toolCallSoFar: null
			},
			interrupt: preparationInterruptor
		});

		// Get model options (skip for "auto" since it's not a real model)
		const modelSelectionOptions = modelSelection && !(modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto')
			? this._settingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]
			: undefined;

		// repoIndexerPromise is already set above if in auto mode

		// Pass earlyRequestId, isAutoMode, and repoIndexerPromise to _runChatAgent for latency tracking
		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, modelSelection, modelSelectionOptions, earlyRequestId, isAutoMode, repoIndexerPromise }),
			threadId,
		);

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom();
		});
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, images, pdfs, noPlan, displayContent }: { userMessage: string; _chatSelections?: StagingSelectionItem[]; threadId: string; images?: ChatImageAttachment[]; pdfs?: ChatPDFAttachment[]; noPlan?: boolean; displayContent?: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}


		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, images, pdfs, noPlan, displayContent });

		// Safety: ensure stream state is cleared when the stream finishes (unless awaiting user approval)
		const s = this.streamState[threadId];
		if (!s || s.isRunning === undefined || s.isRunning === 'idle' || s.isRunning === 'awaiting_user') {
			return;
		}
		// If still running after completion, clear it (stream should have been handled by _addUserMessageAndStreamResponse)
		this._setStreamState(threadId, undefined);

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`);
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || []; // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx);
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		});

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId });
	};

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return []; }

		const fsPathsSet = new Set<string>();
		const uris: URI[] = [];
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) { uris.push(uri); }
			fsPathsSet.add(uri.fsPath);
			uris.push(uri);
		};

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri);
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file'];
				addURI(params.uri);
			}
		}
		return uris;
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri);
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath));
			if (f) { return uri.fsPath.replace(f.uri.fsPath, ''); }
			else { return undefined; }
		}
		else {
			return undefined;
		}
	};


	// D.41: codespan→link resolution is invoked by the markdown renderer for EVERY inline code span on
	// EVERY React re-render — and the chat re-renders on every streamed token. The file-or-folder branch
	// runs search_pathnames_only (rg --files) and the function branch runs definition providers; both are
	// expensive. Unmemoized, this spawned dozens of duplicate ripgrep processes per second during
	// streaming — the confirmed driver of the rg leak. The link target for a given codespan text is
	// render-stable, so cache the (in-flight + resolved) result per (threadId, codespanStr) and resolve
	// each at most once. Cosmetic staleness (a file created later isn't re-linked) is acceptable.
	private readonly _codespanLinkCache = new Map<string, Promise<{ uri: URI; displayText: string } | null>>();

	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = (args) => {
		const key = `${args.threadId}\u0000${args.codespanStr}`;
		let cached = this._codespanLinkCache.get(key);
		if (!cached) {
			if (this._codespanLinkCache.size > 5000) { this._codespanLinkCache.clear(); } // bound memory on very long sessions
			cached = this._generateCodespanLinkImpl(args);
			this._codespanLinkCache.set(key, cached);
		}
		return cached;
	};

	private _generateCodespanLinkImpl: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr; // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class';
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder';
			target = _codespanStr;

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class';
			target = _codespanStr;

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern);
			if (match && match[1]) {

				codespanType = 'function-or-class';
				target = match[1];

			}
			else { return null; }
		}
		else {
			return null;
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse();

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target);

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath);
					const shortenedUriStrs = shorten(prevUriStrs);
					let displayText = shortenedUriStrs[idx];
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2);
					}

					return { uri, displayText };
				}
			}

			// else search codebase for `target`
			let uris: URI[] = [];
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 });
				const { uris: uris_ } = await result;
				uris = uris_;
			} catch (e) {
				return null;
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath);
					const shortenedUriStrs = shorten(prevUriStrs);
					let displayText = shortenedUriStrs[idx];
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2);
					}


					return { uri, displayText };
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._vibeideModelService.getModelSafe(uri);
				const { model } = modelRef;
				if (!model) { continue; }

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) { continue; }

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null;

	};

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string; messageIdx: number; threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return undefined; }

		const links = thread.state.linksOfMessageIdx?.[messageIdx];
		if (!links) { return undefined; }

		const link = links[codespanStr];

		return link;
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string; newLinkLocation: CodespanLocationLink; messageIdx: number; threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		});
	}


	getCurrentThread(): ThreadType {
		const state = this.state;
		const thread = state.allThreads[state.currentThreadId];
		if (!thread) { throw new Error(`Current thread should never be undefined`); }
		return thread;
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread();

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx;
		if (focusedMessageIdx === undefined) { return; }

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx];
		if (focusedMessage.role !== 'user') { return; }
		if (!focusedMessage.state) { return; }

		return focusedMessageIdx;
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined;
	}

	// Soft cap on simultaneously open chat tabs (`vibeide.chat.maxOpenTabs`, default 5).
	// Reading the live config keeps a single source of truth; clamped defensively so a
	// corrupt/out-of-range value can never disable the cap or evict the active tab.
	private _maxOpenTabs(): number {
		const r = this._configurationService.getValue<number>('vibeide.chat.maxOpenTabs');
		return (typeof r === 'number' && Number.isFinite(r)) ? Math.max(1, Math.min(20, Math.floor(r))) : 5;
	}
	// Trim `openTabIds` down to the cap by evicting the OLDEST tabs (front of the array —
	// new tabs are appended), never closing `keepId` (the tab being activated/created).
	// Eviction only drops the tab from the working set; the thread stays in history.
	private _capOpenTabs(openTabIds: string[], keepId: string): string[] {
		const cap = this._maxOpenTabs();
		if (openTabIds.length <= cap) { return openTabIds; }
		const result = [...openTabIds];
		for (let i = 0; i < result.length && result.length > cap;) {
			if (result[i] === keepId) { i++; continue; }
			result.splice(i, 1);
		}
		return result;
	}

	switchToThread(threadId: string) {
		// Switching to a thread also OPENS it as a tab (covers opening from history). Idempotent.
		let openTabIds = this.state.openTabIds;
		if (!openTabIds.includes(threadId)) {
			openTabIds = this._capOpenTabs([...openTabIds, threadId], threadId);
			this._storeOpenTabIds(openTabIds);
		}
		this._setState({ currentThreadId: threadId, openTabIds });
	}

	// Per-thread composer draft (in-memory — drafts intentionally do not survive a full reload,
	// matching the previous editor-tab behaviour). Keyed by threadId so each open chat tab keeps
	// its own unsent text across tab switches.
	private readonly _threadDrafts = new Map<string, string>();
	getThreadDraft(threadId: string): string {
		return this._threadDrafts.get(threadId) ?? '';
	}
	setThreadDraft(threadId: string, text: string): void {
		if (text) { this._threadDrafts.set(threadId, text); } else { this._threadDrafts.delete(threadId); }
	}

	setThreadChatConfig(threadId: string, cfg: ThreadChatConfig): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		// Skip a no-op write so re-applying a snapshot on tab switch doesn't churn state.
		if (JSON.stringify(thread.chatConfig) === JSON.stringify(cfg)) { return; }
		const updated: ChatThreads = { ...this.state.allThreads, [threadId]: { ...thread, chatConfig: cfg } };
		this._storeAllThreads(updated);
		// A pure config write must NOT refresh the mount info: doing so resets the active
		// thread's `whenMounted` to a fresh pending promise on every per-tab config snapshot.
		// During a new-tab mount the apply-effect writes that snapshot synchronously, so the
		// reset churns the resolver effect and (with no project open) can wedge the renderer.
		this._setState({ allThreads: updated }, true);
	}

	closeTab(threadId: string): void {
		this._threadDrafts.delete(threadId);
		const idx = this.state.openTabIds.indexOf(threadId);
		if (idx === -1) { return; }
		const openTabIds = this.state.openTabIds.filter(id => id !== threadId);
		this._storeOpenTabIds(openTabIds);
		// Closing a tab does NOT delete the thread — it stays in history.
		if (this.state.currentThreadId === threadId) {
			// Activate the neighbour (prefer the tab to the left, else the new one at this index).
			const next = openTabIds[idx - 1] ?? openTabIds[idx] ?? openTabIds[openTabIds.length - 1];
			if (next) {
				this._setState({ currentThreadId: next, openTabIds });
			} else {
				// No tabs left — open a fresh chat so the view is never empty.
				this._setState({ openTabIds });
				this.openNewThread();
			}
		} else {
			this._setState({ openTabIds });
		}
	}

	reorderOpenTabs(fromId: string, toId: string): void {
		if (fromId === toId) { return; }
		const ids = [...this.state.openTabIds];
		const from = ids.indexOf(fromId);
		const to = ids.indexOf(toId);
		if (from === -1 || to === -1) { return; }
		// Remove the dragged tab, then re-insert it at the drop target: after the target when
		// dragging rightwards, before it when dragging leftwards (intuitive tab DnD).
		ids.splice(from, 1);
		const targetIdx = ids.indexOf(toId);
		ids.splice(from < to ? targetIdx + 1 : targetIdx, 0, fromId);
		this._storeOpenTabIds(ids);
		this._setState({ openTabIds: ids });
	}


	private _currentWorkspace(): { id: string; label: string } {
		const ws = this._workspaceContextService.getWorkspace();
		const folders = ws.folders;
		// Folder-less window: `getWorkspace().id` is a transient per-window value
		// that changes across reopens — stamping it would orphan threads on the
		// next launch (CH.11). Return an empty id so such threads stay untagged
		// (≡ visible in every project) instead of bound to an unstable id.
		if (folders.length === 0) { return { id: '', label: '' }; }
		// First folder basename is the intuitive "project name"; for multi-root
		// append "+N" so a monorepo workspace is distinguishable.
		let label = folders[0]?.name ?? '';
		if (folders.length > 1) { label = `${label} +${folders.length - 1}`; }
		return { id: ws.id, label };
	}

	getCurrentWorkspaceId(): string {
		return this._currentWorkspace().id;
	}

	getHistoryShowAllProjects(): boolean {
		// Stored toggle wins; when unset, fall back to the configurable default scope.
		const def = this._configurationService.getValue<boolean>(HISTORY_DEFAULT_SHOW_ALL_KEY) === true;
		return this._storageService.getBoolean(HISTORY_SHOW_ALL_PROJECTS_KEY, StorageScope.PROFILE, def);
	}

	setHistoryShowAllProjects(value: boolean): void {
		// PROFILE scope + onDidChangeValue makes every history list (and window)
		// react to the toggle without a bespoke service event.
		this._storageService.store(HISTORY_SHOW_ALL_PROJECTS_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	moveThreadToCurrentWorkspace(threadId: string): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const ws = this._currentWorkspace();
		if (!ws.id) { return; } // folder-less window — no real project to assign to (CH.11)
		if (thread.workspaceId === ws.id) { return; }
		const updated: ChatThreads = { ...this.state.allThreads, [threadId]: { ...thread, workspaceId: ws.id, workspaceLabel: ws.label } };
		this._storeAllThreads(updated);
		this._setState({ allThreads: updated });
	}

	claimUntaggedThreadsForCurrentWorkspace(): number {
		// One-shot migration: stamp legacy (pre-scoping) threads — those with no
		// workspaceId — onto the current project. Threads already owned by another
		// project are left untouched (use the per-thread "move" action for those).
		const ws = this._currentWorkspace();
		if (!ws.id) { return 0; } // folder-less window — no real project to claim into (CH.11)
		const current = this.state.allThreads;
		const updated: ChatThreads = { ...current };
		let claimed = 0;
		for (const id in current) {
			const t = current[id];
			if (t && !t.workspaceId) {
				updated[id] = { ...t, workspaceId: ws.id, workspaceLabel: ws.label };
				claimed++;
			}
		}
		if (claimed === 0) { return 0; }
		this._storeAllThreads(updated);
		this._setState({ allThreads: updated });
		return claimed;
	}

	getCurrentWorkspaceThreads(): ThreadType[] {
		const wsId = this.getCurrentWorkspaceId();
		// Strictly OWNED by this project (see threadOwnedBy) — excludes legacy/untagged
		// (shared) and other projects, so export/clear act only on this project's own history.
		return Object.values(this.state.allThreads)
			.filter((t): t is ThreadType => !!t && threadOwnedBy(t, wsId) && t.messages.length > 0);
	}

	deleteCurrentWorkspaceThreads(): number {
		const wsId = this.getCurrentWorkspaceId();
		const ids = Object.keys(this.state.allThreads)
			.filter(id => { const t = this.state.allThreads[id]; return !!t && threadOwnedBy(t, wsId) && t.messages.length > 0; });
		for (const id of ids) { this.deleteThread(id); } // reuse deleteThread → plan/lock/session cleanup
		return ids.length;
	}

	openNewThread() {
		const ws = this._currentWorkspace();
		// if a thread with 0 messages already exists, switch to it
		const { allThreads: currentThreads } = this.state;
		for (const threadId in currentThreads) {
			if (currentThreads[threadId]!.messages.length === 0) {
				// Re-stamp the reused empty thread to the current workspace before
				// switching: a persisted empty thread may carry another project's
				// id, which would otherwise capture this project's first message.
				const reused = currentThreads[threadId]!;
				if (reused.workspaceId !== ws.id) {
					const restamped: ChatThreads = { ...currentThreads, [threadId]: { ...reused, workspaceId: ws.id, workspaceLabel: ws.label } };
					this._storeAllThreads(restamped);
					this._setState({ allThreads: restamped });
				}
				this.switchToThread(threadId);
				return;
			}
		}
		// otherwise, start a new thread
		const newThread = newThreadObject(ws.id, ws.label);

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		};
		const openTabIds = this._capOpenTabs([...this.state.openTabIds, newThread.id], newThread.id);
		this._storeAllThreads(newThreads);
		this._storeOpenTabIds(openTabIds);
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id, openTabIds });
	}

	forceCreateNewThread(): string {
		// Unconditionally create a new thread (no empty-thread reuse). Used by multi-chat-tab "+" so each click yields a new tab.
		const ws = this._currentWorkspace();
		const newThread = newThreadObject(ws.id, ws.label);
		const newThreads: ChatThreads = {
			...this.state.allThreads,
			[newThread.id]: newThread
		};
		const openTabIds = this._capOpenTabs([...this.state.openTabIds, newThread.id], newThread.id);
		this._storeAllThreads(newThreads);
		this._storeOpenTabIds(openTabIds);
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id, openTabIds });
		return newThread.id;
	}


	deleteThread(threadId: string): void {
		this._planBindingRegistry.clearThread(threadId);
		this._taskDecompositionService.clearPersistedPlanTask(threadId);

		// Release short-term session memory for this thread (roadmap §933).
		this._sessionMemoryService.releaseThread(threadId);

		// Release advisory territorial locks whose holder matches this thread (roadmap §904).
		void this._agentTerritorialLockService.releaseHolderLocks(threadId);

		// Clear all per-thread Maps and ad-hoc state owned by this service.
		// Without this, deleted threads leave orphan entries that accumulate over
		// a long session (multiple new-chat clicks) and — worse — `streamState`
		// + `_submitWatchdogByThread` orphans can fire timers / callbacks against
		// a no-longer-existing thread. Centralised here so future per-thread
		// maps only need ONE addition (not a sweep through every map every time).
		const pendingWatchdog = this._submitWatchdogByThread.get(threadId);
		if (pendingWatchdog !== undefined) {
			clearTimeout(pendingWatchdog);
			this._submitWatchdogByThread.delete(threadId);
		}
		this._pendingStreamStateUpdates.delete(threadId);
		this._streamStateSetAt.delete(threadId);
		this._planCache.delete(threadId);
		this._fileReadCache.delete(threadId);
		this._fileReadCacheLRU.delete(threadId);
		this._recentToolSigs.delete(threadId);
		this._threadDrafts.delete(threadId);
		delete this._suppressPlanOnceByThread[threadId];
		delete this.streamState[threadId];
		// `_emptyResponseStreak` is keyed by `${threadId}:provider:model` — need
		// to scan keys, not a single delete. Done as a pass over Map keys.
		for (const key of this._emptyResponseStreak.keys()) {
			if (key.startsWith(`${threadId}:`)) {
				this._emptyResponseStreak.delete(key);
			}
		}

		const { allThreads: currentThreads } = this.state;

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		// Also drop it from the open-tab set (deleting from history closes its tab too).
		const openTabIds = this.state.openTabIds.filter(id => id !== threadId);
		const wasCurrent = this.state.currentThreadId === threadId;

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._storeOpenTabIds(openTabIds);
		if (wasCurrent) {
			const next = openTabIds[openTabIds.length - 1];
			if (next) {
				this._setState({ allThreads: newThreads, openTabIds, currentThreadId: next });
			} else {
				// Deleted the only/last open chat — open a fresh one so the view is never empty.
				this._setState({ allThreads: newThreads, openTabIds });
				this.openNewThread();
			}
		} else {
			this._setState({ allThreads: newThreads, openTabIds });
		}
		this._onDidDeleteThread.fire(threadId);
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state;
		const threadToDuplicate = currentThreads[threadId];
		if (!threadToDuplicate) { return; }
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		};
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
	}


	// Hard cap on messages per thread. Independent from convertToLLMMessageService's
	// payload-level summarization (which only affects what we SEND to the LLM):
	// this bounds the JSON we keep in renderer memory and persist to disk. Long
	// agent sessions, especially retry/loop storms, used to grow unbounded and
	// OOM the Electron renderer (~thousand+ messages of accumulated tool errors
	// + assistant retries). When `messages.length` exceeds the configured cap
	// after an append, we drop the oldest messages back down to (cap - 100) and
	// insert a single synthetic assistant marker at the new head documenting the
	// trim. orphaned tool-result references in the surviving tail are handled
	// transparently by aiSdkAdapter's source-level orphan guard.
	// Configurable via `vibeide.chat.maxMessagesPerThread` (default 500, range
	// 100..5000). Trim headroom is fixed at 100 (delta between cap and target)
	// — keeps trim runs amortised, no need for two separate settings.
	private static readonly TRIM_HEADROOM = 100;

	addPendingInjection(threadId: string, text: string): void {
		const t = text.trim();
		if (!t) { return; }
		const cur = this.state.allThreads[threadId]?.state.pendingInjections ?? [];
		this._setThreadState(threadId, { pendingInjections: [...cur, t] });
	}

	removePendingInjection(threadId: string, index: number): void {
		const cur = this.state.allThreads[threadId]?.state.pendingInjections ?? [];
		if (index < 0 || index >= cur.length) { return; }
		this._setThreadState(threadId, { pendingInjections: cur.filter((_, i) => i !== index) });
	}

	/** Drain queued mid-run context into a real user message so the model sees it on this hop and it
	 *  shows in the transcript. Cleared FIRST to avoid a re-entrant double-inject. */
	private _drainPendingInjections(threadId: string): void {
		const pending = this.state.allThreads[threadId]?.state.pendingInjections;
		if (!pending || pending.length === 0) { return; }
		const content = '[Контекст, добавленный в ходе выполнения]\n' + pending.join('\n\n');
		this._setThreadState(threadId, { pendingInjections: [] });
		this._addMessageToThread(threadId, { role: 'user', content, displayContent: content, selections: [], images: [], pdfs: [], state: defaultMessageState });
		vibeLog.warn('chatThreadService', `[inject] подмешан контекст к следующему хопу (${pending.length} заметок)`);
	}

	/** Run ended (genuine completion / «Продолжить» stall) but context the user queued mid-run never got
	 *  drained — the agent finished before the next hop. Send it as a fresh turn instead of stranding it.
	 *  Called from the _setStreamState transition funnel, which already excludes error / abort / awaiting-user. */
	private _autoSendPendingInjectionsAsNewTurn(threadId: string): void {
		if (this._configurationService.getValue<boolean>('vibeide.chat.autoSendPendingInjections') === false) { return; }
		const pending = this.state.allThreads[threadId]?.state.pendingInjections;
		if (!pending || pending.length === 0) { return; }
		const content = pending.join('\n\n');
		this._setThreadState(threadId, { pendingInjections: [] }); // clear FIRST to avoid a re-entrant double-send
		vibeLog.warn('chatThreadService', `[inject] ход завершён с непустым буфером — досылаю как новый ход (${pending.length} заметок)`);
		// Deferred: we are inside the _setStreamState funnel; let the current state update settle before
		// starting a new turn (which re-enters _setStreamState).
		queueMicrotask(() => { void this._addUserMessageAndStreamResponse({ userMessage: content, threadId, displayContent: content }); });
	}

	private _addMessageToThread(threadId: string, message: ChatMessage) {
		// Invalidate plan cache when plan messages are added
		if (message.role === 'plan') {
			this._planCache.delete(threadId);
		}
		const { allThreads } = this.state;
		const oldThread = allThreads[threadId];
		if (!oldThread) { return; } // should never happen
		// stamp createdAt for the message variants that opt into it (user / assistant / checkpoint)
		const stampedMessage: ChatMessage = (
			(message.role === 'user' || message.role === 'assistant' || message.role === 'checkpoint')
			&& (message as { createdAt?: number }).createdAt === undefined
		)
			? { ...message, createdAt: Date.now() }
			: message;
		// Compute new messages array, applying the hard cap if exceeded. The trim is a
		// pure, unit-tested helper (chatThreadTrim.ts) that bounds memory while pinning
		// the original task so long sessions don't "forget" their goal (model-stalls #012).
		const cap = Math.max(100, Math.min(5000,
			this._configurationService.getValue<number>('vibeide.chat.maxMessagesPerThread') ?? 500
		));
		let nextMessages: ChatMessage[] = [...oldThread.messages, stampedMessage];
		const trim = trimThreadMessages(nextMessages, cap, ChatThreadService.TRIM_HEADROOM);
		if (trim) {
			nextMessages = trim.trimmed;
			vibeLog.warn('chatThread', `Trimmed ${trim.dropCount} oldest messages from thread ${threadId} (cap=${cap}, target=${trim.target}${trim.pinnedAnchor ? ', pinned original task' : ''})`);
			this._metricsService.capture('Thread Messages Trimmed', {
				dropCount: trim.dropCount,
				cap,
				target: trim.target,
			});
		}
		// Size-cap OLD tool-results (keeps the last keepRecent full). Bounds the per-result
		// memory cost that the COUNT trim above doesn't — one huge read_file/search output can
		// dwarf hundreds of small messages. Feeds the same nextMessages into store + state, so
		// both the renderer and the persisted blob stay bounded. NO SILENT TRIMS: logged.
		const { maxChars: resultMaxChars, keepRecent: resultKeepRecent } = this._resolveToolResultCap();
		const resultCap = capToolResultSizes(nextMessages, resultMaxChars, resultKeepRecent);
		if (resultCap) {
			nextMessages = resultCap.messages;
			vibeLog.debug('chatThread', `Capped ${resultCap.cappedCount} old tool-result(s) in thread ${threadId} (~${(resultCap.charsCut / 1024) | 0} KB cut; keepRecent=${resultKeepRecent}, maxKB=${(resultMaxChars / 1024) | 0}).`);
		}
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: nextMessages,
			}
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads }); // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId;
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		});

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx();

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = [];
		let setSelections = (s: StagingSelectionItem[]) => { };

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections;
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s });
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections;
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s });
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection);
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			]);
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection]);
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx();

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = [];
		let setSelections = (s: StagingSelectionItem[]) => { };

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections;
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s });
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections;
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s });
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		]);

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId;
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		});

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo);

	}



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread();
		return currentThread.state;
	};
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState);
	};

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx];
		if (!currMessage || currMessage.role !== 'user') { return defaultMessageState; }
		return currMessage.state;
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx];
		if (!currMessage || currMessage.role !== 'user') { return; }
		this._setCurrentMessageState(newState, messageIdx);
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
