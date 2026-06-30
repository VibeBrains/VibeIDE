/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

const FIRST_RUN_KEY = 'vibeide.firstRunWizardCompleted';
const WIZARD_VERSION = '1.0.0';

/**
 * VibeIDE First-run Security Wizard.
 *
 * Shown on first launch. Configures:
 * - Trust Score level (Manual/Supervised/Auto)
 * - Token budget ($20/500k default)
 * - Workspace isolation (on by default)
 * - Update channel (stable/beta/nightly)
 * - Local model setup (Ollama detection)
 *
 * Phase 1: notification-based wizard (simple, no extra UI deps)
 * Phase 2: full modal dialog with React component
 */
export class VibeFirstRunWizardContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeFirstRunWizard';

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		// Run after workbench is fully restored (non-blocking)
		setTimeout(() => this._checkFirstRun(), 2000);
	}

	private _checkFirstRun(): void {
		const completed = this._storageService.get(FIRST_RUN_KEY, StorageScope.APPLICATION);
		if (completed === WIZARD_VERSION) { return; } // Already completed

		this._showWelcome();
	}

	private _showWelcome(): void {
		// Phase 1: notification-based wizard
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeFirstRun',
				'Добро пожаловать в VibeIDE! 👋 Trust Score установлен в Manual 🟢 — каждое действие агента требует подтверждения. Нажмите, чтобы настроить.'
			),
			actions: {
				primary: [
					{
						id: 'vibeide.firstRun.configure',
						label: localize('vibeFirstRunConfigure', 'Настроить'),
						tooltip: '',
						class: undefined,
						enabled: true,
						checked: false,
						run: () => this._runWizard(),
					},
					{
						id: 'vibeide.firstRun.skip',
						label: localize('vibeFirstRunSkip', 'Оставить по умолчанию'),
						tooltip: '',
						class: undefined,
						enabled: true,
						checked: false,
						run: () => this._markCompleted(),
					}
				],
				secondary: [],
			},
		});
	}

	private _runWizard(): void {
		// Phase 1: open settings at VibeIDE section
		this._commandService.executeCommand('workbench.action.openSettings', 'vibeide').catch(() => { });

		// Show quick setup notifications
		setTimeout(() => {
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'vibeFirstRunDefaults',
					'Параметры по умолчанию VibeIDE: 🟢 Trust Score «Manual», 💰 лимит токенов 500k (~$20), 🔒 изоляция воркспейса включена. Изменить — в «Настройки → VibeIDE».'
				),
			});
		}, 500);

		this._markCompleted();
	}

	private _markCompleted(): void {
		this._storageService.store(FIRST_RUN_KEY, WIZARD_VERSION, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

registerWorkbenchContribution2(
	VibeFirstRunWizardContribution.ID,
	VibeFirstRunWizardContribution,
	WorkbenchPhase.AfterRestored
);
