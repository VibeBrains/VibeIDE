/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — first-success onboarding hint (roadmap L356).
 *
 * Subscribes to `IVibeCustomCommandsService.onDidEndCommand` (success-only),
 * gates the hint through `decideOnboardingHint`, and surfaces a one-shot
 * INotificationService toast inviting the user to pin a command to the top bar.
 * State persists in `IStorageService` workspace scope (so a fresh workspace
 * starts un-shown again; user-data scope would nag once and never recover).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import {
	OnboardingHintState,
	decideOnboardingHint,
	decodeOnboardingHintState,
	freshOnboardingHintState,
	markOnboardingHintShown,
} from '../common/projectCommandsOnboarding.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';

const STORAGE_KEY = 'vibeide.commands.onboardingHint.v1';

export class VibeCustomCommandsOnboardingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeCustomCommandsOnboarding';

	/** Mirrors whether the user has clicked Pin from a palette/menu in this session. */
	private _userHasInteractedWithPin = false;

	constructor(
		@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService,
		@IStorageService private readonly _storage: IStorageService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._register(this._commands.onDidEndCommand(e => {
			if (e.outcome === 'success') {
				this._maybeShowHint();
			}
		}));
	}

	private _loadState(): OnboardingHintState {
		const raw = this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE, undefined);
		if (raw === undefined) {
			return freshOnboardingHintState();
		}
		try {
			const decoded = decodeOnboardingHintState(JSON.parse(raw));
			return decoded ?? freshOnboardingHintState();
		} catch {
			return freshOnboardingHintState();
		}
	}

	private _persist(state: OnboardingHintState): void {
		this._storage.store(STORAGE_KEY, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	private _maybeShowHint(): void {
		const state = this._loadState();
		const cmds = this._commands.getCommands();
		const hasPinnedCommand = cmds.some(c => c.pinned === true);
		const decision = decideOnboardingHint({
			state,
			hadSuccessfulRun: true,
			hasPinnedCommand,
			userHasInteractedWithPin: this._userHasInteractedWithPin,
		});
		if (decision.kind !== 'show') {
			return;
		}
		// Mark shown FIRST so a rapid second success in the same session doesn't double-fire.
		this._persist(markOnboardingHintShown(state));
		this._notifications.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.commands.onboardingHint.title',
				'VibeIDE: первая команда выполнена успешно. Закрепить её в верхнем баре?',
			),
			actions: {
				primary: [
					{
						id: PROJECT_COMMANDS_PALETTE_IDS.pin,
						enabled: true,
						label: localize('vibeide.commands.onboardingHint.pin', 'Закрепить'),
						tooltip: '',
						class: undefined,
						run: async () => {
							this._userHasInteractedWithPin = true;
							await this._commandService.executeCommand(PROJECT_COMMANDS_PALETTE_IDS.pin);
						},
					},
				],
			},
		});
	}
}

registerWorkbenchContribution2(
	VibeCustomCommandsOnboardingContribution.ID,
	VibeCustomCommandsOnboardingContribution,
	WorkbenchPhase.AfterRestored,
);
