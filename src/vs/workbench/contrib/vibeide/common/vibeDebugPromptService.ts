/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface PromptSnapshot {
	requestId: string;
	timestamp: number;
	systemPrompt: string;
	userMessages: Array<{ role: string; content: string }>;
	modelId: string;
	providerName: string;
	temperature?: number;
	maxTokens?: number;
	feature: string;
	contextFiles: string[];
	estimatedInputTokens: number;
}

export const IVibeDebugPromptService = createDecorator<IVibeDebugPromptService>('vibeDebugPromptService');

export interface IVibeDebugPromptService {
	readonly _serviceBrand: undefined;

	/** Record a prompt snapshot before sending to LLM */
	recordSnapshot(snapshot: PromptSnapshot): void;

	/** Get the most recent prompt snapshot */
	getLatest(): PromptSnapshot | undefined;

	/** Get snapshot by request ID */
	get(requestId: string): PromptSnapshot | undefined;

	/** Get recent snapshots for prompt versioning */
	getRecent(limit?: number): PromptSnapshot[];

	/** Event: new prompt snapshot recorded */
	readonly onSnapshot: Event<PromptSnapshot>;

	/** Get context diff between two requests */
	getContextDiff(requestId1: string, requestId2: string): {
		added: string[];
		removed: string[];
		unchanged: string[];
	} | null;
}

/**
 * VibeIDE Debug My Prompt: records exact system prompts and parameters.
 * Powers: Debug my prompt panel, Prompt versioning, Context diff.
 */
class VibeDebugPromptService extends Disposable implements IVibeDebugPromptService {
	declare readonly _serviceBrand: undefined;

	private readonly _onSnapshot = this._register(new Emitter<PromptSnapshot>());
	readonly onSnapshot = this._onSnapshot.event;

	private readonly _snapshots = new Map<string, PromptSnapshot>();
	private readonly _recentIds: string[] = [];
	private readonly MAX_STORED = 100;

	constructor(
	) {
		super();
	}

	recordSnapshot(snapshot: PromptSnapshot): void {
		// Evict oldest
		if (this._recentIds.length >= this.MAX_STORED) {
			const oldest = this._recentIds.shift();
			if (oldest) { this._snapshots.delete(oldest); }
		}
		this._snapshots.set(snapshot.requestId, snapshot);
		this._recentIds.push(snapshot.requestId);
		this._onSnapshot.fire(snapshot);
		vibeLog.debug('DebugPrompt', `Snapshot recorded: ${snapshot.requestId} (${snapshot.modelId}, ~${snapshot.estimatedInputTokens} tokens)`);
	}

	getLatest(): PromptSnapshot | undefined {
		const lastId = this._recentIds[this._recentIds.length - 1];
		return lastId ? this._snapshots.get(lastId) : undefined;
	}

	get(requestId: string): PromptSnapshot | undefined {
		return this._snapshots.get(requestId);
	}

	getRecent(limit: number = 10): PromptSnapshot[] {
		return this._recentIds.slice(-limit).map(id => this._snapshots.get(id)!).filter(Boolean);
	}

	getContextDiff(requestId1: string, requestId2: string) {
		const s1 = this._snapshots.get(requestId1);
		const s2 = this._snapshots.get(requestId2);
		if (!s1 || !s2) { return null; }

		const files1 = new Set(s1.contextFiles);
		const files2 = new Set(s2.contextFiles);

		const added = s2.contextFiles.filter(f => !files1.has(f));
		const removed = s1.contextFiles.filter(f => !files2.has(f));
		const unchanged = s1.contextFiles.filter(f => files2.has(f));

		return { added, removed, unchanged };
	}
}

registerSingleton(IVibeDebugPromptService, VibeDebugPromptService, InstantiationType.Eager);
