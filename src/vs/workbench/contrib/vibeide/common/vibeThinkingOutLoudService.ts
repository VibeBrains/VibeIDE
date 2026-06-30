/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export interface ThinkingChunk {
	requestId: string;
	text: string;
	isFinal: boolean;
	timestamp: number;
}

export const IVibeThinkingOutLoudService = createDecorator<IVibeThinkingOutLoudService>('vibeThinkingOutLoudService');

export interface IVibeThinkingOutLoudService {
	readonly _serviceBrand: undefined;

	/** Whether thinking out loud mode is enabled */
	isEnabled(): boolean;

	/** Stream a thinking chunk from extended thinking API */
	streamThinking(chunk: Omit<ThinkingChunk, 'timestamp'>): void;

	/** Get accumulated thinking for a request */
	getThinking(requestId: string): string;

	readonly onThinkingChunk: Event<ThinkingChunk>;
}

/**
 * VibeIDE Agent "Thinking Out Loud" Mode.
 * Streams internal agent reasoning to a separate panel.
 * Supports: Claude 3.7+ (extended thinking), OpenAI o-series (reasoning).
 * Requires provider capability: extendedThinking: true.
 */
class VibeThinkingOutLoudService extends Disposable implements IVibeThinkingOutLoudService {
	declare readonly _serviceBrand: undefined;

	private readonly _onThinkingChunk = this._register(new Emitter<ThinkingChunk>());
	readonly onThinkingChunk = this._onThinkingChunk.event;

	private readonly _thinkingBuffers = new Map<string, string>();
	private _enabled: boolean;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._enabled = this._configurationService.getValue<boolean>('vibeide.agent.thinkingOutLoud') ?? false;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.agent.thinkingOutLoud')) {
				this._enabled = this._configurationService.getValue<boolean>('vibeide.agent.thinkingOutLoud') ?? false;
			}
		}));
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	streamThinking(chunk: Omit<ThinkingChunk, 'timestamp'>): void {
		if (!this._enabled) { return; }

		const full: ThinkingChunk = { ...chunk, timestamp: Date.now() };
		const existing = this._thinkingBuffers.get(chunk.requestId) ?? '';
		this._thinkingBuffers.set(chunk.requestId, existing + chunk.text);
		this._onThinkingChunk.fire(full);

		if (chunk.isFinal) {
			vibeLog.debug('ThinkingOutLoud', `Final reasoning: ${(existing + chunk.text).length} chars`);
		}
	}

	getThinking(requestId: string): string {
		return this._thinkingBuffers.get(requestId) ?? '';
	}
}

registerSingleton(IVibeThinkingOutLoudService, VibeThinkingOutLoudService, InstantiationType.Eager);
