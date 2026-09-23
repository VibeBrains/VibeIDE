/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a provider file patching a BUILT-IN provider (same `id`) declares about the wire, merged into that
 * built-in's settings at send time — the same fields a provider defined in a file gets.
 *
 * Only per-model declarations: a file's provider-wide `protocol` is its default wire, and for a built-in the
 * catalogue's per-model knowledge is sharper (OpenCode Zen's file says `openai` while Zen serves Claude over
 * `/messages`). A model's own `protocol` is an explicit contract and wins, as `promptCacheKey` does.
 */
export interface BuiltinWireHints {
	readonly modelProtocols?: Readonly<Record<string, string>>;
	readonly promptCacheKey?: boolean;
}

/**
 * Settings for one send, with each patched built-in's entry extended by its hints. Merged into the entry,
 * never replacing it: the key and the endpoint stay the built-in's. Returns the input itself when there is
 * nothing to add, so the common case costs no copy.
 */
export function withBuiltinWireHints<T extends object>(settingsOfProvider: T, hints: Readonly<Record<string, BuiltinWireHints>>): T {
	const ids = Object.keys(hints).filter(id => Object.hasOwn(settingsOfProvider, id));
	if (ids.length === 0) {
		return settingsOfProvider;
	}
	const merged: Record<string, unknown> = {};
	for (const [id, value] of Object.entries(settingsOfProvider)) {
		merged[id] = value;
	}
	for (const id of ids) {
		merged[id] = { ...(merged[id] as object), ...hints[id] };
	}
	return merged as T;
}
