/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isContextOverflow, parseContextOverflowError } from './sendLLMMessageTypes.js';

/** What the chat knows about a failed model call when it decides whether to ask again */
export interface LlmErrorFacts {
	/** Error text as the LLM layer reported it, before any translation */
	message: string;
	/** HTTP status the provider answered with, when it answered at all */
	httpStatus?: number;
	/** Verdict the provider put into the response body itself (`quota`, `rate-limit`) */
	refusalKind?: string;
	/** The vendor's safety filter declined the request */
	safetyRefusal: boolean;
	/** The empty-response circuit breaker tripped on this very error */
	emptyBreakerTripped: boolean;
	/** Another model may answer the turn (the Auto mode), as opposed to a model the person pinned */
	canSwitchModel: boolean;
}

/** 4xx answers that a repeat can still fix: the request timed out, collided, came too early or was throttled */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/**
 * Whether the turn is worth sending again after this error, on the same model or on the next one
 *
 * Stops at once when only the person can change the outcome
 * That is a context that does not fit, a spent quota, a safety refusal and a tripped breaker
 * Those errors also carry a recovery action in the chat, and a retry behind the person's back would hide it
 *
 * A 4xx answer is about the request itself, so the same model answers the same way
 * It stays worth asking when another model may take the turn
 *
 * Everything else is transient: an unreadable successful response, a gateway 5xx, a dropped connection
 */
export function isRetryableLlmError(facts: LlmErrorFacts): boolean {
	if (facts.safetyRefusal || facts.emptyBreakerTripped || facts.refusalKind === 'quota') {
		return false;
	}
	if (parseContextOverflowError(facts.message) || isContextOverflow(facts.message)) {
		return false;
	}
	const status = facts.httpStatus;
	const isPermanentClientError = status !== undefined && status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status);
	return facts.canSwitchModel || !isPermanentClientError;
}
