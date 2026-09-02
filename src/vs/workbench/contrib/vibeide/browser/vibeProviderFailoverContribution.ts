/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Provider auto-failover contribution (roadmap § N.3 / line 1184).
 *
 * Subscribes to `IVibeProviderStatusService.onRequestOutcome`, feeds each
 * raw outcome into the pure `processOutcome` FSM, and applies decisions:
 *
 *  - `switch`:           notify the user + switch active provider in settings.
 *  - `chain-exhausted`:  toast warning "all providers are down".
 *  - `increment-failure-count / reset-failure-count / no-op`: state update only.
 *
 * Provider chain is read from `vibeide.providers.failoverChain` config.
 * Failover state is per-provider and lives only in-memory (resets on reload).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.providers',
	title: localize('vibeide.providers.title', "VibeIDE — Устойчивость провайдеров"),
	type: 'object',
	properties: {
		'vibeide.providers.failoverChain': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('vibeide.providers.failoverChain.description', "Упорядоченный список id провайдеров для авто-failover, когда текущий провайдер возвращает 3 подряд серверных ошибки. Оставьте пустым для отключения failover. Пример: [\"anthropic\",\"openai\",\"ollama\"]."),
		},
	},
});
import { IAuditLogService } from '../common/auditLogService.js';
import { IVibeProviderStatusService, RequestOutcome } from '../common/vibeProviderStatusService.js';
import { IModelQuirksCatalogStatusService } from '../common/modelQuirksCatalogStatusService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { reasoningLostOnSwitch } from '../common/reasoningContinuity.js';
import {
	processOutcome,
	initFailoverState,
	ProviderHealthState,
	ProviderRequestOutcome,
	FAILOVER_DEFAULTS,
} from '../common/providerFailover.js';

function toFailoverOutcome(o: RequestOutcome): ProviderRequestOutcome {
	switch (o) {
		case 'success': return 'success';
		// A refused credential is its own class: it never recovers on retry, so it must not
		// reset the failure count the way an ordinary 4xx does.
		case 'authError': return 'auth-revoked';
		case 'networkError': return 'timeout';
		case 'serverError': return 'server-5xx';
	}
}

export class VibeProviderFailoverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProviderFailover';

	private readonly _states = new Map<string, ProviderHealthState>();

	constructor(
		@IVibeProviderStatusService private readonly _statusService: IVibeProviderStatusService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@ILogService private readonly _log: ILogService,
		@IModelQuirksCatalogStatusService private readonly _quirks: IModelQuirksCatalogStatusService,
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
	) {
		super();
		this._register(this._statusService.onRequestOutcome(e => this._onOutcome(e)));
	}

	private _onOutcome(event: { providerName: string; outcome: RequestOutcome }): void {
		const chain = this._config.getValue<string[]>('vibeide.providers.failoverChain') ?? [];
		if (chain.length === 0) {
			return; // failover not configured
		}

		const failoverOutcome = toFailoverOutcome(event.outcome);
		const config = { ...FAILOVER_DEFAULTS, chain };

		const state = this._states.get(event.providerName) ?? initFailoverState(event.providerName);
		const { state: nextState, decision } = processOutcome(state, failoverOutcome, Date.now(), config);
		this._states.set(event.providerName, nextState);

		if (decision.kind === 'switch') {
			this._log.warn(`[ProviderFailover] Switching provider: ${decision.from} → ${decision.to} (${decision.reason})`);
			// Two different causes deserve two different texts: "недоступен" sends the user to check
			// the network, which is the wrong place to look when the provider refused the key.
			this._notifications.notify({
				severity: Severity.Warning,
				message: decision.reason === 'auth-revoked'
					? localize(
						'vibeide.providerFailover.switchedAuth',
						'Провайдер "{0}" отклонил ключ (доступ отозван, план закончился или модель отключена). Переключаюсь на "{1}" — повторные попытки с тем же ключом не помогут.',
						decision.from,
						decision.to,
					)
					: localize(
						'vibeide.providerFailover.switched',
						'Провайдер "{0}" недоступен после 3 подряд неудач. Выполняется переключение на "{1}".',
						decision.from,
						decision.to,
					),
			});
			void this._audit.append({ actor: 'system', ts: Date.now(), action: 'provider_failover_switch', ok: true, meta: { from: decision.from, to: decision.to } });
			void this._warnIfReasoningLost(decision.from, decision.to);
		} else if (decision.kind === 'chain-exhausted') {
			this._log.error(`[ProviderFailover] All providers exhausted — last tried: ${decision.lastTriedProviderId}`);
			this._notifications.notify({
				severity: Severity.Error,
				message: localize(
					'vibeide.providerFailover.exhausted',
					'Все провайдеры в цепочке failover недоступны. Проверьте API-ключи или подключение к сети.',
				),
			});
		}
	}

	/**
	 * Say out loud when a failover throws away the reasoning built up so far.
	 *
	 * Some families bind reasoning blocks to the producing model — Anthropic says Fable 5.1 reads
	 * earlier models' thinking, but no earlier model reads its own. Nothing errors: the blocks are
	 * dropped and not billed. That silence is the whole problem — the agent carries on shallower and
	 * nobody knows why. We cannot keep the reasoning across the switch; we can refuse to lose it
	 * quietly.
	 *
	 * Best-effort by construction: the catalogue lives in the main process, and a failed lookup must
	 * never turn a provider outage into a second failure. No answer means no extra notification.
	 */
	private async _warnIfReasoningLost(fromProvider: string, toProvider: string): Promise<void> {
		try {
			const selection = this._settings.state.modelSelectionOfFeature?.['Chat'];
			const fromModel = selection?.modelName;
			if (!fromModel || fromProvider === toProvider) {
				return;
			}
			const bound = await this._quirks.isReasoningBoundToModel(fromModel, fromProvider);
			if (!reasoningLostOnSwitch({ fromModel, toModel: `${toProvider}:*`, reasoningBoundToModel: () => bound })) {
				return;
			}
			this._notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.providerFailover.reasoningLost',
					'Рассуждения модели "{0}" на новую модель не переносятся — она их не прочитает. Ход продолжится без накопленной цепочки размышлений; если ответы станут поверхностнее, причина в этом.',
					fromModel,
				),
			});
		} catch {
			// Диагностика не должна ломать восстановление после сбоя провайдера.
		}
	}
}

registerWorkbenchContribution2(
	VibeProviderFailoverContribution.ID,
	VibeProviderFailoverContribution,
	WorkbenchPhase.AfterRestored,
);
