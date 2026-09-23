/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How the main process brings the running MCP clients in line with what the windows want.
 *
 * Clients live in the main process and every window shares them, so what runs there is the only truth
 * about what runs. A window states its whole picture — the entries after Config Guard and which servers
 * are on — and the main process compares it with the running set. Trusting a window's own diff started
 * every server a second time after a window reload: the reloaded window begins with nothing and calls
 * every running server «added».
 */

import { MCPConfigFileEntryJSON } from './mcpServiceTypes.js';

/** A server the main process has seen: the launch it was last set up from, and whether it runs now. */
export interface KnownMCPServer {
	readonly fingerprint: string;
	readonly running: boolean;
}

/** A server a window wants: the launch it asks for, and whether it should run at all. */
export interface WantedMCPServer {
	readonly fingerprint: string;
	readonly isOn: boolean;
}

/**
 * One server's fate:
 * - `keep` — runs as asked; nothing to launch, only its state to tell the windows;
 * - `start` — should run and does not: new, switched on, or failed before;
 * - `restart` — runs, but from another entry or with another MCP Apps capability;
 * - `off` — switched off: must not run, stays listed as offline;
 * - `remove` — gone from the config: closed if it runs, then forgotten.
 */
export type MCPServerAction = 'keep' | 'start' | 'restart' | 'off' | 'remove';

/**
 * Entry fields that do not shape the launch. `tools` is the list of tools the agent may see; the window
 * enforces it, the server process never learns it — editing it must not restart the server.
 */
const NOT_PART_OF_LAUNCH: readonly string[] = ['tools'];

/**
 * The launch an entry describes, as a comparable string.
 *
 * Key order in `mcp.json` is not a change, so keys are sorted. The MCP Apps capability belongs to the
 * launch: a client announces it once, when it connects.
 */
export function mcpServerFingerprint(entry: MCPConfigFileEntryJSON, appsEnabled: boolean): string {
	// Through JSON first: a `url` held as a URL object becomes the string it stands for.
	const launch = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
	for (const key of NOT_PART_OF_LAUNCH) {
		delete launch[key];
	}
	return JSON.stringify({ entry: withSortedKeys(launch), appsEnabled });
}

function withSortedKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(withSortedKeys);
	}
	if (value !== null && typeof value === 'object') {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = withSortedKeys((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/** What to do with every server that is known, wanted, or both. */
export function reconcileMCPServers(
	known: Readonly<Record<string, KnownMCPServer>>,
	wanted: Readonly<Record<string, WantedMCPServer>>,
): Record<string, MCPServerAction> {
	const actions: Record<string, MCPServerAction> = {};
	for (const [name, want] of Object.entries(wanted)) {
		const have = Object.hasOwn(known, name) ? known[name] : undefined;
		if (!want.isOn) {
			actions[name] = 'off';
		} else if (!have?.running) {
			actions[name] = 'start';
		} else if (have.fingerprint !== want.fingerprint) {
			actions[name] = 'restart';
		} else {
			actions[name] = 'keep';
		}
	}
	for (const name of Object.keys(known)) {
		if (!Object.hasOwn(wanted, name)) {
			actions[name] = 'remove';
		}
	}
	return actions;
}
