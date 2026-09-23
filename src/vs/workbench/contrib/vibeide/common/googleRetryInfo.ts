/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The wait Google names inside a 429 body.
 *
 * Gemini and Vertex refuse with `RESOURCE_EXHAUSTED` and put the delay in a `google.rpc.RetryInfo` detail
 * (`"retryDelay": "57s"`) instead of a `retry-after` header — so everything downstream that reads the header
 * waits a guessed default. Sometimes the whole error arrives serialised again inside `error.message`, and
 * both layers are read.
 */

const RETRY_INFO_TYPE = 'type.googleapis.com/google.rpc.RetryInfo';

interface GoogleErrorBody {
	readonly error?: {
		readonly message?: unknown;
		readonly details?: ReadonlyArray<{ readonly '@type'?: unknown; readonly retryDelay?: unknown }>;
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		const embedded = text.match(/\{[\s\S]*\}/);
		if (!embedded) {
			return undefined;
		}
		try {
			return JSON.parse(embedded[0]);
		} catch {
			return undefined;
		}
	}
}

function delayOf(body: unknown, depth: number): number | undefined {
	const error = (body as GoogleErrorBody | undefined)?.error;
	if (!error) {
		return undefined;
	}
	for (const detail of error.details ?? []) {
		if (detail?.['@type'] === RETRY_INFO_TYPE && typeof detail.retryDelay === 'string') {
			const seconds = Number.parseFloat(detail.retryDelay);
			if (Number.isFinite(seconds) && seconds > 0) {
				return seconds;
			}
		}
	}
	// One level of nesting is what the vendor produces; more would be a loop over hostile input.
	if (depth === 0 && typeof error.message === 'string') {
		return delayOf(parseJson(error.message), depth + 1);
	}
	return undefined;
}

/** Seconds to wait, or undefined when the body names no delay. */
export function googleRetryDelaySecondsOf(body: string | undefined): number | undefined {
	if (!body) {
		return undefined;
	}
	return delayOf(parseJson(body), 0);
}
