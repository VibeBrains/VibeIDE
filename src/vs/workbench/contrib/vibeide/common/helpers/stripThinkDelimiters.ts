/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Strip ORPHAN reasoning-delimiter tags that leak into the content channel.
 *
 * Native-reasoning models routed through aggregators (OpenRouter, OpenCode Zen/Go, …) deliver the
 * chain-of-thought on a dedicated `reasoning` stream but sometimes ALSO emit a lone `</think>` (the
 * boundary marker between thinking and answer) into `content` — with no matching `<think>`. Neither
 * `extractReasoningWrapper` (needs the opener) nor `stripThinkBlocks` (needs a full pair) removes it,
 * so it shows up verbatim in the answer AND is persisted into the saved turn, where it is replayed to
 * the model next request as confusing noise in its own prior message.
 *
 * We only remove a tag that occupies its OWN line (optionally padded by spaces/tabs). A legitimate
 * inline mention of the literal text in prose or code is never on a bare line, so it is left intact.
 * Pure / deterministic — unit-tested in test/common.
 */

// A whole line that is nothing but a reasoning delimiter: <think>, </think>, <thinking>, </thinking>.
const THINK_DELIMITER_LINE_RE = /^[ \t]*<\/?think(?:ing)?>[ \t]*$/i;

export function stripStandaloneThinkDelimiters(text: string): string {
	// Fast path: the vast majority of chunks contain no think delimiter at all.
	if (text.indexOf('<') === -1 || !/<\/?think/i.test(text)) { return text; }

	const lines = text.split('\n');
	let removed = false;
	const kept: string[] = [];
	for (const line of lines) {
		if (THINK_DELIMITER_LINE_RE.test(line)) { removed = true; continue; }
		kept.push(line);
	}
	return removed ? kept.join('\n') : text;
}
