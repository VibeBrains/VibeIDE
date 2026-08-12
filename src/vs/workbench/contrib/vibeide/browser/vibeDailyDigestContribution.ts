/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The daily digest of agent runs, delivered on a schedule.
 *
 * The ledger already knows what happened; what was missing is anybody telling the user without
 * being asked. Until now the digest existed only as an answer to a Telegram command — which means
 * it reached whoever thought to ask, at the moment they thought to ask.
 *
 * Two behaviours are deliberate and easy to get wrong:
 *  - A slot missed because the IDE was closed is delivered LATE, covering the whole gap. Overnight
 *    runs are the reason the digest exists; a shut laptop is not a reason to stay silent about them.
 *  - The delivery mark is APPLICATION-scoped, so a second open window sees the first one's mark and
 *    keeps quiet. Otherwise every window would report the same day.
 *
 * All arithmetic lives in `common/agentDigestSchedule.ts` — timers cannot be tested by waiting.
 */

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVibeAgentRunLedgerService } from '../common/vibeAgentRunLedgerService.js';
import { buildAgentDailyDigest, formatAgentDailyDigest } from '../common/agentDailyDigest.js';
import { parseDigestTime, msUntilNextDue, isCatchUpDue, digestPeriod } from '../common/agentDigestSchedule.js';

const CONFIG_ENABLED = 'vibeide.dailyDigest.enabled';
const CONFIG_TIME = 'vibeide.dailyDigest.time';

/** Application-scoped so every window shares one delivery mark. */
const STORAGE_LAST_SENT = 'vibeide.dailyDigest.lastSentMs';

class VibeDailyDigestContribution extends Disposable implements IWorkbenchContribution {

	private readonly _timer = this._register(new MutableDisposable());

	constructor(
		@IConfigurationService private readonly _config: IConfigurationService,
		@IStorageService private readonly _storage: IStorageService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
		@IVibeAgentRunLedgerService private readonly _ledger: IVibeAgentRunLedgerService,
	) {
		super();
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_ENABLED) || e.affectsConfiguration(CONFIG_TIME)) {
				this._reschedule();
			}
		}));
		this._reschedule();
	}

	/** Minutes-of-day for the configured slot, or undefined when the setting is off or malformed. */
	private _slot(): number | undefined {
		if (!this._config.getValue<boolean>(CONFIG_ENABLED)) { return undefined; }
		const raw = this._config.getValue<string>(CONFIG_TIME);
		const parsed = parseDigestTime(raw);
		if (parsed === undefined) {
			// Deliberately not falling back to a default — see the setting's description.
			this._log.warn(`[VibeDailyDigest] ${CONFIG_TIME}="${raw}" is not HH:MM — the digest stays off.`);
		}
		return parsed;
	}

	private _lastSent(): number | undefined {
		const raw = this._storage.getNumber(STORAGE_LAST_SENT, StorageScope.APPLICATION);
		return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
	}

	private _reschedule(): void {
		this._timer.clear();
		const slot = this._slot();
		if (slot === undefined) { return; }

		const now = Date.now();
		if (isCatchUpDue(now, slot, this._lastSent())) {
			void this._deliver(slot);
		} else if (this._lastSent() === undefined) {
			// Arm the mark on first enable so the NEXT slot delivers instead of the feature
			// greeting the user with yesterday's report the moment they switch it on.
			this._storage.store(STORAGE_LAST_SENT, now, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}

		const handle = setTimeout(() => {
			void this._deliver(slot).finally(() => this._reschedule());
		}, msUntilNextDue(now, slot));
		this._timer.value = { dispose: () => clearTimeout(handle) };
	}

	private async _deliver(slot: number): Promise<void> {
		const now = Date.now();
		// Re-read the mark right before sending: another window may have delivered while this
		// timer was pending, and the mark is the only thing that keeps the report single.
		const lastSent = this._lastSent();
		if (lastSent !== undefined && lastSent >= now - 60_000) { return; }
		this._storage.store(STORAGE_LAST_SENT, now, StorageScope.APPLICATION, StorageTarget.MACHINE);

		try {
			const runs = await this._ledger.getRuns();
			const digest = buildAgentDailyDigest(runs, digestPeriod(now, slot, lastSent));
			const text = formatAgentDailyDigest(digest);
			// `undefined` means nothing happened — an empty daily report teaches the reader to
			// ignore the channel it arrives in.
			if (!text) { return; }
			this._notifications.notify({
				severity: digest.failed.length + digest.limited.length > 0 ? Severity.Warning : Severity.Info,
				message: text,
			});
		} catch (err) {
			this._log.error(`[VibeDailyDigest] could not build the digest: ${err}`);
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	VibeDailyDigestContribution,
	LifecyclePhase.Restored
);
