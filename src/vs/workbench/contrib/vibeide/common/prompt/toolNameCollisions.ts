/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InternalToolInfo } from './prompts.js';

/**
 * Что делать, когда MCP-сервер объявил инструмент с именем встроенного.
 *
 * The list handed to a model is a plain concatenation of built-ins and whatever MCP contributes, so
 * a server offering its own `read_file` puts two tools of one name into one request. Strict
 * providers reject the whole payload for that — «two identical tool names in one request is a hard
 * 400, strictly worse than the bug being fixed», as Hermes Agent puts it (Apache-2.0,
 * NousResearch/hermes-agent, `anthropic_adapter.py`). Permissive ones accept it and then dispatch to
 * whichever the model meant, which is worse: an MCP server would silently take over `edit_file`.
 *
 * The rule is therefore the same one Hermes settled on — **the registered tool wins** — with the
 * newcomer renamed rather than dropped. Dropping it would leave the user with a server they
 * installed and cannot call; renaming keeps it reachable and says so.
 *
 * This matters most on a HOT connect: a server added mid-session brings its names into a list the
 * model has already been using, and a silent shadowing of `run_command` is not a thing to discover
 * from behaviour.
 */

export interface ToolCollision {
	/** Name the server asked for, which a built-in already owns. */
	readonly requested: string;
	/** Name it was given instead. */
	readonly renamed: string;
	/** Which server it came from, when known — the user needs to know whom to ask about it. */
	readonly serverName?: string;
}

export interface CollisionResult {
	readonly tools: InternalToolInfo[];
	readonly collisions: ToolCollision[];
}

/**
 * Suffix for a renamed MCP tool.
 *
 * Readable rather than clever: a model reading `read_file_mcp` can still tell what it does, and a
 * person reading a transcript can tell why the name is odd.
 */
function renameFor(name: string, taken: ReadonlySet<string>): string {
	const base = `${name}_mcp`;
	if (!taken.has(base)) {
		return base;
	}
	// Two servers claiming the same built-in name is rare and still has to resolve deterministically.
	for (let index = 2; index < 100; index++) {
		const candidate = `${base}${index}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
	return `${base}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve name collisions between built-in tools and everything else.
 *
 * Built-ins keep their names; a contributed tool that collides is renamed and reported. Order is
 * preserved, because the tool list is ordered on purpose (see `toolBudget.ts`).
 */
export function resolveToolNameCollisions(
	tools: readonly InternalToolInfo[],
	builtinNames: ReadonlySet<string>,
	serverNameOf?: (tool: InternalToolInfo) => string | undefined,
): CollisionResult {
	const collisions: ToolCollision[] = [];
	const out: InternalToolInfo[] = [];
	// Every name already spoken for. Seeded with the built-ins so the rule needs no second thought:
	// a name a built-in owns is taken before the loop starts, whether or not that built-in is in
	// this particular list.
	const taken = new Set<string>(builtinNames);
	// Built-ins pass through untouched, so they are recognised by identity of name rather than by
	// looking back at what has already been decided.
	const seenBuiltins = new Set<string>();

	for (const tool of tools) {
		if (builtinNames.has(tool.name) && !seenBuiltins.has(tool.name)) {
			// The built-in itself, on its first appearance: it keeps its name by definition.
			seenBuiltins.add(tool.name);
			out.push(tool);
			continue;
		}
		if (!taken.has(tool.name)) {
			out.push(tool);
			taken.add(tool.name);
			continue;
		}
		const renamed = renameFor(tool.name, taken);
		taken.add(renamed);
		collisions.push({ requested: tool.name, renamed, serverName: serverNameOf?.(tool) });
		// The description carries the original name: the model is told what the server calls it, so a
		// prompt written against the server's own documentation still lands.
		out.push({
			...tool,
			name: renamed,
			description: `${tool.description}\n\n(Этот инструмент называется «${tool.name}» на своём сервере; здесь переименован, потому что это имя занято встроенным инструментом VibeIDE.)`,
		});
	}

	return { tools: out, collisions };
}
