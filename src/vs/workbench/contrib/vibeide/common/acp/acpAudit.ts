/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the audit log records about a guest — an external agent that speaks ACP inside the editor.
 *
 * The guest asks before an edit and reads and writes files through us, yet its work used to reach
 * only the activity feed: a view, not a record — no hash chain, no export, no actor. The audit log
 * answers «who did what to which file» after the fact, and a guest that edits the project is exactly
 * the actor that question is about.
 *
 * The rule is the one already applied to our own agent (`toolCallAudit.ts`): arguments and command
 * lines never travel. An ACP title is written by the guest itself, and for an `execute` call it
 * usually is the command line, so an `execute` title is dropped; any other title goes through the
 * line redactor and is capped. The programmatic `name` is kept as a label only: ACP declares it
 * opaque, informational metadata that grants nothing, and nothing here decides anything by it.
 */

import { AuditEvent } from '../auditLogService.js';
import { redactStreamForAudit } from '../commandsAuditPrivacy.js';
import { AcpReconnectMode, AcpToolStatus, IAcpDiff } from './acpProtocol.js';

/** Longest guest-written text kept. Beyond this a title is a payload, not a label. */
const MAX_TEXT_LEN = 200;

/** The ACP tool kind whose title is a command line rather than a description. */
const COMMAND_TOOL_KIND = 'execute';

/** Which guest and which of its sessions an event belongs to. */
export interface IAcpAuditScope {
	/** The agent's id in `.vibe/agents.json`. */
	readonly agentId: string;
	readonly sessionId: string;
}

/** A tool call as the session log has accumulated it by the time it settled. */
export interface IAcpToolAuditInput extends IAcpAuditScope {
	readonly toolCallId: string;
	readonly title: string;
	readonly name: string;
	readonly toolKind: string;
	readonly status: AcpToolStatus;
	readonly paths: readonly string[];
	readonly diffs: readonly IAcpDiff[];
}

/**
 * How the person answered the guest.
 *
 * Read from the kind of the option picked, not from the fact that one was picked: the options are
 * the guest's own, and one of them may well mean «no». Our own «deny» button answers with a
 * cancellation, which ACP treats as a refusal of its own kind.
 */
export type AcpPermissionOutcome = 'allowed' | 'rejected' | 'cancelled' | 'selected';

export interface IAcpPermissionAuditInput extends IAcpAuditScope {
	readonly toolCallId: string;
	readonly title: string;
	readonly name: string;
	readonly toolKind: string;
	readonly paths: readonly string[];
	/** The kind of the option picked (`allow_once`, `reject_always`…); absent when refused by cancelling. */
	readonly optionKind: string | undefined;
}

export type AcpSessionPhase = 'started' | 'ended' | 'failed' | 'reconnected';

export interface IAcpSessionAuditInput extends IAcpAuditScope {
	readonly phase: AcpSessionPhase;
	readonly reconnectMode?: AcpReconnectMode;
	readonly error?: string;
}

/** A guest-written title fit for the log, or nothing when the title is a command line. */
export function auditableTitle(title: string, toolKind: string): string | undefined {
	if (!title || toolKind === COMMAND_TOOL_KIND) {
		return undefined;
	}
	return capText(title);
}

/** A settled tool call of a guest. Only `completed` and `failed` settle a call. */
export function buildAcpToolCallAudit(input: IAcpToolAuditInput, ts: number): AuditEvent {
	const title = auditableTitle(input.title, input.toolKind);
	return {
		ts,
		actor: 'guest',
		actorId: input.agentId,
		action: 'acp_tool_call',
		traceId: input.sessionId,
		toolCallId: input.toolCallId,
		ok: input.status === 'completed',
		...(input.paths.length > 0 ? { files: [...input.paths] } : {}),
		...(input.diffs.length > 0 ? { diffStats: diffStatsOf(input.diffs) } : {}),
		meta: {
			...(input.name ? { name: input.name } : {}),
			...(title ? { title } : {}),
			...(input.toolKind ? { toolKind: input.toolKind } : {}),
			status: input.status,
		},
	};
}

/** The person's answer to a guest's request: a human act, so the guest travels in `meta`. */
export function buildAcpPermissionAudit(input: IAcpPermissionAuditInput, ts: number): AuditEvent {
	const title = auditableTitle(input.title, input.toolKind);
	const outcome = permissionOutcomeOf(input.optionKind);
	return {
		ts,
		actor: 'human',
		action: 'acp_permission',
		traceId: input.sessionId,
		...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
		ok: outcome === 'allowed',
		...(input.paths.length > 0 ? { files: [...input.paths] } : {}),
		meta: {
			agentId: input.agentId,
			outcome,
			...(input.optionKind ? { optionKind: input.optionKind } : {}),
			...(input.name ? { name: input.name } : {}),
			...(title ? { title } : {}),
			...(input.toolKind ? { toolKind: input.toolKind } : {}),
		},
	};
}

/**
 * A session boundary. The person opens, closes and reconnects a session; a broken connection is
 * the guest's own event, and its error text is ours but may quote the guest, so it is redacted too.
 */
export function buildAcpSessionAudit(input: IAcpSessionAuditInput, ts: number): AuditEvent {
	const byGuest = input.phase === 'failed';
	return {
		ts,
		actor: byGuest ? 'guest' : 'human',
		...(byGuest ? { actorId: input.agentId } : {}),
		action: 'acp_session',
		traceId: input.sessionId,
		ok: !byGuest,
		meta: {
			phase: input.phase,
			...(byGuest ? {} : { agentId: input.agentId }),
			...(input.reconnectMode ? { reconnectMode: input.reconnectMode } : {}),
			...(input.error ? { error: capText(input.error) } : {}),
		},
	};
}

export function permissionOutcomeOf(optionKind: string | undefined): AcpPermissionOutcome {
	if (!optionKind) {
		return 'cancelled';
	}
	if (optionKind.startsWith('allow')) {
		return 'allowed';
	}
	if (optionKind.startsWith('reject')) {
		return 'rejected';
	}
	return 'selected';
}

/** Lines removed and added per file, as the editor journal already counts them. */
function diffStatsOf(diffs: readonly IAcpDiff[]): { linesAdded: number; linesRemoved: number; hunks: number } {
	let linesAdded = 0;
	let linesRemoved = 0;
	for (const diff of diffs) {
		linesRemoved += countLines(diff.oldText);
		linesAdded += countLines(diff.newText);
	}
	return { linesAdded, linesRemoved, hunks: diffs.length };
}

/** An empty text is zero lines: that is how creating a file and clearing one look. */
const countLines = (text: string): number => (text ? text.split('\n').length : 0);

function capText(text: string): string {
	const redacted = redactStreamForAudit(text.replace(/\s*\n\s*/g, ' ').trim());
	return redacted.length > MAX_TEXT_LEN ? `${redacted.slice(0, MAX_TEXT_LEN)}…` : redacted;
}
