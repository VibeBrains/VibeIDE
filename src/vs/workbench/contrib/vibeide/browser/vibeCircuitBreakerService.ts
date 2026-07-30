/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Holds the circuit-breaker state and makes it survive a restart.
 *
 * Persistence is the point for the latching ones: a security breaker that forgot itself when the
 * window closed would be trivially bypassed by reopening the IDE — which is exactly what someone
 * does after a scary message. Every transition also goes to the audit log, so "why did it stop"
 * has an answer tomorrow.
 *
 * Decisions live in the pure `agentCircuitBreakers` module; this side only stores, logs and
 * notifies.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { vibeLog } from '../common/vibeLog.js';
import { IAuditLogService } from '../common/auditLogService.js';
import {
	BREAKER_CONFIGS, BreakerId, BreakerSnapshot, breakerName, initialBreaker, isBreakerBlocking,
	recoverBreaker, tripBreaker,
} from '../common/agentCircuitBreakers.js';

/** Workspace-scoped: the rules that trip these breakers (paths, budgets) are per project. */
const STORAGE_KEY = 'vibeide.agent.circuitBreakers';

const ALL_BREAKERS: readonly BreakerId[] = ['secret-leak', 'protected-path', 'provider-errors', 'role-budget'];

export const IVibeCircuitBreakerService = createDecorator<IVibeCircuitBreakerService>('vibeCircuitBreakerService');

export interface IVibeCircuitBreakerService {
	readonly _serviceBrand: undefined;

	/** Register one occurrence; returns the resulting snapshot. */
	trip(id: BreakerId, reason: string): BreakerSnapshot;

	/** True when this breaker currently stops what it guards. */
	isBlocking(id: BreakerId): boolean;

	/** Attempt recovery. `manual: true` is a human decision and closes even a latched breaker. */
	recover(id: BreakerId, manual: boolean): BreakerSnapshot;

	snapshot(id: BreakerId): BreakerSnapshot;
	all(): readonly BreakerSnapshot[];

	readonly onDidChange: Event<BreakerSnapshot>;
}

class VibeCircuitBreakerService extends Disposable implements IVibeCircuitBreakerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<BreakerSnapshot>());
	readonly onDidChange: Event<BreakerSnapshot> = this._onDidChange.event;

	private _state = new Map<BreakerId, BreakerSnapshot>();

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@IAuditLogService private readonly _audit: IAuditLogService,
	) {
		super();
		this._load();
	}

	trip(id: BreakerId, reason: string): BreakerSnapshot {
		const before = this.snapshot(id);
		const after = tripBreaker(before, BREAKER_CONFIGS[id], Date.now(), reason);
		this._commit(after);
		if (before.state !== after.state) {
			vibeLog.warn('circuitBreaker', `${id}: ${before.state} → ${after.state} (${reason})`);
			this._audit.append({
				ts: Date.now(),
				action: 'circuit_breaker_opened',
				ok: false,
				meta: { breaker: id, state: after.state, reason, trips: after.trips },
			});
		}
		return after;
	}

	isBlocking(id: BreakerId): boolean {
		return isBreakerBlocking(this.snapshot(id));
	}

	recover(id: BreakerId, manual: boolean): BreakerSnapshot {
		const before = this.snapshot(id);
		const result = recoverBreaker(before, BREAKER_CONFIGS[id], manual);
		this._commit(result.snapshot);
		if (result.recovered || before.state !== result.snapshot.state) {
			vibeLog.info('circuitBreaker', `${id}: восстановление ${manual ? 'вручную' : 'автоматически'} — ${result.recovered ? 'выполнено' : `отказано (${result.refusal})`}`);
			this._audit.append({
				ts: Date.now(),
				action: 'circuit_breaker_recovered',
				ok: result.recovered,
				meta: { breaker: id, manual, refusal: result.refusal, state: result.snapshot.state },
			});
		}
		return result.snapshot;
	}

	snapshot(id: BreakerId): BreakerSnapshot {
		return this._state.get(id) ?? initialBreaker(id);
	}

	all(): readonly BreakerSnapshot[] {
		return ALL_BREAKERS.map(id => this.snapshot(id));
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private _commit(snapshot: BreakerSnapshot): void {
		this._state.set(snapshot.id, snapshot);
		this._save();
		this._onDidChange.fire(snapshot);
	}

	private _load(): void {
		const raw = this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			const parsed = JSON.parse(raw) as BreakerSnapshot[];
			for (const entry of Array.isArray(parsed) ? parsed : []) {
				// Unknown ids are dropped rather than trusted: a stale key must not resurrect a
				// breaker whose meaning has changed.
				if (ALL_BREAKERS.includes(entry?.id)) {
					this._state.set(entry.id, entry);
				}
			}
		} catch (error) {
			vibeLog.warn('circuitBreaker', 'состояние предохранителей нечитаемо, начинаем с чистого', error);
		}
	}

	private _save(): void {
		this._storage.store(STORAGE_KEY, JSON.stringify([...this._state.values()]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerSingleton(IVibeCircuitBreakerService, VibeCircuitBreakerService, InstantiationType.Delayed);

export { breakerName };
