/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Circuit breakers for the agent loop.
 *
 * The existing guards are single-shot and local: the loop detector reacts to one repeating
 * action, the dead man's switch to silence. Neither remembers that the same thing went wrong
 * three times in a row, so a repeating failure keeps costing money and attention.
 *
 * A breaker accumulates trips and opens when the threshold is reached. The important asymmetry —
 * taken from raytsystem — is what happens next:
 *
 *   • security breakers LATCH. They never close on their own, whatever the timer says. A leaked
 *     secret or a write onto a closed path is a decision for a human, and a breaker that quietly
 *     re-armed itself would turn a safety stop into a speed bump.
 *   • the rest auto-recover a bounded number of times, then latch too — because a fault that
 *     survives N recoveries is not transient, and pretending otherwise loops forever.
 *
 * Four breakers, not twelve: every one here has a real signal behind it today. A breaker without
 * a source is decoration that reports "всё в порядке" about something nobody measures.
 *
 * Pure: state in, state out. The service persists it and writes the audit trail.
 */

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type BreakerId =
	/** Turn checks found a secret in files the run changed. */
	| 'secret-leak'
	/** A write landed on a path closed by constraints or permissions. */
	| 'protected-path'
	/** The provider failed repeatedly across runs (not inside one loop). */
	| 'provider-errors'
	/** A role kept hitting its cumulative budget. */
	| 'role-budget';

export type BreakerState =
	/** Working normally. */
	| 'closed'
	/** Tripped; may still recover automatically. */
	| 'open'
	/** Tripped and will not recover without a human. */
	| 'latched';

export interface BreakerConfig {
	/** Trips needed to open. 1 = open on the first occurrence. */
	readonly threshold: number;
	/** Security breakers latch immediately on opening and never auto-recover. */
	readonly security: boolean;
	/** Automatic recoveries allowed before the breaker latches for good. */
	readonly maxAutoRecoveries: number;
}

export const BREAKER_CONFIGS: Readonly<Record<BreakerId, BreakerConfig>> = {
	// One leaked secret is one too many — open on the first trip and stay latched.
	'secret-leak': { threshold: 1, security: true, maxAutoRecoveries: 0 },
	'protected-path': { threshold: 1, security: true, maxAutoRecoveries: 0 },
	// Provider blips are common and usually transient; three in a row is a pattern.
	'provider-errors': { threshold: 3, security: false, maxAutoRecoveries: 2 },
	'role-budget': { threshold: 3, security: false, maxAutoRecoveries: 1 },
};

export interface BreakerSnapshot {
	readonly id: BreakerId;
	readonly state: BreakerState;
	/** Trips accumulated since the breaker was last closed. */
	readonly trips: number;
	readonly autoRecoveries: number;
	readonly lastTrippedAt?: number;
	/** Why it opened, in the words shown to the user. */
	readonly reason?: string;
}

export function initialBreaker(id: BreakerId): BreakerSnapshot {
	return { id, state: 'closed', trips: 0, autoRecoveries: 0 };
}

/**
 * The service contract lives here, next to the pure decisions, because both the chat loop
 * (`browser/`) and the subagent service (`common/`) have to ask the same question before starting
 * work. The implementation stays in `browser/` — it needs storage and the audit log.
 */
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

/** Breakers that guard the user's data: they latch, and nothing may start while one is open. */
export const PROTECTIVE_BREAKERS: readonly BreakerId[] = ['secret-leak', 'protected-path'];

/** True when the breaker must stop whatever it guards. */
export function isBreakerBlocking(snapshot: BreakerSnapshot): boolean {
	return snapshot.state !== 'closed';
}

/**
 * Register one occurrence. Below the threshold the breaker only counts; at the threshold it
 * opens — and a security breaker latches in the same step, because "open but recoverable" is a
 * state a safety stop must never pass through.
 */
export function tripBreaker(snapshot: BreakerSnapshot, config: BreakerConfig, now: number, reason: string): BreakerSnapshot {
	if (snapshot.state === 'latched') {
		// Already final: keep the original reason, it is the one that matters.
		return { ...snapshot, trips: snapshot.trips + 1, lastTrippedAt: now };
	}
	const trips = snapshot.trips + 1;
	if (trips < Math.max(1, config.threshold)) {
		return { ...snapshot, trips, lastTrippedAt: now, reason };
	}
	return {
		...snapshot,
		trips,
		state: config.security ? 'latched' : 'open',
		lastTrippedAt: now,
		reason,
	};
}

export type RecoveryRefusal = 'latched' | 'auto-limit-reached';

export interface RecoveryResult {
	readonly snapshot: BreakerSnapshot;
	readonly recovered: boolean;
	/** Why an automatic recovery was refused; absent when it succeeded or was manual. */
	readonly refusal?: RecoveryRefusal;
}

/**
 * Try to close the breaker.
 *
 * `manual` is a human decision and closes anything, including a latched breaker — that is the
 * whole point of latching: a person, not a timer, decides. An automatic attempt is refused for
 * security breakers outright, and for the rest once the recovery budget is spent (the breaker
 * then latches, so the next attempt needs a human too).
 */
export function recoverBreaker(snapshot: BreakerSnapshot, config: BreakerConfig, manual: boolean): RecoveryResult {
	if (manual) {
		return { snapshot: { ...initialBreaker(snapshot.id) }, recovered: true };
	}
	if (config.security || snapshot.state === 'latched') {
		return { snapshot, recovered: false, refusal: 'latched' };
	}
	if (snapshot.autoRecoveries >= config.maxAutoRecoveries) {
		return {
			snapshot: { ...snapshot, state: 'latched' },
			recovered: false,
			refusal: 'auto-limit-reached',
		};
	}
	return {
		snapshot: { ...snapshot, state: 'closed', trips: 0, autoRecoveries: snapshot.autoRecoveries + 1 },
		recovered: true,
	};
}

const BREAKER_NAMES: Record<BreakerId, string> = {
	'secret-leak': 'Секрет в изменённых файлах',
	'protected-path': 'Запись в закрытый путь',
	'provider-errors': 'Повторные ошибки провайдера',
	'role-budget': 'Роль упирается в бюджет',
};

export function breakerName(id: BreakerId): string {
	return BREAKER_NAMES[id];
}

/** One line for the panel: what happened and what it takes to resume. */
export function describeBreaker(snapshot: BreakerSnapshot): string {
	if (snapshot.state === 'closed') {
		return 'в норме';
	}
	const cause = snapshot.reason ? ` — ${snapshot.reason}` : '';
	return snapshot.state === 'latched'
		? `остановлено, снимается только вручную${cause}`
		: `остановлено, восстановится автоматически${cause}`;
}
