/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Sanitize an LLM error for logging while OMITTING the echoed prompt payload. AI SDK errors
 * (AI_APICallError / AI_RetryError etc.) carry the full request under `requestBodyValues` /
 * `messages` / `prompt`; logging it verbatim leaks file contents and non-pattern secrets and
 * bloats the log (crash-report 2026-05-30). Diagnostic fields (name / message / reason / url /
 * statusCode / requestId) are preserved.
 *
 * Pure, dependency-free → unit-testable in isolation.
 */

/** Object keys whose values echo the prompt/request body and must never reach the log. */
export const LLM_ERROR_HEAVY_KEYS: ReadonlySet<string> = new Set([
	'requestBodyValues', 'messages', 'prompt', 'input', 'rawPrompt', 'body',
]);

export function sanitizeLlmErrorForLog(e: unknown): string {
	// Track visited objects so a circular reference (common via `cause`) degrades to a marker
	// instead of throwing and losing the entire error.
	const seen = new WeakSet<object>();
	try {
		const json = JSON.stringify(e, function (key, value) {
			if (key && LLM_ERROR_HEAVY_KEYS.has(key)) { return '[omitted: request payload]'; }
			if (value !== null && typeof value === 'object') {
				if (seen.has(value as object)) { return '[circular]'; }
				seen.add(value as object);
			}
			return value;
		});
		return json ?? '[empty LLM error]';
	} catch {
		return '[unserializable LLM error]';
	}
}
