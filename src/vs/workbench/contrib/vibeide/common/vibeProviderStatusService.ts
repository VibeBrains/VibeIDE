/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';


export type ProviderHealth = 'operational' | 'degraded' | 'outage' | 'unknown';

export type RequestOutcome = 'success' | 'networkError' | 'authError' | 'serverError';

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

	/** Get cached status for all providers that have been observed */
	getAllStatuses(): Map<string, ProviderStatus>;

	/** No-op kept for API compatibility — status updates come from reportRequestResult */
	refresh(): Promise<void>;

	/** True when no failure has been observed (default) or last outcome was success */
	isHealthy(providerName: string): boolean;

	/** Update provider health from the result of a real API call */
	reportRequestResult(providerName: string, outcome: RequestOutcome, latencyMs?: number): void;

	readonly onStatusChanged: Event<ProviderStatus>;
	/** Fires with the raw outcome before health conversion — consumed by failover FSM. */
	readonly onRequestOutcome: Event<{ providerName: string; outcome: RequestOutcome; latencyMs?: number }>;
}

/**
 * VibeIDE Provider Status.
 * Health is observed from real provider API calls reported via reportRequestResult.
 * No external status-page polling — that hits CORS in the renderer and gives a stale signal anyway.
 */
class VibeProviderStatusService extends Disposable implements IVibeProviderStatusService {
	declare readonly _serviceBrand: undefined;

	private readonly _onStatusChanged = this._register(new Emitter<ProviderStatus>());
	readonly onStatusChanged = this._onStatusChanged.event;

	private readonly _onRequestOutcome = this._register(new Emitter<{ providerName: string; outcome: RequestOutcome; latencyMs?: number }>());
	readonly onRequestOutcome = this._onRequestOutcome.event;

	private readonly _statuses = new Map<string, ProviderStatus>();

	constructor(
	) {
		super();
	}

	getAllStatuses(): Map<string, ProviderStatus> {
		return new Map(this._statuses);
	}

	async refresh(): Promise<void> {
		// No-op: status is driven by reportRequestResult.
	}

	isHealthy(providerName: string): boolean {
		const status = this._statuses.get(providerName.toLowerCase());
		// Default to healthy when no observation yet — avoids a misleading warning state at startup.
		return !status || status.health === 'operational';
	}

	reportRequestResult(providerName: string, outcome: RequestOutcome, latencyMs?: number): void {
		const health = this._outcomeToHealth(outcome);
		this._updateStatus(providerName.toLowerCase(), health, latencyMs);
		this._onRequestOutcome.fire({ providerName: providerName.toLowerCase(), outcome, latencyMs });
	}

	private _outcomeToHealth(outcome: RequestOutcome): ProviderHealth {
		switch (outcome) {
			case 'success': return 'operational';
			case 'authError': return 'outage';
			case 'networkError':
			case 'serverError':
			default:
				return 'degraded';
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
			vibeLog.warn('ProviderStatus', `${providerName}: ${health}`);
		}
	}
}

registerSingleton(IVibeProviderStatusService, VibeProviderStatusService, InstantiationType.Delayed);
