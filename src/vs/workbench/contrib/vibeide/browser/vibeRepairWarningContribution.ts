/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * #6 — startup reminder that the broken-tool-call auto-repair is ON.
 *
 * The repair adds an extra LLM round-trip on malformed-tool-call turns (slower). It's a
 * compatibility/debug aid, ON by default. Without a visible reminder, users could blame
 * the app for latency they can't attribute. So while it's enabled we warn once per window
 * launch, with a one-click «Отключить». Once disabled, the warning stops (config is off).
 */

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';

const REPAIR_SETTING = 'vibeide.llm.repairBrokenToolCalls';
const DELAY_MS = 6_000;

export class VibeRepairWarningContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeRepairWarning';

	private readonly _delay = this._register(new MutableDisposable());

	constructor(
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		// Delay so the warning doesn't compete with other startup toasts.
		const handle = setTimeout(() => this._maybeWarn(), DELAY_MS);
		this._delay.value = { dispose: () => clearTimeout(handle) };
	}

	private _maybeWarn(): void {
		// Default true — only stay silent when explicitly disabled.
		if (this._configuration.getValue<boolean>(REPAIR_SETTING) === false) { return; }
		this._notifications.notify({
			severity: Severity.Warning,
			message: localize('vibeide.llm.repairWarning', 'VibeIDE: авто-починка битых tool-call\'ов ВКЛЮЧЕНА (режим отладки совместимости). На сбойных ходах добавляется доп. обращение к модели — может замедлять. Включайте только для отладки проблемных моделей.'),
			actions: {
				primary: [
					{
						id: 'vibeide.llm.repairWarning.disable',
						label: localize('vibeide.llm.repairWarning.disable', 'Отключить'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => { void this._configuration.updateValue(REPAIR_SETTING, false, ConfigurationTarget.APPLICATION); },
					},
					{
						id: 'vibeide.llm.repairWarning.keep',
						label: localize('vibeide.llm.repairWarning.keep', 'Оставить'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => { /* keep enabled */ },
					},
				],
			},
		});
	}
}

registerWorkbenchContribution2(
	VibeRepairWarningContribution.ID,
	VibeRepairWarningContribution,
	WorkbenchPhase.Eventually,
);
