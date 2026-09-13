/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MCPConfigFileEntryJSON } from './mcpServiceTypes.js';

/**
 * The shared memory of the VibeBrains family, offered to the agent without a hand-written entry.
 *
 * WHY discover it: the owner decided VibeIDE and VibeIDEA work with one memory. The server ships
 * with VibeMemory at a fixed place, and writing the same `mcp.json` entry by hand on every machine
 * and every profile (`~/.vibeide`, `~/.vibeide-dev`) is how a family member silently ends up without
 * it on the next laptop.
 *
 * WHY the working directory is the home folder: the server names its project by the directory it
 * was started in. Here one server process serves every window, so there is no single project to
 * start it in — and inheriting the IDE's own directory would name one nobody chose (in a dev run
 * that is the VibeIDE repository, so every note would land there whatever folder is open). The home
 * folder has no project in the store, so a write without an explicit `project` is refused rather
 * than filed in the wrong place (VibeMemory `docs/manuals/mcpServer.md`, «Проект по рабочему
 * каталогу»).
 *
 * Pure: a server map and the discovery result in, a server map out.
 */

/** The name the entry takes in the server list. A user entry with this name always wins. */
export const VIBE_MEMORY_SERVER_NAME = 'vibememory';

/** `~/.vibememory/bin/vibememory-mcp`, with `.exe` on Windows. */
export function vibeMemoryServerPathSegments(windows: boolean): readonly string[] {
	return ['.vibememory', 'bin', windows ? 'vibememory-mcp.exe' : 'vibememory-mcp'];
}

/** What the renderer found on disk: the server binary and the folder to start it in. */
export interface FoundMemoryServer {
	readonly command: string;
	readonly homeDir: string;
}

/**
 * The server map with the memory server added — unless the user already configured one under that
 * name, or nothing was found. The user's entry is never touched: an explicit configuration is a
 * decision, and a discovered default must not override it.
 */
export function withDiscoveredMemoryServer(
	servers: Readonly<Record<string, MCPConfigFileEntryJSON>>,
	found: FoundMemoryServer | undefined,
): Record<string, MCPConfigFileEntryJSON> {
	if (!found || Object.prototype.hasOwnProperty.call(servers, VIBE_MEMORY_SERVER_NAME)) {
		return { ...servers };
	}
	return {
		...servers,
		[VIBE_MEMORY_SERVER_NAME]: { command: found.command, args: ['--agent', 'vibeide'], cwd: found.homeDir },
	};
}
