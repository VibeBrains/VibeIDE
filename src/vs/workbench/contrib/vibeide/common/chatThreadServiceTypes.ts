/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { VibeideFileSnapshot } from './editCodeServiceTypes.js';
import { AnthropicReasoning, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolCallParams, ToolName, ToolResult } from './toolsServiceTypes.js';

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	content: string; // give this result to LLM (string of value)
	id: string;
	rawParams: RawToolParamsObj;
	mcpServerName: string | undefined; // the server name at the time of the call
	pinned?: boolean; // pin-context: honored by budget-fill truncation; setter (UI) pending
} & (
		// in order of events:
		| { type: 'invalid_params'; result: null; name: T }

		| { type: 'tool_request'; result: null; name: T; params: ToolCallParams<T> }  // params were validated, awaiting user

		| { type: 'running_now'; result: null; name: T; params: ToolCallParams<T> }

		| { type: 'tool_error'; result: string; name: T; params: ToolCallParams<T> } // error when tool was running
		| { type: 'success'; result: Awaited<ToolResult<T>>; name: T; params: ToolCallParams<T> }
		| { type: 'rejected'; result: null; name: T; params: ToolCallParams<T> }
	); // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
};


// checkpoints
export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	voidFileSnapshotOfURI: { [fsPath: string]: VibeideFileSnapshot | undefined };

	userModifications: {
		voidFileSnapshotOfURI: { [fsPath: string]: VibeideFileSnapshot | undefined };
	};
	createdAt?: number; // unix ms when checkpoint was created
	/**
	 * Git tree id of the whole working folder at checkpoint time, when one could be taken.
	 *
	 * `voidFileSnapshotOfURI` only covers files the agent edited through `editCodeService`; a build
	 * script, a `git checkout` or a `sed` in the terminal leaves no trace there. This is what lets a
	 * rollback offer to restore those too — always behind an explicit confirmation, since applying
	 * it overwrites the working tree.
	 */
	workspaceSnapshotTree?: string;
};


// Plan and Review message types for structured Agent Mode workflow
export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'paused';
export type PlanApprovalState = 'pending' | 'approved' | 'executing' | 'completed' | 'aborted';

export type PlanStep = {
	stepNumber: number;
	description: string;
	tools?: string[]; // tools that will be used
	/** When non-empty, MCP tool calls must target one of these servers (exact id, case-insensitive). */
	mcpServersAllow?: string[];
	/** When non-empty, MCP tool calls must use one of these full tool names (case-insensitive). */
	mcpToolsAllow?: string[];
	files?: string[]; // files that will be affected
	status?: StepStatus; // execution status
	checkpointIdx?: number | null; // checkpoint before this step
	toolCalls?: string[]; // tool message IDs executed for this step
	startTime?: number; // timestamp when step started
	endTime?: number; // timestamp when step ended
	error?: string; // error message if failed
	disabled?: boolean; // user disabled this step
	/** Optional: isolated git worktree branch for this step (contract: docs/references-v1/plan-worktree-branch.md). Executor wiring backlog. */
	worktreeBranch?: string;
	/** Optional: speculative exploration id (`IVibeSpeculativeExplorationService`). */
	explorationId?: string;
};

export type PlanMessage = {
	role: 'plan';
	type: 'agent_plan';
	steps: Array<PlanStep>;
	summary: string; // overall plan summary
	approvalState?: PlanApprovalState; // plan approval/execution state
	approvedAt?: number; // timestamp when plan was approved
	executionStartTime?: number; // timestamp when execution started
	/** UUID written next to `.vibe/plans/*.plan.md` artifact when approve persists to disk */
	persistedPlanId?: string;
	/** Advisory-only heuristic from IVibeLLMJudgeService when approving the plan */
	secondOpinion?: {
		readonly verdict: 'looks_ok' | 'potential_issue' | 'security_concern';
		readonly message: string;
		readonly reviewedAt: number;
	};
};

export type ReviewMessage = {
	role: 'review';
	type: 'agent_review';
	completed: boolean;
	summary: string; // what was accomplished
	issues: Array<{
		severity: 'error' | 'warning' | 'info';
		message: string;
		file?: string;
	}>;
	nextSteps?: string[]; // recommended next actions
	// Enhanced fields for comprehensive summary
	filesChanged?: Array<{
		path: string;
		changeType: 'created' | 'modified' | 'deleted';
	}>;
	executionTime?: number; // total execution time in ms
	stepsCompleted?: number; // number of steps that succeeded
	stepsTotal?: number; // total number of steps
	checkpointCount?: number; // number of checkpoints created
	lastCheckpointIdx?: number | null; // index of last checkpoint
};

/** One lead surfaced by the read-only scout: a file plus a short note on what looks unfinished there. */
export type ScoutLead = { path: string; note: string };

/**
 * Read-only scout result surfaced IN-THREAD with a confirmation gate (Vibe Agents auto-scout). The
 * scout ran BEFORE the main turn on a continuation request ("продолжи"); the user confirms the guess
 * (`proceed` → re-send the request with scout context), asks to refine (`refine` → the next message
 * is scouted again), or dismisses (`cancel`). When the scout's confidence cleared
 * `vibeide.subagent.scoutAutoProceedConfidence`, it is created already `proceeded` (non-interactive —
 * the main turn started immediately) so the user still sees what was found.
 */
export type ScoutMessage = {
	role: 'scout';
	originalRequest: string; // the continuation request the scout ran for (re-sent on 'proceed')
	leads: ScoutLead[];
	hypothesis: string;
	contextForTurn: string; // scout findings blob prepended to the main turn on 'proceed'/auto-proceed
	state: 'pending' | 'proceeded' | 'refining' | 'cancelled';
	createdAt?: number;
};

// Image attachment type for chat messages
export type ChatImageAttachment = {
	id: string; // unique identifier for this image
	data: Uint8Array; // image binary data
	mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';
	filename: string;
	width: number;
	height: number;
	size: number; // size in bytes
	uploadStatus?: 'pending' | 'uploading' | 'success' | 'failed';
	uploadProgress?: number; // 0-1 for uploading status
	error?: string; // error message if upload failed
};

// PDF attachment type for chat messages
export type ChatPDFAttachment = {
	id: string; // unique identifier for this PDF
	data: Uint8Array; // PDF binary data
	filename: string;
	size: number; // size in bytes
	pageCount?: number; // number of pages (extracted after processing)
	selectedPages?: number[]; // user-selected page numbers (1-indexed)
	uploadStatus?: 'pending' | 'uploading' | 'processing' | 'success' | 'failed';
	uploadProgress?: number; // 0-1 for uploading/processing status
	error?: string; // error message if upload failed
	extractedText?: string; // extracted text from PDF (for citations)
	pagePreviews?: string[]; // data URLs for page thumbnails
};

// A note the user queued WHILE a turn is running (drained into a real user message at the top of the
// next agent hop). Carries the typed text plus any image/PDF attachments staged at queue time.
export type PendingInjection = {
	text: string;
	images?: ChatImageAttachment[];
	pdfs?: ChatPDFAttachment[];
};

/** Одна накопленная правка: место на странице плюс словесное «что не так». */
export type EditBatchItem = {
	readonly id: string;
	/** CSS-селектор элемента — то, чем правка отличается от «поправь тут». */
	readonly selector: string;
	/** Страница, на которой элемент выбран. */
	readonly page: string;
	/** Файл-кандидат, если превью удалось сопоставить с исходником. */
	readonly file?: string;
	/** Что переделать. Пишет человек; пустое значит «пока только пометил место». */
	note: string;
};

/**
 * Пакет мелких правок, собранный кликами по превью.
 *
 * Смысл в том, чтобы не гонять агента по одной правке: десять мелочей, отправленных поштучно, —
 * это десять исследований одного и того же кода. Пакет собирается кликами (можно с телефона через
 * мост), а агент сначала читает код целиком, потом правит всё и отчитывается по каждому пункту.
 */
export type EditBatch = {
	items: EditBatchItem[];
	/** Пока true, клик прицела копит правки вместо отправки каждой в чат. */
	collecting: boolean;
};

/** Один пункт чек-листа «проверь глазами». */
export type ReviewChecklistItem = {
	readonly id: string;
	/** Что проверять — формулировкой пользователя, а не именем функции. */
	readonly text: string;
	/** Как проверить: где нажать, что должно произойти. Необязательно, но без него пункт часто нечитаем. */
	readonly how?: string;
	status: 'pending' | 'ok' | 'fail';
	/** Что именно не так — заполняется пользователем при отметке «не ок». */
	comment?: string;
};

/**
 * Чек-лист, который агент выдаёт вместо слова «сделал».
 *
 * Смысл механики в том, что закрывает задачу не агент, а проверка: «сделал» — это утверждение, а
 * отмеченный пункт — факт. Поэтому у чек-листа есть состояние отметок и он переживает перезапуск
 * вместе с тредом.
 */
export type ReviewChecklist = {
	readonly createdAtMs: number;
	/** Одной строкой: что агент считает сделанным. */
	readonly summary: string;
	items: ReviewChecklistItem[];
	/** Результат уже отправлен агенту — второй раз тот же чек-лист не досылается. */
	delivered?: boolean;
};

/**
 * Coerce persisted pending-injection entries into the current object shape. Threads saved before
 * attachments were supported stored plain strings; map those to `{ text }` so reads stay uniform.
 */
export function normalizePendingInjections(raw: readonly (string | PendingInjection)[] | undefined): PendingInjection[] {
	if (!raw) { return []; }
	return raw.map(entry => typeof entry === 'string' ? { text: entry } : entry);
}

// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
// `pinned?: boolean` (pin-context feature): HONORED by budget-fill truncation in
// convertToLLMMessageService (pinned messages are kept verbatim instead of summarized, and
// survive the local maxTurnPairs slice). The remaining piece is a SETTER — no pin UI/command
// sets it yet, so honoring is latent until that lands (roadmap pin-context, next step).
export type ChatMessage =
	| {
		role: 'user';
		content: string; // content displayed to the LLM on future calls - allowed to be '', will be replaced with (empty)
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		images?: ChatImageAttachment[]; // image attachments
		pdfs?: ChatPDFAttachment[]; // PDF attachments
		pinned?: boolean; // pin-context: honored by budget-fill truncation; setter (UI) pending
		// System-injected corrective («⚙️ Авто-продолжение…», XML-repair nudge): carries NO user
		// intent. Excluded from "user turn" counting in context-compaction windows (Step A.5 /
		// maxTurnPairs) and from retrieval heuristics (RepoIndexer query, skill matching, response
		// language detection) — otherwise consecutive nudges slide the keep-window past fresh tool
		// results and the model re-issues identical calls in circles (observed sonnet stall loop).
		isSyntheticNudge?: boolean;
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
		};
		createdAt?: number; // unix ms when message was added to thread
	} | {
		role: 'assistant';
		displayContent: string; // content received from LLM  - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking
		pinned?: boolean; // pin-context: honored by budget-fill truncation; setter (UI) pending

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
		createdAt?: number; // unix ms when message was added to thread
		// Set on the synthetic notice the agent appends when it stops in agent mode because the
		// model returned text with NO tool call (and Autopilot is off / nudge budget spent). The UI
		// hangs a one-click «Продолжить» on this message while it's the thread's last message.
		agentStoppedNoToolCall?: boolean;
	}
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry
	| PlanMessage
	| ReviewMessage
	| ScoutMessage;


// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
};


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI; // we handle serialization for this
	displayText: string;
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number;
		startColumn: number;
		endLineNumber: number;
		endColumn: number;
	} | undefined;
} | null;
