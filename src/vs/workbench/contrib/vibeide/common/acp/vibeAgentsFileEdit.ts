/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Edits of `.vibe/agents.json` that keep the person's file as they wrote it.
 *
 * The file is JSONC and people comment it — the seeded one is half commentary. Re-serialising the
 * parsed object would drop every comment and reorder what it touched, so edits are applied as text
 * patches: an added agent goes to the end of the array, an updated one changes exactly the fields an
 * update owns (`command`, `args`, `registry`) and nothing else — not the name the person gave it, not
 * its MCP servers, not its folder.
 */

import { parse } from '../../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../../base/common/jsonEdit.js';
import { FormattingOptions } from '../../../../../base/common/jsonFormatter.js';
import { VibeAgentEntry } from './vibeAgentsFile.js';

/** Tabs, like the seeded file. */
const FORMATTING: FormattingOptions = { insertSpaces: false, tabSize: 4, eol: '\n' };

/** What a new file starts with: the same shape the seeded one has, without its commentary. */
export const EMPTY_AGENTS_FILE = '{\n\t"version": 1,\n\t"agents": []\n}\n';

/** The fields an update from the registry owns; everything else in the entry is the person's. */
export type AgentUpdateFields = Pick<VibeAgentEntry, 'command' | 'args' | 'registry'>;

/**
 * Position of the agent in the raw `agents` array. Invalid entries count: they are still in the text,
 * and an index that skipped them would patch the wrong entry.
 */
export function rawAgentIndex(text: string, agentId: string): number {
	const root = parse(text) as { agents?: unknown } | undefined;
	const agents = Array.isArray(root?.agents) ? root.agents : [];
	return agents.findIndex(item => !!item && typeof item === 'object' && (item as { id?: unknown }).id === agentId);
}

/** The file with the agent appended; an absent or empty file becomes a new one. */
export function withAgentAppended(text: string | undefined, entry: VibeAgentEntry): string {
	const base = text && text.trim() ? text : EMPTY_AGENTS_FILE;
	return applyEdits(base, setProperty(base, ['agents', -1], entry, FORMATTING));
}

/** The file with the update-owned fields of one agent replaced; nothing when the agent is not in the file. */
export function withAgentUpdated(text: string, agentId: string, fields: AgentUpdateFields): string | undefined {
	const index = rawAgentIndex(text, agentId);
	if (index < 0) {
		return undefined;
	}
	let result = text;
	for (const key of ['command', 'args', 'registry'] as const) {
		result = applyEdits(result, setProperty(result, ['agents', index, key], fields[key], FORMATTING));
	}
	return result;
}
