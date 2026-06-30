/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Hard-pin predicate for budget-fill truncation (roadmap 3074 guidelines pin + 3075 skill pin).
 *
 * Two kinds of explicitly-invoked context must NEVER be truncated, or the model loses the
 * instructions the user just asked it to follow:
 *
 *  - **Workspace guidelines** — `<workspace_guidelines>` block, carried in the SYSTEM message.
 *  - **Expanded `/skill:` bodies** — `<skill_invocation>` block, PREPENDED to the last USER
 *    message (deliberately not buried in the system prompt — models ignore skill bodies placed
 *    in system context; see model-stalls.md #002). So the pin must apply to `user` messages too.
 *
 * 3075 bug this fixes: the old check only matched `role === 'system'` AND a marker string
 * (`"Explicitly invoked Agent Skills"`) that is never actually emitted — the real marker is
 * `<skill_invocation>`. With no workspace guidelines present, the skill body sat unpinned in a
 * user turn (weight ×1) and `safetyTrim` chopped it down to `TRIM_TO_LEN`, dropping the procedure.
 *
 * Pure & generic over `{ role, content }` so it unit-tests without the conversion service's imports.
 */

export interface PinnableContextMessage {
	readonly role: string;
	readonly content: unknown;
}

const WORKSPACE_GUIDELINES_MARKER = '<workspace_guidelines';
const SKILL_INVOCATION_MARKER = '<skill_invocation';

export function isPinnedContextMessage(message: PinnableContextMessage): boolean {
	// Guidelines live in the system message; skill bodies are prepended to a user message.
	// No other role carries these blocks, so restrict to system|user (a tool result that
	// happens to echo the literal text must not accidentally become untrimmable).
	if (message.role !== 'system' && message.role !== 'user') {
		return false;
	}
	const c = typeof message.content === 'string' ? message.content : '';
	return c.includes(WORKSPACE_GUIDELINES_MARKER) || c.includes(SKILL_INVOCATION_MARKER);
}
