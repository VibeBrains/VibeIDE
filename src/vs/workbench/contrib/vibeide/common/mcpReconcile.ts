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
 * `disabled` decides whether the server runs at all, not how: it reaches the reconciliation as the server's on/off.
 */
const NOT_PART_OF_LAUNCH: readonly string[] = ['tools', 'disabled'];

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

/** What one window wants: its entries after Config Guard and which of them its settings switch on. */
export interface WindowPicture {
	readonly entries: Readonly<Record<string, MCPConfigFileEntryJSON>>;
	readonly enabledOfName: Readonly<Record<string, boolean>>;
}

export interface UnitedPictures {
	/** The entry that runs under each wanted name */
	readonly entries: Record<string, MCPConfigFileEntryJSON>;
	/** On/off by the window whose entry runs */
	readonly enabledOfName: Record<string, boolean>;
	/** Per window: names it wants with a launch that differs from the one running, so it cannot have them */
	readonly conflictsOfWindow: Record<string, readonly string[]>;
}

/**
 * The windows' pictures as one, for the reconciliation against what runs.
 *
 * Servers are shared by every window, so a name is ONE server. Windows usually agree — they read the same user file —
 * but a project file adds servers one window has and another does not, and a project may give a name another launch.
 * The union keeps a server wanted by any window, and a name wanted two ways goes to one of them:
 * the launch that already runs, else the window that came first. The others are told, not given a second server
 * under the same name: its tools would be called from the wrong project.
 *
 * Windows are in the order they first spoke. A window's stale picture can lose a name for a moment while it catches up
 * with an edit of the user file; the conflict ends with the window's next picture.
 */
export function unitePictures(
	pictures: ReadonlyMap<string, WindowPicture>,
	runningFingerprintOfName: Readonly<Record<string, string>>,
	appsEnabled: boolean,
): UnitedPictures {
	const wantsOfName = new Map<string, { readonly window: string; readonly fingerprint: string }[]>();
	for (const [window, picture] of pictures) {
		for (const [name, entry] of Object.entries(picture.entries)) {
			const wants = wantsOfName.get(name) ?? [];
			wants.push({ window, fingerprint: mcpServerFingerprint(entry, appsEnabled) });
			wantsOfName.set(name, wants);
		}
	}
	const entries: Record<string, MCPConfigFileEntryJSON> = {};
	const enabledOfName: Record<string, boolean> = {};
	const conflicts = new Map<string, string[]>();
	for (const [name, wants] of wantsOfName) {
		const running = Object.hasOwn(runningFingerprintOfName, name) ? runningFingerprintOfName[name] : undefined;
		const holder = wants.find(want => want.fingerprint === running) ?? wants[0];
		const picture = pictures.get(holder.window)!;
		entries[name] = picture.entries[name];
		enabledOfName[name] = picture.enabledOfName[name] !== false;
		for (const want of wants) {
			if (want.fingerprint !== holder.fingerprint) {
				conflicts.set(want.window, [...(conflicts.get(want.window) ?? []), name]);
			}
		}
	}
	const conflictsOfWindow: Record<string, readonly string[]> = {};
	for (const window of pictures.keys()) {
		conflictsOfWindow[window] = conflicts.get(window) ?? [];
	}
	return { entries, enabledOfName, conflictsOfWindow };
}
