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
	/** The provider said «slow down»: a 429, or a throttling verdict buried in a body that came with a 200 */
	rateLimit: boolean;
	/** Seconds the provider asked to wait before the next request (`Retry-After`), when it sent a usable value */
	retryAfterSeconds?: number;
}

/** Where the turn stands in its attempts, and what the person configured for them */
export interface LlmRetryContext {
	/** Number of the send that just failed, counted from 1 on the model the turn is on */
	attempt: number;
	/** A local server fails fast when it is down, so its repeats start sooner */
	isLocalProvider: boolean;
	/** The visible rate-limit pause can still be taken: it is switched on, its streak is not spent and the wait fits its cap */
	rateLimitWaitAvailable: boolean;
	/** The visible rate-limit pause has already run for this thread without an answer in between */
	rateLimitPaused: boolean;
	/** `vibeide.chat.maxRetries` */
	maxRetries: number;
	/** `vibeide.chat.retryInitialDelayMs` */
	retryInitialDelayMs: number;
	/** `vibeide.chat.retryMaxDelayMs` */
	retryMaxDelayMs: number;
}

/** Why a repeat is scheduled: what the pause shows the person, and how Auto picks the next model */
export type LlmRetryCause = 'rateLimit' | 'serverError' | 'network' | 'transient';

export type LlmRetryDecision =
	/** `retryAfterTooLong`: the provider asked for a wait longer than the agent is willing to sit out */
	| { kind: 'stop'; reason: 'notRetryable' | 'retryAfterTooLong' | 'retriesSpent' }
	| { kind: 'retry'; delayMs: number; cause: LlmRetryCause; retryNumber: number; retriesPlanned: number }
	/** The visible rate-limit pause takes the turn over: it waits out the provider's window and resumes the turn itself */
	| { kind: 'autoWait' }
	/** `skipFailedProvider`: the provider is down, not the model, so its other models are no way out */
	| { kind: 'nextModel'; skipFailedProvider: boolean };

/** 4xx answers that a repeat can still fix: the request timed out, collided, came too early or was throttled */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/** The longest `Retry-After` the agent sits out itself; a longer ask ends the turn with its length said aloud */
export const MAX_RETRY_AFTER_WAIT_SECONDS = 30;

/** A 429 that names no wait gets quick repeats first, one delay per repeat, before the visible pause takes over */
const RATE_LIMIT_QUICK_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000];

/** First repeat delay of a local provider: it fails fast when it is down, so a short wait is enough */
const LOCAL_PROVIDER_FIRST_RETRY_DELAY_MS = 500;

/** The server of the provider answered with an error: the provider is down, or its upstream is */
const SERVER_ERROR_STATUSES = { from: 500, to: 599 } as const;

/** Statuses the adapter writes into its own 5xx message when the response itself carries none */
const STATUS_IN_MESSAGE = /\(HTTP (?<status>\d{3})\)/;

/** No answer came at all: the connection was refused, reset, cut or never resolved */
const NETWORK_FAILURE = /APIConnectionError|Failed to connect|fetch failed|Connection error|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang ?up|network error|getaddrinfo|\bterminated\b/i;

type LlmErrorClass = 'fatal' | 'rejected' | 'rateLimit' | 'serverError' | 'network' | 'transient';

function statusOf(facts: LlmErrorFacts): number | undefined {
	if (facts.httpStatus !== undefined) {
		return facts.httpStatus;
	}
	const fromMessage = STATUS_IN_MESSAGE.exec(facts.message)?.groups?.status;
	return fromMessage === undefined ? undefined : Number(fromMessage);
}

/**
 * `fatal`: only the person can change the outcome
 * That is a context that does not fit, a spent quota, a safety refusal and a tripped breaker
 * Those errors also carry a recovery action in the chat, and a retry behind the person's back would hide it
 *
 * `rejected`: a 4xx answer is about the request itself, so the same model answers the same way
 *
 * Everything else is transient: an unreadable successful response, a gateway 5xx, a dropped connection
 */
function classifyLlmError(facts: LlmErrorFacts): LlmErrorClass {
	if (facts.safetyRefusal || facts.emptyBreakerTripped || facts.refusalKind === 'quota') {
		return 'fatal';
	}
	if (parseContextOverflowError(facts.message) || isContextOverflow(facts.message)) {
		return 'fatal';
	}
	const status = statusOf(facts);
	if (status !== undefined && status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status)) {
		return 'rejected';
	}
	if (facts.rateLimit || status === 429) {
		return 'rateLimit';
	}
	if (status !== undefined && status >= SERVER_ERROR_STATUSES.from && status <= SERVER_ERROR_STATUSES.to) {
		return 'serverError';
	}
	return NETWORK_FAILURE.test(facts.message) ? 'network' : 'transient';
}

/**
 * What to do with a failed model call: one policy for the whole chat, so no layer under it repeats on its own
 *
 * Ends the turn at once on an error only the person can fix
 * A 429 that names no wait is repeated twice quickly, then the visible rate-limit pause takes over
 * Everything else is repeated up to the configured count with a growing delay
 * The provider's `Retry-After` raises that delay, and a longer ask than the agent sits out ends the turn
 * In the Auto mode the next model takes the turn, unless the error means the provider itself is down
 */
export function decideLlmRetry(facts: LlmErrorFacts, context: LlmRetryContext): LlmRetryDecision {
	const errorClass = classifyLlmError(facts);
	if (errorClass === 'fatal') {
		return { kind: 'stop', reason: 'notRetryable' };
	}
	if (errorClass === 'rejected') {
		// Another model may answer what this one refuses
		return facts.canSwitchModel ? { kind: 'nextModel', skipFailedProvider: false } : { kind: 'stop', reason: 'notRetryable' };
	}
	const retryAfter = facts.retryAfterSeconds;
	if (errorClass === 'rateLimit') {
		const quickDelay = retryAfter === undefined && !context.rateLimitPaused ? RATE_LIMIT_QUICK_RETRY_DELAYS_MS[context.attempt - 1] : undefined;
		if (quickDelay !== undefined && context.attempt <= context.maxRetries) {
			return {
				kind: 'retry',
				delayMs: quickDelay,
				cause: 'rateLimit',
				retryNumber: context.attempt,
				retriesPlanned: Math.min(RATE_LIMIT_QUICK_RETRY_DELAYS_MS.length, context.maxRetries),
			};
		}
		if (context.rateLimitWaitAvailable) {
			return { kind: 'autoWait' };
		}
	}
	if (facts.canSwitchModel) {
		return { kind: 'nextModel', skipFailedProvider: errorClass === 'serverError' || errorClass === 'network' };
	}
	if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_WAIT_SECONDS) {
		return { kind: 'stop', reason: 'retryAfterTooLong' };
	}
	if (context.attempt > context.maxRetries) {
		return { kind: 'stop', reason: 'retriesSpent' };
	}
	const firstDelay = context.isLocalProvider ? LOCAL_PROVIDER_FIRST_RETRY_DELAY_MS : context.retryInitialDelayMs;
	const backoffMs = Math.min(firstDelay * Math.pow(2, context.attempt - 1), context.retryMaxDelayMs);
	return {
		kind: 'retry',
		delayMs: retryAfter === undefined ? backoffMs : Math.max(retryAfter * 1000, backoffMs),
		cause: errorClass,
		retryNumber: context.attempt,
		retriesPlanned: context.maxRetries,
	};
}

/**
 * `Retry-After` as seconds: a number of seconds or an HTTP date
 * Anything else, zero and a moment already past are no usable ask
 */
export function parseRetryAfterSeconds(value: string | undefined, nowMs: number): number | undefined {
	const text = value?.trim();
	if (!text) {
		return undefined;
	}
	if (/^\d+(\.\d+)?$/.test(text)) {
		const seconds = Number(text);
		return seconds > 0 ? seconds : undefined;
	}
	const dateMs = Date.parse(text);
	if (Number.isNaN(dateMs)) {
		return undefined;
	}
	const seconds = Math.ceil((dateMs - nowMs) / 1000);
	return seconds > 0 ? seconds : undefined;
}

/** The first usable `Retry-After` among the header sets an error carries, lower-cased names as the SDK and the diagnostics give them */
export function firstRetryAfterSeconds(headerSets: ReadonlyArray<Readonly<Record<string, string>> | undefined>, nowMs: number): number | undefined {
	for (const headers of headerSets) {
		const seconds = parseRetryAfterSeconds(headers?.['retry-after'], nowMs);
		if (seconds !== undefined) {
			return seconds;
		}
	}
	return undefined;
}

/** A wait in words a person reads off a card: seconds, minutes, hours or days */
export function formatWaitDuration(seconds: number): string {
	if (seconds < 120) {
		return `${Math.round(seconds)} с`;
	}
	if (seconds < 2 * 3600) {
		return `${Math.round(seconds / 60)} мин`;
	}
	if (seconds < 48 * 3600) {
		return `${Math.round(seconds / 3600)} ч`;
	}
	return `${Math.round(seconds / 86400)} сут`;
}
