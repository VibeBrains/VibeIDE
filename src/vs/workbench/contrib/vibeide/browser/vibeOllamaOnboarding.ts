/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';
import { asText } from '../../../../platform/request/common/request.js';

const OLLAMA_DETECTED_KEY = 'vibeide.ollamaDetected';
const OLLAMA_URL = 'http://localhost:11434/api/tags';

/**
 * VibeIDE Ollama / LM Studio Onboarding.
 * Detects local models on startup, shows setup notification.
 * Privacy-first: if Ollama is found, suggests switching to local models.
 */
export class VibeOllamaOnboardingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeOllamaOnboarding';

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IRequestService private readonly _requestService: IRequestService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		// Check after 3s — non-blocking
		setTimeout(() => this._detectLocalModels(), 3000);
	}

	private async _detectLocalModels(): Promise<void> {
		// Only notify once
		if (this._storageService.get(OLLAMA_DETECTED_KEY, StorageScope.APPLICATION)) return;

		try {
			const response = await this._requestService.request(
				{ url: OLLAMA_URL, type: 'GET', callSite: 'vibeide-ollama-detect' },
				CancellationToken.None
			);

			if (response.res.statusCode === 200) {
				const text = await asText(response);
				const data = text ? JSON.parse(text) : null;
				const modelCount = data?.models?.length || 0;

				this._storageService.store(OLLAMA_DETECTED_KEY, 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);

				this._notificationService.notify({
					severity: Severity.Info,
					message: localize(
						'vibeOllamaDetected',
						'🦙 Ollama detected with {0} model(s)! VibeIDE can use local models — no API key needed, complete privacy.',
						modelCount
					),
					actions: {
						primary: [{
							id: 'vibeide.ollama.configure',
							label: localize('vibeConfigure', 'Configure Ollama'),
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
			}
		} catch {
			// Ollama not running — silently skip
		}
	}
}

registerWorkbenchContribution2(
	VibeOllamaOnboardingContribution.ID,
	VibeOllamaOnboardingContribution,
	WorkbenchPhase.AfterRestored
);
