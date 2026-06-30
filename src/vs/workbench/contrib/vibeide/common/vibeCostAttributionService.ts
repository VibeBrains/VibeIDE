/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface FileCostAttribution {
	filePath: string;
	tokensUsed: number;
	estimatedCostUsd: number;
	requestCount: number;
}

export const IVibeCostAttributionService = createDecorator<IVibeCostAttributionService>('vibeCostAttributionService');

export interface IVibeCostAttributionService {
	readonly _serviceBrand: undefined;

	/** Record token usage for a file in current session */
	recordFileUsage(filePath: string, tokens: number, costUsd: number): void;

	/** Get cost attribution for current session (sorted by cost) */
	getSessionAttribution(): FileCostAttribution[];

	/** Reset session attribution */
	resetSession(): void;

	/** Get top N files by token cost */
	getTopFiles(limit?: number): FileCostAttribution[];
}

/**
 * VibeIDE Cost Attribution per File.
 * In end of session: shows which files consumed most tokens.
 * Helps users understand where context is bloating.
 */
class VibeCostAttributionService extends Disposable implements IVibeCostAttributionService {
	declare readonly _serviceBrand: undefined;

	private readonly _fileUsage = new Map<string, FileCostAttribution>();

	constructor(
	) {
		super();
	}

	recordFileUsage(filePath: string, tokens: number, costUsd: number): void {
		const existing = this._fileUsage.get(filePath) ?? {
			filePath,
			tokensUsed: 0,
			estimatedCostUsd: 0,
			requestCount: 0,
		};
		existing.tokensUsed += tokens;
		existing.estimatedCostUsd += costUsd;
		existing.requestCount += 1;
		this._fileUsage.set(filePath, existing);
	}

	getSessionAttribution(): FileCostAttribution[] {
		return Array.from(this._fileUsage.values())
			.sort((a, b) => b.tokensUsed - a.tokensUsed);
	}

	getTopFiles(limit: number = 10): FileCostAttribution[] {
		return this.getSessionAttribution().slice(0, limit);
	}

	resetSession(): void {
		this._fileUsage.clear();
		vibeLog.debug('CostAttribution', 'Session reset');
	}
}

registerSingleton(IVibeCostAttributionService, VibeCostAttributionService, InstantiationType.Eager);
