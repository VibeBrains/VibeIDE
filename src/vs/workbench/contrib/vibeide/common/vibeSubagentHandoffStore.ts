/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { SubagentType } from './vibeSubagentService.js';
import type { AgentSessionIdentity } from './agentRunFingerprint.js';

/**
 * Durable record of a subagent that STOPPED with partial work (token/step/deadline limit).
 * Persisted so the work is not lost across a route halt or an IDE restart: it can be resumed
 * automatically (up to `vibeide.subagent.maxResumes`) or manually via the «субпин» indicator.
 *
 * Lifecycle: a ticket EXISTS iff there is partial work not yet carried to completion.
 * 'open' = awaiting pickup (auto-resumes exhausted, or a resume attempt failed);
 * 'resumed' = a continuation is running IN THIS SESSION (in-memory-only state — reconciled
 * back to 'open' on startup, because no resume can survive a restart).
 * Successful completion REMOVES the ticket (nothing left to hand off).
 */
export interface SubagentHandoffTicket {
	readonly id: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly status: 'open' | 'resumed';
	readonly parentThreadId: string;
	readonly role: SubagentType;
	/** The original task text — enough to rebuild the role goal on resume (survives restart). */
	readonly taskText: string;
	/** Prior-stage route context (summaries of preceding roles) — kept so a manual resume does not lose it. */
	readonly priorContext?: string;
	/** Partial result accumulated so far (last output); grows across resumes. */
	readonly partialSummary: string;
	readonly artifacts: readonly string[];
	readonly stopReason: string;
	readonly tokensUsed: number;
	/** How many times this ticket was already resumed (auto or manual) — the loop guard. */
	readonly resumeCount: number;
	/**
	 * Ground the run stood on when the ticket was written. A ticket outlives the window, so a
	 * pickup days later can land on another model or a different tool whitelist; keeping the
	 * identity lets the resume say what moved instead of continuing silently.
	 */
	readonly identity?: AgentSessionIdentity;
	/** Digest of `identity` — cheap equality for callers that do not need the offending field. */
	readonly fingerprint?: string;
}

const STORAGE_KEY = 'vibeide.subagent.handoffs';
/** Tickets untouched longer than this are stale — pruned on write/startup. */
const TICKET_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Hard cap on stored tickets (newest by updatedAt win) — bounds the storage blob. */
const TICKET_CAP = 50;
/** Resume budget escalation never exceeds this multiple of the base quota. */
const RESUME_QUOTA_CAP_FACTOR = 4;

export const IVibeSubagentHandoffStore = createDecorator<IVibeSubagentHandoffStore>('vibeSubagentHandoffStore');

export interface IVibeSubagentHandoffStore {
	readonly _serviceBrand: undefined;
	/** Fired whenever the ticket set changes (create/update/remove) — drives the «субпин» indicator. */
	readonly onDidChange: Event<void>;
	/** Create a new open ticket from a stopped subagent's partial work. Returns the ticket. */
	create(input: Omit<SubagentHandoffTicket, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'resumeCount'>): SubagentHandoffTicket;
	/** Patch an existing ticket (partial fields); no-op if the id is gone. */
	update(id: string, patch: Partial<Omit<SubagentHandoffTicket, 'id' | 'createdAt'>>): void;
	get(id: string): SubagentHandoffTicket | undefined;
	list(): readonly SubagentHandoffTicket[];
	/** Only tickets still awaiting a human decision (status 'open'). */
	listOpen(): readonly SubagentHandoffTicket[];
	remove(id: string): void;
}

/** Drop stale tickets (TTL by updatedAt) and cap the total (newest win). Pure — unit-tested. */
export function gcTickets(tickets: readonly SubagentHandoffTicket[], nowMs: number): SubagentHandoffTicket[] {
	return [...tickets]
		.filter(t => nowMs - t.updatedAt < TICKET_TTL_MS)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, TICKET_CAP);
}

/** 'resumed' is valid only in the memory of one session — after a restart flip it back to 'open'. Pure. */
export function reconcileStaleResumed(tickets: readonly SubagentHandoffTicket[]): SubagentHandoffTicket[] {
	return tickets.map(t => t.status === 'resumed' ? { ...t, status: 'open' as const } : t);
}

/**
 * Escalate the token quota for a resume attempt: the stopped role gets a bigger budget each time
 * (factor^resumeIndex), capped at RESUME_QUOTA_CAP_FACTOR × base. resumeIndex 0 = initial spawn.
 * Pure — unit-tested.
 */
export function escalateResumeQuota(baseQuota: number, resumeIndex: number, factor: number): number {
	const f = Math.min(3, Math.max(1, factor));
	const mult = Math.min(RESUME_QUOTA_CAP_FACTOR, Math.pow(f, Math.max(0, resumeIndex)));
	return Math.round(baseQuota * mult);
}

class VibeSubagentHandoffStore extends Disposable implements IVibeSubagentHandoffStore {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		// Startup reconciliation + GC: un-stick tickets left 'resumed' by a previous session
		// (a resume cannot survive a restart) and prune stale/overflow entries.
		const before = this._read();
		const after = gcTickets(reconcileStaleResumed(before), Date.now());
		if (JSON.stringify(after) !== JSON.stringify(before)) { this._write(after); }
	}

	private _read(): SubagentHandoffTicket[] {
		const raw = this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE, '[]');
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed as SubagentHandoffTicket[] : [];
		} catch {
			return [];
		}
	}

	private _write(tickets: SubagentHandoffTicket[]): void {
		this._storage.store(STORAGE_KEY, JSON.stringify(gcTickets(tickets, Date.now())), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	create(input: Omit<SubagentHandoffTicket, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'resumeCount'>): SubagentHandoffTicket {
		const now = Date.now();
		const ticket: SubagentHandoffTicket = { ...input, id: generateUuid(), createdAt: now, updatedAt: now, status: 'open', resumeCount: 0 };
		this._write([...this._read(), ticket]);
		return ticket;
	}

	update(id: string, patch: Partial<Omit<SubagentHandoffTicket, 'id' | 'createdAt'>>): void {
		const tickets = this._read();
		const idx = tickets.findIndex(t => t.id === id);
		if (idx === -1) { return; }
		tickets[idx] = { ...tickets[idx], ...patch, updatedAt: Date.now() };
		this._write(tickets);
	}

	get(id: string): SubagentHandoffTicket | undefined {
		return this._read().find(t => t.id === id);
	}

	list(): readonly SubagentHandoffTicket[] {
		return this._read();
	}

	listOpen(): readonly SubagentHandoffTicket[] {
		return this._read().filter(t => t.status === 'open');
	}

	remove(id: string): void {
		const tickets = this._read();
		const next = tickets.filter(t => t.id !== id);
		if (next.length !== tickets.length) { this._write(next); }
	}
}

registerSingleton(IVibeSubagentHandoffStore, VibeSubagentHandoffStore, InstantiationType.Delayed);

/**
 * Build the goal for a continuation subagent: the original task plus a compact «already done»
 * preamble so the resumed role continues instead of starting over. `priorContext` restores the
 * preceding route stage's summaries (kept on the ticket for manual resumes). Pure — unit-tested.
 */
export function buildResumeGoal(taskText: string, role: string, partialSummary: string, priorContext?: string): string {
	let goal = `Роль: ${role}. Задача: ${taskText}`;
	const prior = priorContext?.trim();
	if (prior) { goal += `\n\nКонтекст от предыдущего этапа:\n${prior}`; }
	const done = partialSummary.trim();
	if (done) { goal += `\n\nУже сделано ранее (продолжи с этого места, НЕ начинай заново):\n${done}`; }
	return goal;
}
