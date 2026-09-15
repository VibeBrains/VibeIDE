/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LLMChatMessage } from './sendLLMMessageTypes.js';

/**
 * Signatures of model reasoning that must travel back with a tool call.
 *
 * WHY: Gemini 3 signs the reasoning behind a function call and requires the signature on that call in
 * the next turn («MUST always resend all thought blocks», ai.google.dev/gemini-api/docs/thinking). We
 * rebuild the history from our own thread, so the signature has to be kept on the turn and put back on
 * the call. Every other model must not see it: an unknown field inside a tool block can be refused.
 *
 * Pure: wire shapes in, wire shapes out.
 */

function nonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The signature on the first part of a Gemini response that carries a function call. */
export function signatureOfFunctionCallParts(parts: readonly unknown[] | undefined): string | undefined {
	for (const part of parts ?? []) {
		const record = part && typeof part === 'object' ? part as { functionCall?: unknown; thoughtSignature?: unknown } : undefined;
		if (record?.functionCall !== undefined) {
			const signature = nonEmpty(record.thoughtSignature);
			if (signature) {
				return signature;
			}
		}
	}
	return undefined;
}

/** The signature `@ai-sdk/google` reports on a tool-call part (`providerMetadata.google.thoughtSignature`). */
export function googleThoughtSignatureOf(providerMetadata: unknown): string | undefined {
	const google = providerMetadata && typeof providerMetadata === 'object' ? (providerMetadata as { google?: unknown }).google : undefined;
	return google && typeof google === 'object' ? nonEmpty((google as { thoughtSignature?: unknown }).thoughtSignature) : undefined;
}

/** Provider options that hand the signature back to `@ai-sdk/google` on a tool-call part of the history. */
export function googleThoughtSignatureOptions(signature: unknown): { providerOptions?: { google: { thoughtSignature: string } } } {
	const value = nonEmpty(signature);
	return value ? { providerOptions: { google: { thoughtSignature: value } } } : {};
}

/** The history without signatures, for a model that does not require them. Messages without one are returned as they are. */
export function withoutThoughtSignatures<T extends LLMChatMessage[] | unknown>(messages: T): T {
	if (!Array.isArray(messages)) {
		return messages;
	}
	return messages.map(message => {
		if (!message || typeof message !== 'object') {
			return message;
		}
		const content = (message as { content?: unknown }).content;
		const parts = (message as { parts?: unknown }).parts;
		const signed = (block: unknown) => !!block && typeof block === 'object' && (block as { thoughtSignature?: unknown }).thoughtSignature !== undefined;
		const strip = (blocks: unknown[]) => blocks.map(block => {
			if (signed(block)) {
				const { thoughtSignature: _dropped, ...rest } = block as Record<string, unknown>;
				return rest;
			}
			return block;
		});
		if (Array.isArray(content) && content.some(signed)) {
			return { ...message, content: strip(content) };
		}
		if (Array.isArray(parts) && parts.some(signed)) {
			return { ...message, parts: strip(parts) };
		}
		return message;
	}) as T;
}
