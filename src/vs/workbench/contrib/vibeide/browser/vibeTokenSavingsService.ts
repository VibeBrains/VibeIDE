/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Session-scoped tally of characters saved by output compression (terminal condenser/profiles and
 * MCP output compression). Pure accounting — makes the otherwise-invisible token-economy work
 * (knowledge/roadmap/token-economy.md) visible via the «Экономия на сжатии вывода» command.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

export const IVibeTokenSavingsService = createDecorator<IVibeTokenSavingsService>('vibeTokenSavingsService');

/** Where a saving came from — one bucket per compression call site. */
export type VibeSavingsSource = 'terminal' | 'mcp';

export interface IVibeSavingsBucket {
	/** Number of compression calls that actually shrank their input. */
	readonly calls: number;
	/** Characters removed (input length − output length), summed. */
	readonly savedChars: number;
}

export interface IVibeSavingsSnapshot {
	readonly terminal: IVibeSavingsBucket;
	readonly mcp: IVibeSavingsBucket;
	/** Combined characters saved. */
	readonly totalSavedChars: number;
	/** Rough token estimate at the codebase-wide 4-chars-per-token ratio. */
	readonly totalSavedTokensApprox: number;
}

export interface IVibeTokenSavingsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Record one compression call. No-op when nothing shrank (before ≤ after). */
	record(source: VibeSavingsSource, beforeChars: number, afterChars: number): void;
	snapshot(): IVibeSavingsSnapshot;
}

/** Same ratio as estimateTokens across the LLM pipeline — keep in sync if that ever changes. */
const CHARS_PER_TOKEN = 4;

class VibeTokenSavingsService extends Disposable implements IVibeTokenSavingsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _buckets: Record<VibeSavingsSource, { calls: number; savedChars: number }> = {
		terminal: { calls: 0, savedChars: 0 },
		mcp: { calls: 0, savedChars: 0 },
	};

	record(source: VibeSavingsSource, beforeChars: number, afterChars: number): void {
		const saved = beforeChars - afterChars;
		if (saved <= 0) {
			return;
		}
		const b = this._buckets[source];
		b.calls += 1;
		b.savedChars += saved;
		this._onDidChange.fire();
	}

	snapshot(): IVibeSavingsSnapshot {
		const terminal = { ...this._buckets.terminal };
		const mcp = { ...this._buckets.mcp };
		const totalSavedChars = terminal.savedChars + mcp.savedChars;
		return {
			terminal,
			mcp,
			totalSavedChars,
			totalSavedTokensApprox: Math.round(totalSavedChars / CHARS_PER_TOKEN),
		};
	}
}

registerSingleton(IVibeTokenSavingsService, VibeTokenSavingsService, InstantiationType.Delayed);
