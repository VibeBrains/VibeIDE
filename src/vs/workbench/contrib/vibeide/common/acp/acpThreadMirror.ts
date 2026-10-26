/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What an external agent did in a turn, as messages of a chat thread
 *
 * The session log (`acpSessionLog`) glues the agent's chunks into replies and folds the frames of one call into one
 * card; the chat thread keeps messages. This is the step between: it cuts the turn's part of the log into blocks, each
 * with a stable key, so the caller adds a block the first time it sees it and rewrites it in place as the log grows
 *
 * Pure, so it is checked from `test/common/`
 */

import { ChatMessage } from '../chatThreadServiceTypes.js';
import { AcpLogEntry } from './acpSessionLog.js';

export interface IAcpMirrorBlock {
	/** The id of the block's first entry: it does not change while the block grows, so the caller can find its message */
	readonly key: string;
	/** The log entries the message is made of: a changed reference means the message has to be rewritten */
	readonly sources: readonly AcpLogEntry[];
	readonly message: ChatMessage;
}

/**
 * The blocks of `entries` from `from` on
 *
 * A thought followed by a reply is one message: the chat shows the reasoning folded above the answer, as it does for
 * its own models. A tool call, or a note, ends the pairing, so the order of what happened is the order on the screen
 */
export function mirrorAcpEntries(entries: readonly AcpLogEntry[], from: number): IAcpMirrorBlock[] {
	const blocks: IAcpMirrorBlock[] = [];
	for (let i = Math.max(0, from); i < entries.length; i++) {
		const entry = entries[i];
		switch (entry.kind) {
			case 'message': {
				const reply = entry.thought ? entries[i + 1] : undefined;
				if (entry.thought && reply?.kind === 'message' && !reply.thought) {
					blocks.push({ key: entry.id, sources: [entry, reply], message: assistantMessage(reply.text, entry.text) });
					i++;
				} else {
					blocks.push({ key: entry.id, sources: [entry], message: entry.thought ? assistantMessage('', entry.text) : assistantMessage(entry.text, '') });
				}
				break;
			}
			case 'tool':
				blocks.push({
					key: `tool:${entry.id}`,
					sources: [entry],
					message: {
						role: 'acp_tool',
						toolCallId: entry.id,
						title: entry.title,
						name: entry.name,
						toolKind: entry.toolKind,
						status: entry.status,
						paths: [...entry.paths],
						diffs: [...entry.diffs],
						output: entry.output,
						...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
					},
				});
				break;
			case 'notice':
				blocks.push({ key: entry.id, sources: [entry], message: assistantMessage(entry.text, '', true) });
				break;
			case 'acpNotice':
				blocks.push({
					key: `notice:${entry.id}`,
					sources: [entry],
					message: {
						role: 'acp_notice',
						severity: entry.severity,
						title: entry.title,
						...(entry.description === undefined ? {} : { description: entry.description }),
					},
				});
				break;
			case 'acpCompaction':
				blocks.push({
					key: `compaction:${entry.id}`,
					sources: [entry],
					message: {
						role: 'acp_compaction',
						compactionId: entry.id,
						status: entry.status,
						summary: entry.summary,
						...(entry.error === undefined ? {} : { error: entry.error }),
					},
				});
				break;
		}
	}
	return blocks;
}

/** `notice` marks a line the IDE wrote, so it is never reported outside the chat as the agent's answer */
function assistantMessage(displayContent: string, reasoning: string, notice = false): ChatMessage {
	return { role: 'assistant', displayContent, reasoning, anthropicReasoning: null, ...(notice ? { notice: true } : {}) };
}
