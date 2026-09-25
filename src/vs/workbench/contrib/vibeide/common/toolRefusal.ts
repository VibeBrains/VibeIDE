/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A tool call that never ran: a guard refused it or its name was unknown.
 *
 * Such a message used to be a `tool_error` with `params: {}` under the name of a real tool.
 * The tool's card trusts that a `tool_error` carries validated params and read `params.uri.fsPath` off it —
 * the edit card, the file cards and the read-before-write check all fell over on the empty object.
 * The `refused` kind carries no params at all, so the type forbids reading them.
 */

import { ChatMessage } from './chatThreadServiceTypes.js';
import { builtinToolDefs } from './prompt/tools/index.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolName } from './toolsServiceTypes.js';

type RefusedToolMessage = ChatMessage & { role: 'tool'; type: 'refused' };

/** The message for a call a guard refused; `why` goes to the model as the call's result and to the card */
export function refusedToolMessage(input: { readonly name: ToolName | string; readonly id: string; readonly why: string; readonly rawParams?: RawToolParamsObj; readonly mcpServerName?: string }): RefusedToolMessage {
	return {
		role: 'tool',
		type: 'refused',
		// A refusal may name a tool the model made up: the name is what the model called, not a promise of a card
		name: input.name as ToolName,
		result: input.why,
		content: input.why,
		id: input.id,
		rawParams: input.rawParams ?? {},
		mcpServerName: input.mcpServerName,
	};
}

/**
 * A refusal stored before the `refused` kind existed: a `tool_error` with empty params
 * under the placeholder name `invalid` or under a built-in tool that declares params.
 * A validated call of such a tool always has at least one key, so empty params mean the call never ran.
 * A tool that declares no params validates to `{}` legitimately and is left as it is, and so is an MCP tool
 */
export function isLegacyRefusal(message: { readonly role?: unknown; readonly type?: unknown; readonly name?: unknown; readonly params?: unknown }): boolean {
	if (message.role !== 'tool' || message.type !== 'tool_error' || typeof message.name !== 'string') {
		return false;
	}
	const params = message.params;
	if (!params || typeof params !== 'object' || Object.keys(params).length > 0) {
		return false;
	}
	if (message.name === 'invalid') {
		return true;
	}
	const def = (builtinToolDefs as Record<string, { readonly params?: object } | undefined>)[message.name];
	return !!def && Object.keys(def.params ?? {}).length > 0;
}

/** The stored message in its current form: a legacy refusal becomes `refused`, anything else is returned as is */
export function withRefusalKind<T extends { readonly role?: unknown; readonly type?: unknown; readonly name?: unknown; readonly params?: unknown }>(message: T): T | Omit<T, 'params'> {
	if (!isLegacyRefusal(message)) {
		return message;
	}
	const { params: _empty, ...rest } = message;
	return { ...rest, type: 'refused' };
}
