/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../base/common/uri.js';

/** The three rule sets that close a file to the agent's reading, as their services answer. */
export interface AgentReadRules {
	/** `.vibe/ignore`. */
	readonly ignore: { isIgnored(uri: URI): boolean };
	/** `.vibe/constraints.json` — throws on a path its rules forbid. */
	readonly constraints: { checkReadAllowed(fsPath: string): void };
	/** `.vibe/permissions.json`: deny lists first, then the allow list when one is set. */
	readonly permissions: { canRead(fsPath: string): boolean };
}

/**
 * Whether the agent may read `uri` by the rules that need no disk: `.vibe/ignore`, the constraints and
 * the permissions.
 *
 * For files that come in bulk and are real files already — search results, the files of a diff. A
 * path the agent names itself goes through the tools' own gate, which also resolves symlinks; this is
 * the same answer for one name of the file, without a disk round trip per file.
 */
export function agentMayReadByRules(uri: URI, rules: AgentReadRules): boolean {
	if (rules.ignore.isIgnored(uri)) {
		return false;
	}
	try {
		rules.constraints.checkReadAllowed(uri.fsPath);
	} catch {
		return false;
	}
	return rules.permissions.canRead(uri.fsPath);
}
