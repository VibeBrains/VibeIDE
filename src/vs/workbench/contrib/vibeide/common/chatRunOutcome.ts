/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How an agent run looks from outside the chat:
 * Is it still going, does it wait for a person, how did it end, and what did it answer
 *
 * Callers with no person at the chat — the HTTP API, the Telegram bridge — need one honest answer to «is it over»
 * The stream state alone cannot give it:
 * A cleared state also means «waiting out a rate limit» or «about to re-send the turn»
 * And the run promise settles after the last state change, not with it
 *
 * So the answer is built from the run promise (is anything still in flight) plus the state it left behind
 * It is kept here, pure, because every branch of it is a case someone can hit from a phone or a CI job
 */

import type { ChatMessage } from './chatThreadServiceTypes.js';

/** Where a run stands, as an outside caller sees it */
export type ChatRunPhase = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'aborted';

/** Phases after which nothing happens without a new request */
export function isTerminalRunPhase(phase: ChatRunPhase): boolean {
	return phase === 'completed' || phase === 'failed' || phase === 'aborted';
}

/** What the chat service can tell about a thread at one moment */
export interface ChatRunObservation {
	/** A run of the thread, or a scheduled automatic re-run of its turn, has not settled yet */
	readonly inFlight: boolean;
	/** The last run was stopped by a person (stop button, /stop, refused approval) and nothing started since */
	readonly aborted: boolean;
	/**
	 * The thread's `isRunning` value
	 * Kept as a string so this layer does not depend on the browser-side state type
	 */
	readonly isRunning: string | undefined;
	/** The stream state carries an error */
	readonly hasError: boolean;
	/** The run is waiting out a provider rate limit and resumes by itself */
	readonly paused: boolean;
}

/**
 * The phase a run is in
 *
 * Nothing is terminal while a run is in flight: its last state change comes before its promise settles
 * Between the two the thread may still write a checkpoint or schedule a re-run
 * An active state without a run in flight is still «running»:
 * The watcher waits for the next change rather than guess an end the IDE never announced
 */
export function deriveRunStatus(observation: ChatRunObservation): ChatRunPhase {
	if (observation.inFlight) {
		return observation.isRunning === 'awaiting_user' ? 'awaiting_approval' : 'running';
	}
	if (observation.aborted) {
		return 'aborted';
	}
	if (observation.hasError) {
		return 'failed';
	}
	if (observation.paused) {
		return 'running';
	}
	if (observation.isRunning === 'awaiting_user') {
		return 'awaiting_approval';
	}
	// 'idle' parks a thread between calls of a turn; with no run in flight nothing will pick it up again
	if (observation.isRunning === undefined || observation.isRunning === 'idle') {
		return 'completed';
	}
	return 'running';
}

/** The answer a run gave, possibly cut to a size limit */
export interface ChatRunAnswer {
	readonly text: string;
	readonly truncated: boolean;
}

/**
 * The run's answer: the last assistant message written since the run started
 *
 * Service notices (finish reasons, cache misses, check reports) are assistant messages too:
 * They carry `notice` and are skipped, or the newest of them would pose as the answer
 * A message without `createdAt` predates the stamp and cannot be placed in time, so it is never taken
 * `maxChars` cuts the text without splitting a surrogate pair; `Infinity` keeps it whole
 */
export function pickFinalAnswer(messages: readonly ChatMessage[], sinceMs: number, maxChars: number): ChatRunAnswer | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'assistant' || message.notice || message.createdAt === undefined || message.createdAt < sinceMs) {
			continue;
		}
		if (message.displayContent.trim().length === 0) {
			continue;
		}
		return cutAnswer(message.displayContent, maxChars);
	}
	return undefined;
}

function cutAnswer(text: string, maxChars: number): ChatRunAnswer {
	if (!(text.length > maxChars)) {
		return { text, truncated: false };
	}
	let end = Math.max(0, Math.floor(maxChars));
	const last = text.charCodeAt(end - 1);
	// A high surrogate at the cut would leave half a character that JSON encodes as an invalid escape
	if (end > 0 && last >= 0xD800 && last <= 0xDBFF) {
		end -= 1;
	}
	return { text: text.slice(0, end), truncated: true };
}

/**
 * Agent runs in flight, per thread
 *
 * A run is not one promise:
 * An automatic re-send of the turn (stall, rate limit, tool-format downgrade) starts from a timer after it returned
 * Every such piece is tracked here, and the thread counts as settled only when none is left
 */
export class ThreadRunTracker {

	private readonly _inFlight = new Map<string, Set<Promise<unknown>>>();

	track(threadId: string, run: Promise<unknown>): void {
		let runs = this._inFlight.get(threadId);
		if (!runs) {
			runs = new Set();
			this._inFlight.set(threadId, runs);
		}
		runs.add(run);
		const release = () => {
			const current = this._inFlight.get(threadId);
			if (!current) {
				return;
			}
			current.delete(run);
			if (current.size === 0) {
				this._inFlight.delete(threadId);
			}
		};
		// Bookkeeping only: the rejection still belongs to whoever started the run
		run.then(release, release);
	}

	isInFlight(threadId: string): boolean {
		return this._inFlight.has(threadId);
	}

	/**
	 * Resolves once nothing is in flight for the thread
	 * Loops because a piece may start another one before it settles — a re-run scheduled from inside a run
	 */
	async whenSettled(threadId: string): Promise<void> {
		for (let runs = this._inFlight.get(threadId); runs; runs = this._inFlight.get(threadId)) {
			await Promise.allSettled([...runs]);
		}
	}
}
