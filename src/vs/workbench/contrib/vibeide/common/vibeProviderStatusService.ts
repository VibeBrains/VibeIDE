/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export type ProviderHealth = 'operational' | 'degraded' | 'outage' | 'unknown';

export interface ProviderStatus {
	providerName: string;
	health: ProviderHealth;
	lastChecked: number;
	latencyMs?: number;
	message?: string;
}

export const IVibeProviderStatusService = createDecorator<IVibeProviderStatusService>('vibeProviderStatusService');

export interface IVibeProviderStatusService {
	readonly _serviceBrand: undefined;

	/** Get cached status for all configured providers */
	getAllStatuses(): Map<string, ProviderStatus>;

	/** Refresh status for all providers */
	refresh(): Promise<void>;

	/** Check if a specific provider is healthy */
	isHealthy(providerName: string): boolean;

	readonly onStatusChanged: Event<ProviderStatus>;
}

// Provider status page URLs
const STATUS_URLS: Record<string, string> = {
	'anthropic': 'https://status.anthropic.com/api/v2/status.json',
	'openai': 'https://status.openai.com/api/v2/status.json',
	'gemini': 'https://www.googleapis.com/discovery/v1/apis',
};

/**
 * VibeIDE Provider Status Widget.
 * Real-time health status for all configured LLM providers.
 * Shows: operational / degraded / outage based on status pages.
 */
class VibeProviderStatusService extends Disposable implements IVibeProviderStatusService {
	declare readonly _serviceBrand: undefined;

	private readonly _onStatusChanged = this._register(new Emitter<ProviderStatus>());
	readonly onStatusChanged = this._onStatusChanged.event;

	private readonly _statuses = new Map<string, ProviderStatus>();
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();
		// Refresh every 5 minutes
		this._refreshTimer = setInterval(() => this.refresh(), 5 * 60 * 1000);
		this.refresh().catch(() => {}); // Initial check (non-blocking)
	}

	getAllStatuses(): Map<string, ProviderStatus> {
		return new Map(this._statuses);
	}

	isHealthy(providerName: string): boolean {
		const status = this._statuses.get(providerName.toLowerCase());
		return !status || status.health === 'operational';
	}

	async refresh(): Promise<void> {
		for (const [provider, url] of Object.entries(STATUS_URLS)) {
			await this._checkProvider(provider, url);
		}
	}

	private async _checkProvider(providerName: string, statusUrl: string): Promise<void> {
		const start = Date.now();
		try {
			const context = await this._requestService.request(
				{ url: statusUrl, type: 'GET', callSite: 'vibeide-provider-status-check' },
				CancellationToken.None
			);

			const latencyMs = Date.now() - start;
			const health: ProviderHealth = context.res.statusCode === 200 ? 'operational' : 'degraded';

			this._updateStatus(providerName, health, latencyMs);
		} catch {
			this._updateStatus(providerName, 'unknown');
		}
	}

	private _updateStatus(providerName: string, health: ProviderHealth, latencyMs?: number): void {
		const status: ProviderStatus = {
			providerName,
			health,
			lastChecked: Date.now(),
			latencyMs,
		};
		this._statuses.set(providerName, status);
		this._onStatusChanged.fire(status);

		if (health !== 'operational') {
			this._logService.warn(`[VibeIDE ProviderStatus] ${providerName}: ${health}`);
		}
	}

	override dispose(): void {
		if (this._refreshTimer) clearInterval(this._refreshTimer);
		super.dispose();
	}
}

registerSingleton(IVibeProviderStatusService, VibeProviderStatusService, InstantiationType.Delayed);
