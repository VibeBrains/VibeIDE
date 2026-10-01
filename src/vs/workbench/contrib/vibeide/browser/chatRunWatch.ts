/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ChatRunAnswer, ChatRunPhase, deriveRunStatus, isTerminalRunPhase, pickFinalAnswer } from '../common/chatRunOutcome.js';
import { IChatThreadService } from './chatThreadService.js';

/** How a watched run ended */
export interface ChatRunOutcome {
	readonly phase: ChatRunPhase;
	readonly answer?: ChatRunAnswer;
	readonly error?: string;
}

export interface ChatRunWatchOptions {
	/** When the run was requested; only answers written since then belong to it */
	readonly sinceMs: number;
	/** Longest answer to return, in characters */
	readonly answerCap: number;
	/** Every non-terminal phase the run enters, once per change */
	readonly onPhase?: (phase: ChatRunPhase) => Promise<void> | void;
	readonly token: CancellationToken;
}

/**
 * Follow a thread's run until it ends, for callers outside the chat (HTTP API, Telegram bridge)
 *
 * The end is the run settling, not a cleared stream state:
 * A cleared state also means a rate-limit pause or a turn about to be re-sent
 * A run waiting for approval has settled but is not over: the approval starts the next leg
 * So the watch waits for the thread to change and follows that leg too
 * Resolves `undefined` when cancelled: the caller stopped caring, and there is no outcome to report
 */
export async function watchChatRun(chat: IChatThreadService, threadId: string, options: ChatRunWatchOptions): Promise<ChatRunOutcome | undefined> {
	let lastPhase: ChatRunPhase | undefined;
	while (!options.token.isCancellationRequested) {
		await raceCancellation(chat.whenRunSettled(threadId), options.token);
		if (options.token.isCancellationRequested) {
			return undefined;
		}
		const thread = chat.state.allThreads[threadId];
		if (!thread) {
			return { phase: 'failed', error: localize('vibeide.chatRunWatch.threadDeleted', 'Сессия удалена') };
		}
		const state = chat.streamState[threadId];
		const phase = deriveRunStatus({
			inFlight: chat.isRunInFlight(threadId),
			aborted: chat.wasRunAborted(threadId),
			isRunning: state?.isRunning,
			hasError: !!state?.error,
			paused: state?.isRunning === undefined && !!state?.pauseInfo,
		});
		if (isTerminalRunPhase(phase)) {
			const answer = pickFinalAnswer(thread.messages, options.sinceMs, options.answerCap);
			return {
				phase,
				...(answer ? { answer } : {}),
				...(phase === 'failed' && state?.error ? { error: state.error.message } : {}),
			};
		}

		// Subscribe before anything awaits: a change that lands while the phase is being reported must not be missed
		const store = new DisposableStore();
		try {
			const changed = new Promise<void>(resolve => {
				store.add(chat.onDidChangeStreamState(e => { if (e.threadId === threadId) { resolve(); } }));
				store.add(chat.onDidDeleteThread(id => { if (id === threadId) { resolve(); } }));
				store.add(options.token.onCancellationRequested(() => resolve()));
			});
			if (phase !== lastPhase) {
				lastPhase = phase;
				await options.onPhase?.(phase);
			}
			// A run in flight is awaited at the top of the loop; only a settled, unfinished one waits for a change
			if (!chat.isRunInFlight(threadId)) {
				await changed;
			}
		} finally {
			store.dispose();
		}
	}
	return undefined;
}
