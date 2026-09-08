/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toolCallTargetPath } from '../toolCallAudit.js';

/**
 * След недавних вызовов инструментов — то, что хук видит кроме текущего вызова.
 *
 * WHY: a hook used to judge one call in a vacuum, and the dangerous shapes are not single calls.
 * «Read `.env`» is ordinary. «Run a command» is ordinary. «Read `.env`, then run a command that
 * talks to the network» is exfiltration, and no per-call rule can tell the difference — by the time
 * the second call arrives, the first is gone.
 *
 * Handing the hook the recent sequence moves that judgement to where it can be made, without us
 * inventing a rule language: the project writes the rule in whatever it likes, and the exit code
 * still decides. What travels is the shape of the sequence — tool names and target paths — never
 * arguments, command lines or file contents, exactly as the audit log already decided.
 */

/** One remembered call. `path` is absent for command-shaped tools, whose target is a command line. */
export interface ToolTrailEntry {
	readonly tool: string;
	readonly at: number;
	readonly path?: string;
	/** MCP server the tool came from, when it is not a built-in — origin matters to a rule. */
	readonly server?: string;
}

/** What the hook receives: the same entry with age instead of an absolute clock. */
export interface ToolTrailView {
	readonly tool: string;
	readonly secondsAgo: number;
	readonly path?: string;
	readonly server?: string;
}

/**
 * How far the trail reaches, in calls and in time.
 *
 * Both are settings (`vibeide.hooks.trailLength` / `vibeide.hooks.trailMinutes`) rather than
 * constants: how long a chain a project needs to describe is a property of that project's rules,
 * and the right expiry depends on how long its turns run. The defaults below are what the service
 * passes when configuration says nothing — long enough to hold a real sequence (read, transform,
 * send), short enough that the payload stays a payload and yesterday's read is not today's evidence.
 */
export interface TrailLimits {
	readonly length: number;
	readonly ttlMs: number;
}

export const DEFAULT_TRAIL_LIMITS: TrailLimits = { length: 20, ttlMs: 30 * 60 * 1000 };

/**
 * Append a call to the trail, returning the new trail.
 *
 * Pure on purpose: the trail is state, but deciding what the state becomes is not, and this is the
 * half worth testing. Entries older than the TTL are dropped on the way in, so a long idle period
 * cannot leave stale evidence behind.
 */
export function recordToolCall(
	trail: readonly ToolTrailEntry[],
	call: { readonly toolName: string; readonly params: Readonly<Record<string, unknown>> | undefined; readonly mcpServerName?: string },
	now: number,
	limits: TrailLimits = DEFAULT_TRAIL_LIMITS,
): ToolTrailEntry[] {
	const path = toolCallTargetPath({ toolName: call.toolName, params: call.params, mcpServerName: call.mcpServerName });
	const entry: ToolTrailEntry = {
		tool: call.toolName,
		at: now,
		...(path ? { path } : {}),
		...(call.mcpServerName ? { server: call.mcpServerName } : {}),
	};
	if (limits.length <= 0) {
		// The trail is switched off: keep nothing rather than keeping a list nobody will be shown.
		return [];
	}
	const fresh = trail.filter(e => now - e.at <= limits.ttlMs);
	return [...fresh, entry].slice(-limits.length);
}

/**
 * The trail as a hook sees it: oldest first, ages in seconds.
 *
 * Seconds rather than timestamps because a rule asks «did this happen just now», and answering that
 * from an absolute clock means every hook re-implements the subtraction — differently.
 */
export function trailView(trail: readonly ToolTrailEntry[], now: number, limits: TrailLimits = DEFAULT_TRAIL_LIMITS): ToolTrailView[] {
	return trail
		.filter(e => now - e.at <= limits.ttlMs)
		.map(e => ({
			tool: e.tool,
			secondsAgo: Math.max(0, Math.round((now - e.at) / 1000)),
			...(e.path ? { path: e.path } : {}),
			...(e.server ? { server: e.server } : {}),
		}));
}
