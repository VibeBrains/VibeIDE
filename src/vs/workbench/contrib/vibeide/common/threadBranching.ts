/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a branched thread may be cut.
 *
 * Branching exists to drop a tail that went wrong without retyping the task, so the copy has to
 * be a history the model can actually continue. A prefix that ends mid tool-cycle is not: a tool
 * call whose result never arrives leaves the next request describing something that never
 * happened, and providers reject or hallucinate around it.
 *
 * Pure on purpose — the rule is worth testing without a thread, a store or a provider.
 */

/** The little that matters about a message when choosing a cut. */
export interface BranchMessageShape {
	readonly role: 'user' | 'assistant' | 'tool' | 'checkpoint' | 'interrupted_streaming_tool';
	/** For tool messages: where in its lifecycle the call is. */
	readonly type?: string;
}

/** Tool states that mean "the call is still open" — a prefix must never end on one. */
const UNFINISHED_TOOL_TYPES = new Set(['tool_request', 'running_now']);

/**
 * Last index to include when branching at `messageIdx`, or `undefined` when nothing can be kept.
 *
 * The requested index is honoured whenever it is a valid end; otherwise the cut walks BACKWARDS
 * to the nearest one. Walking forward would silently include the very messages the user is
 * branching away from.
 */
export function resolveBranchCutoff(messages: readonly BranchMessageShape[], messageIdx: number): number | undefined {
	if (!messages.length) {
		return undefined;
	}
	let index = Math.min(messageIdx, messages.length - 1);
	while (index >= 0) {
		const message = messages[index];
		const isOpenTool = message.role === 'tool' && UNFINISHED_TOOL_TYPES.has(message.type ?? '');
		// A dangling "streaming tool got interrupted" marker is decorative on its own: kept as the
		// last message it describes a call the history no longer contains.
		const isDanglingMarker = message.role === 'interrupted_streaming_tool';
		// A checkpoint is a file snapshot, not conversation — ending on one gives the model a
		// history whose last turn says nothing.
		const isCheckpoint = message.role === 'checkpoint';
		if (!isOpenTool && !isDanglingMarker && !isCheckpoint) {
			return index;
		}
		index -= 1;
	}
	return undefined;
}
