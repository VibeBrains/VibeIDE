/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

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
	pinned?: boolean; // survives compaction in convertToLLMMessageService
} & (
		// in order of events:
		| { type: 'invalid_params', result: null, name: T, }

		| { type: 'tool_request', result: null, name: T, params: ToolCallParams<T>, }  // params were validated, awaiting user

		| { type: 'running_now', result: null, name: T, params: ToolCallParams<T>, }

		| { type: 'tool_error', result: string, name: T, params: ToolCallParams<T>, } // error when tool was running
		| { type: 'success', result: Awaited<ToolResult<T>>, name: T, params: ToolCallParams<T>, }
		| { type: 'rejected', result: null, name: T, params: ToolCallParams<T> }
	) // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
}


// checkpoints
export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	voidFileSnapshotOfURI: { [fsPath: string]: VibeideFileSnapshot | undefined };

	userModifications: {
		voidFileSnapshotOfURI: { [fsPath: string]: VibeideFileSnapshot | undefined };
	};
	createdAt?: number; // unix ms when checkpoint was created
}


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
	/** Optional: isolated git worktree branch for this step (contract: references/v1/plan-worktree-branch.md). Executor wiring backlog. */
	worktreeBranch?: string;
	/** Optional: speculative exploration id (`IVibeSpeculativeExplorationService`). */
	explorationId?: string;
}

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
}

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
}

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

// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
// `pinned?: boolean` is optional — set by the pin-context UI (compaction skips
// pinned items even when older than the user-turn threshold).
export type ChatMessage =
	| {
		role: 'user';
		content: string; // content displayed to the LLM on future calls - allowed to be '', will be replaced with (empty)
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		images?: ChatImageAttachment[]; // image attachments
		pdfs?: ChatPDFAttachment[]; // PDF attachments
		pinned?: boolean; // survives compaction
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
		}
		createdAt?: number; // unix ms when message was added to thread
	} | {
		role: 'assistant';
		displayContent: string; // content received from LLM  - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking
		pinned?: boolean; // survives compaction

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
		createdAt?: number; // unix ms when message was added to thread
	}
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry
	| PlanMessage
	| ReviewMessage


// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
}


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI, // we handle serialization for this
	displayText: string,
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number
		startColumn: number,
		endLineNumber: number
		endColumn: number,
	} | undefined
} | null
