/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { MCP_FILE_NAME, MCP_MIGRATED_SUFFIX, McpFileProblemCode, parseMcpRoot, planMcpMigration, readMcpServersSection } from './mcpServersFile.js';

/**
 * Moving the servers of the old per-product file into the shared one.
 *
 * VibeIDE used to keep its servers in `~/<dataFolderName>/mcp.json` while VibeIDEA read `.vibe/mcp.json`.
 * The order is what keeps the person's servers safe:
 * the shared file is written FIRST and the old one renamed after, so a failure in between loses nothing —
 * the old file is still there, and the next start finds every moved name already in place.
 * The old file is renamed, never deleted: it holds the entries a conflict left behind.
 *
 * The file system is behind [McpMigrationIo], so the order is tested without one.
 */

export interface McpMigrationIo {
	exists(resource: URI): Promise<boolean>;
	read(resource: URI): Promise<string>;
	write(resource: URI, text: string): Promise<void>;
	move(from: URI, to: URI): Promise<void>;
}

export type McpMigrationOutcome =
	/** No old file: nothing to do */
	| { readonly kind: 'none' }
	/** The old file does not parse; it stays where it is and nothing is moved */
	| { readonly kind: 'legacyUnreadable'; readonly problem: McpFileProblemCode }
	/** The shared file exists but is not JSON; writing over it would lose what is in it */
	| { readonly kind: 'sharedUnreadable' }
	/** Done. `moved` and `conflicts` both empty means the old file held nothing the shared one lacked */
	| { readonly kind: 'migrated'; readonly moved: readonly string[]; readonly conflicts: readonly string[]; readonly keptAs: string }
	| { readonly kind: 'failed'; readonly error: unknown };

export async function migrateLegacyMcpFile(io: McpMigrationIo, legacy: URI, shared: URI): Promise<McpMigrationOutcome> {
	try {
		if (!await io.exists(legacy)) {
			return { kind: 'none' };
		}
		const legacyRead = readMcpServersSection(await io.read(legacy));
		if (legacyRead.kind === 'problem') {
			return { kind: 'legacyUnreadable', problem: legacyRead.problem };
		}
		const sharedExists = await io.exists(shared);
		let sharedRoot: Record<string, unknown> | undefined;
		if (sharedExists) {
			sharedRoot = parseMcpRoot(await io.read(shared));
			if (!sharedRoot) {
				return { kind: 'sharedUnreadable' };
			}
		}
		const plan = planMcpMigration(legacyRead.section, sharedRoot);
		if (plan.moved.length > 0 || !sharedExists) {
			await io.write(shared, JSON.stringify(plan.root, null, 2));
		}
		return { kind: 'migrated', moved: plan.moved, conflicts: plan.conflicts, keptAs: await moveAside(io, legacy) };
	} catch (error) {
		return { kind: 'failed', error };
	}
}

/** Rename the old file to `mcp.json.migrated`, or to a name nothing holds yet; returns the new file name */
async function moveAside(io: McpMigrationIo, legacy: URI): Promise<string> {
	let target = joinPath(dirname(legacy), MCP_FILE_NAME + MCP_MIGRATED_SUFFIX);
	for (let n = 2; await io.exists(target); n++) {
		target = joinPath(dirname(legacy), `${MCP_FILE_NAME}${MCP_MIGRATED_SUFFIX}-${n}`);
	}
	try {
		await io.move(legacy, target);
	} catch (error) {
		// Another window got there first: the file is gone, which is what was asked for
		if (await io.exists(legacy)) {
			throw error;
		}
	}
	return basename(target);
}
