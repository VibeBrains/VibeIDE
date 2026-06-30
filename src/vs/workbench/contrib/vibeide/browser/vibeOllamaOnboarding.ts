/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOllamaInstallerService } from '../common/ollamaInstallerService.js';

const OLLAMA_PROBED_KEY = 'vibeide.ollamaProbed';
const OLLAMA_REDETECT_CMD = 'vibeide.ollama.redetect';

/**
 * VibeIDE Ollama / LM Studio Onboarding.
 * Detects local models on startup, shows setup notification.
 * Privacy-first: if Ollama is found, suggests switching to local models.
 */
export class VibeOllamaOnboardingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeOllamaOnboarding';

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IOllamaInstallerService private readonly _ollamaInstaller: IOllamaInstallerService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		// Check after 3s — non-blocking
		setTimeout(() => this._detectLocalModels(), 3000);
	}

	private async _detectLocalModels(): Promise<void> {
		// Probe at most once per profile.
		if (this._storageService.get(OLLAMA_PROBED_KEY, StorageScope.APPLICATION)) { return; }

		// Mark probed up-front so a crash mid-probe still prevents repeats.
		this._storageService.store(OLLAMA_PROBED_KEY, 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);

		try {
			// Probe runs in main process via Node net.connect — no Chromium DevTools network log on failure.
			const result = await this._ollamaInstaller.probe();
			if (!result.running) { return; }

			this._notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'vibeOllamaDetected',
					'🦙 Обнаружен Ollama с {0} моделями! VibeIDE может использовать локальные модели — без API-ключа, полная конфиденциальность.',
					result.modelCount
				),
				actions: {
					primary: [{
						id: 'vibeide.ollama.configure',
						label: localize('vibeConfigure', 'Настроить Ollama'),
						tooltip: '',
						class: undefined,
						enabled: true,
						checked: false,
						run: () => {
							// Open VibeIDE provider settings
						},
					}],
					secondary: [],
				}
			});
		} catch {
			// Probe failed — silently skip
		}
	}
}

registerWorkbenchContribution2(
	VibeOllamaOnboardingContribution.ID,
	VibeOllamaOnboardingContribution,
	WorkbenchPhase.AfterRestored
);

CommandsRegistry.registerCommand(OLLAMA_REDETECT_CMD, (accessor: ServicesAccessor) => {
	accessor.get(IStorageService).remove(OLLAMA_PROBED_KEY, StorageScope.APPLICATION);
	accessor.get(INotificationService).notify({
		severity: Severity.Info,
		message: localize('vibeOllamaRedetect', 'Определение Ollama сброшено. Перезапустите VibeIDE для повторного обнаружения локальных моделей.'),
	});
});
