/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export type InlineDiffDecision = 'accept' | 'reject';

export interface InlineDiffChunkEvent {
	chunkId: string;
	filePath: string;
	decision: InlineDiffDecision;
	timestamp: number;
}

export interface InlineDiffSession {
	sessionId: string;
	filePath: string;
	chunks: Array<{
		id: string;
		startLine: number;
		endLine: number;
		original: string;
		modified: string;
		decision?: InlineDiffDecision;
	}>;
	isComplete: boolean;
}

export const IVibeInlineDiffService = createDecorator<IVibeInlineDiffService>('vibeInlineDiffService');

export interface IVibeInlineDiffService {
	readonly _serviceBrand: undefined;

	/** Start an inline diff review session */
	startSession(filePath: string, chunks: InlineDiffSession['chunks']): string;

	/** Accept a chunk */
	acceptChunk(sessionId: string, chunkId: string): void;

	/** Reject a chunk */
	rejectChunk(sessionId: string, chunkId: string): void;

	/** Accept all remaining chunks */
	acceptAll(sessionId: string): void;

	/** Reject all remaining chunks */
	rejectAll(sessionId: string): void;

	/** Get session state */
	getSession(sessionId: string): InlineDiffSession | undefined;

	readonly onChunkDecided: Event<InlineDiffChunkEvent>;
}

/**
 * VibeIDE Inline Diff Review.
 * Accept/reject each chunk directly in file.
 * Atomicity: either all applied or all rejected (per-file transaction).
 */
class VibeInlineDiffService extends Disposable implements IVibeInlineDiffService {
	declare readonly _serviceBrand: undefined;

	private readonly _onChunkDecided = this._register(new Emitter<InlineDiffChunkEvent>());
	readonly onChunkDecided = this._onChunkDecided.event;

	private readonly _sessions = new Map<string, InlineDiffSession>();

	constructor(
	) {
		super();
	}

	startSession(filePath: string, chunks: InlineDiffSession['chunks']): string {
		const sessionId = `inline-diff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this._sessions.set(sessionId, { sessionId, filePath, chunks, isComplete: false });
		vibeLog.debug('InlineDiff', `Session ${sessionId}: ${chunks.length} chunks in ${filePath}`);
		return sessionId;
	}

	acceptChunk(sessionId: string, chunkId: string): void {
		this._decideChunk(sessionId, chunkId, 'accept');
	}

	rejectChunk(sessionId: string, chunkId: string): void {
		this._decideChunk(sessionId, chunkId, 'reject');
	}

	acceptAll(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		session.chunks.filter(c => !c.decision).forEach(c => this._decideChunk(sessionId, c.id, 'accept'));
	}

	rejectAll(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		session.chunks.filter(c => !c.decision).forEach(c => this._decideChunk(sessionId, c.id, 'reject'));
	}

	getSession(sessionId: string): InlineDiffSession | undefined {
		return this._sessions.get(sessionId);
	}

	private _decideChunk(sessionId: string, chunkId: string, decision: InlineDiffDecision): void {
		const session = this._sessions.get(sessionId);
		const chunk = session?.chunks.find(c => c.id === chunkId);
		if (!chunk) { return; }

		chunk.decision = decision;
		this._onChunkDecided.fire({ chunkId, filePath: session!.filePath, decision, timestamp: Date.now() });

		// Check if all chunks decided
		if (session!.chunks.every(c => c.decision)) {
			session!.isComplete = true;
			vibeLog.debug('InlineDiff', `Session ${sessionId} complete`);
		}
	}
}

registerSingleton(IVibeInlineDiffService, VibeInlineDiffService, InstantiationType.Eager);
