/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeCostAttributionService } from '../common/vibeCostAttributionService.js';
import { IVibeModelFingerprintService } from '../common/vibeModelFingerprintService.js';

export interface ProviderUsageRecord {
	date: string;
	providerName: string;
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	estimatedCostUsd: number;
	requestCount: number;
}

export const IVibeProviderDashboardService = createDecorator<IVibeProviderDashboardService>('vibeProviderDashboardService');

export interface IVibeProviderDashboardService {
	readonly _serviceBrand: undefined;
	getUsageHistory(): ProviderUsageRecord[];
	getTotalCost(): number;
	generateReport(): string;
}

/**
 * VibeIDE Provider Dashboard.
 * Full history: расходы по неделям, задачам и провайдерам.
 * Сравнение провайдеров по cost/quality.
 */
class VibeProviderDashboardService extends Disposable implements IVibeProviderDashboardService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibeCostAttributionService private readonly _costService: IVibeCostAttributionService,
		@IVibeModelFingerprintService private readonly _fingerprintService: IVibeModelFingerprintService,
	) {
		super();
		vibeLog.debug('ProviderDashboard', 'ready');
	}

	getUsageHistory(): ProviderUsageRecord[] {
		const fingerprints = this._fingerprintService.getRecent(500);
		const byDay = new Map<string, ProviderUsageRecord>();

		for (const fp of fingerprints) {
			const date = new Date(fp.timestamp).toISOString().split('T')[0];
			const key = `${date}:${fp.providerName}:${fp.modelId}`;

			if (!byDay.has(key)) {
				byDay.set(key, {
					date, providerName: fp.providerName, modelId: fp.modelId,
					inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, requestCount: 0,
				});
			}

			const record = byDay.get(key)!;
			record.inputTokens += fp.inputTokens || 0;
			record.outputTokens += fp.outputTokens || 0;
			record.requestCount++;
		}

		return Array.from(byDay.values()).sort((a, b) => b.date.localeCompare(a.date));
	}

	getTotalCost(): number {
		return this.getUsageHistory().reduce((s, r) => s + r.estimatedCostUsd, 0);
	}

	generateReport(): string {
		const records = this.getUsageHistory().slice(0, 30);
		const total = this.getTotalCost();
		const lines = ['## Provider Dashboard\n', `Total cost (last 500 requests): $${total.toFixed(4)}\n`];
		lines.push('| Date | Provider | Model | Requests | Cost |');
		lines.push('|------|----------|-------|----------|------|');
		records.forEach(r => lines.push(
			`| ${r.date} | ${r.providerName} | ${r.modelId.slice(0, 20)} | ${r.requestCount} | $${r.estimatedCostUsd.toFixed(4)} |`
		));
		const topFiles = this._costService.getTopFiles(10);
		if (topFiles.length > 0) {
			lines.push('', '### Session cost attribution (files)', '| File | Requests | Tokens | USD |');
			lines.push('|------|----------|--------|-----|');
			topFiles.slice(0, 10).forEach(f =>
				lines.push(`| ${f.filePath.slice(-48)} | ${f.requestCount} | ${f.tokensUsed} | $${f.estimatedCostUsd.toFixed(4)} |`)
			);
		}
		return lines.join('\n');
	}
}

registerSingleton(IVibeProviderDashboardService, VibeProviderDashboardService, InstantiationType.Delayed);
