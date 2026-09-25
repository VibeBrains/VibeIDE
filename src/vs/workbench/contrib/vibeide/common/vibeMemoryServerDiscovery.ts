/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
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
 * каталогу»). The project a folder does write to is named by the server itself — see vibeMemoryProject.ts.
 *
 * Pure: a server map and the discovery result in, a server map out.
 */

/** The name the entry takes in the server list. A user entry with this name always wins. */
export const VIBE_MEMORY_SERVER_NAME = 'vibememory';

/** The variable VibeMemory takes its engine folder from: binaries, configuration and team tokens all live there */
export const VIBE_MEMORY_DIR_ENV = 'VIBEMEMORY_DIR';

/** The engine folder the IDE looks in */
export interface VibeMemoryEngine {
	readonly dir: URI;
	/**
	 * The variable for the programs the IDE starts from that folder, set only when the folder is not the default one
	 * They run with the IDE's own environment, and an IDE started from the Dock does not have the shell's variables:
	 * without it the helper would look for the team tokens in `~/.vibememory` while the IDE found them elsewhere
	 */
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * The engine folder: `VIBEMEMORY_DIR`, else `~/.vibememory`, as VibeMemory's own CLI names it
 * An empty variable counts as unset, as it does for the shell and for the CLI
 * A relative value is taken from the home folder, the folder the memory server is started in
 * The CLI takes it from its current folder, which the IDE's own process does not share with anyone,
 * so the programs get the resolved absolute path and never resolve it again
 */
export function vibeMemoryEngine(home: URI, override: string | undefined): VibeMemoryEngine {
	if (!override) {
		return { dir: joinPath(home, '.vibememory') };
	}
	const dir = isAbsolute(override) ? URI.file(override) : joinPath(home, override);
	return { dir, env: { [VIBE_MEMORY_DIR_ENV]: dir.fsPath } };
}

/** `bin/vibememory-mcp` in the engine folder, with `.exe` on Windows. */
export function vibeMemoryServerPathSegments(windows: boolean): readonly string[] {
	return ['bin', windows ? 'vibememory-mcp.exe' : 'vibememory-mcp'];
}

/** What the renderer found on disk: the server binary, the folder to start it in and the engine's variable. */
export interface FoundMemoryServer {
	readonly command: string;
	readonly homeDir: string;
	readonly env?: Readonly<Record<string, string>>;
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
		[VIBE_MEMORY_SERVER_NAME]: { command: found.command, args: ['--agent', 'vibeide'], cwd: found.homeDir, ...(found.env ? { env: { ...found.env } } : {}) },
	};
}

/**
 * Team memory over HTTPS, one server per team the machine was connected to (VibeMemory `vibememory connect`).
 *
 * `connect` leaves `tokens/<team>/` in the engine folder with the token itself, a ready `mcp.json` fragment and a sidecar
 * without the token. Only the sidecar is read: the fragment carries the token in plain text, and copying it into our
 * configuration is exactly what the helper exists to avoid. The header is asked of `vibememory mcp-headers` each time
 * the client connects, so a token re-issued in the cabinet is picked up by a reconnect, not by an edit.
 */

/** Team servers are named `vibememory-<team>`, as VibeMemory names them in its own fragment */
export const VIBE_MEMORY_TEAM_SERVER_PREFIX = 'vibememory-';

/** Where `connect` puts a team's files: `tokens/<team>/` in the engine folder */
export const VIBE_MEMORY_TOKENS_FOLDER = 'tokens';

/** The sidecar this agent reads in a team's folder */
export const VIBE_MEMORY_TEAM_SIDECAR = 'vibeide.json';

/** `bin/vibememory` in the engine folder, with `.exe` on Windows — the helper that prints a team's header */
export function vibeMemoryHelperPathSegments(windows: boolean): readonly string[] {
	return ['bin', windows ? 'vibememory.exe' : 'vibememory'];
}

/** The helper found on disk and the engine's variable it has to run with */
export interface FoundHeadersHelper {
	readonly command: string;
	readonly env?: Readonly<Record<string, string>>;
}

/** A team this machine is connected to, as its sidecar says */
export interface FoundTeamServer {
	readonly team: string;
	readonly url: string;
	/** The token's id: a reconnect in the cabinet issues a new one, and the running client must ask the helper again */
	readonly tokenId?: string;
}

/** VibeMemory's rule for a team's name: lowercase Latin letters, digits and hyphens, up to 63 */
const TEAM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A team from its folder name and its sidecar text; a reason instead when the sidecar is not one to trust
 * The address must be https — plain http only to this machine, which is how a local test server is reached
 */
export function teamServerOfSidecar(folder: string, text: string): FoundTeamServer | { readonly skipped: string } {
	if (!TEAM_NAME.test(folder)) {
		return { skipped: `имя команды «${folder}» не по правилу VibeMemory` };
	}
	let sidecar: { team?: unknown; agent?: unknown; mcpUrl?: unknown; tokenId?: unknown };
	try {
		sidecar = JSON.parse(text);
	} catch {
		return { skipped: `${folder}/${VIBE_MEMORY_TEAM_SIDECAR} — не JSON` };
	}
	if (sidecar?.agent !== 'vibeide') {
		return { skipped: `${folder}/${VIBE_MEMORY_TEAM_SIDECAR} выдан не этому агенту` };
	}
	if (sidecar.team !== undefined && sidecar.team !== folder) {
		return { skipped: `${folder}/${VIBE_MEMORY_TEAM_SIDECAR} называет другую команду` };
	}
	let url: URL;
	try {
		url = new URL(String(sidecar.mcpUrl ?? ''));
	} catch {
		return { skipped: `у команды «${folder}» нет адреса сервера (mcpUrl)` };
	}
	const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		return { skipped: `адрес сервера команды «${folder}» не https` };
	}
	return { team: folder, url: url.toString(), ...(typeof sidecar.tokenId === 'string' && sidecar.tokenId ? { tokenId: sidecar.tokenId } : {}) };
}

/**
 * The server map with a server for each team added: HTTP, the header from the helper, never a literal token
 * A user entry with the same name wins, as for the local memory server
 */
export function withDiscoveredTeamServers(
	servers: Readonly<Record<string, MCPConfigFileEntryJSON>>,
	teams: readonly FoundTeamServer[],
	helper: FoundHeadersHelper | undefined,
): Record<string, MCPConfigFileEntryJSON> {
	const out = { ...servers };
	if (!helper) {
		return out;
	}
	for (const { team, url, tokenId } of teams) {
		const name = `${VIBE_MEMORY_TEAM_SERVER_PREFIX}${team}`;
		if (Object.prototype.hasOwnProperty.call(out, name)) {
			continue;
		}
		out[name] = { type: 'http', url, headersHelper: { command: helper.command, args: ['mcp-headers', team, 'vibeide'], ...(helper.env ? { env: { ...helper.env } } : {}), ...(tokenId ? { revision: tokenId } : {}) } };
	}
	return out;
}
