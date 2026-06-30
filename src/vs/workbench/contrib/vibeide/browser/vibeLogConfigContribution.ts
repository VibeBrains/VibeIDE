/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Bridges the `vibeide.logging.*` settings into the `vibeLog` singleton (vibeLog.ts).
// The singleton is process-global and DI-free, so this renderer contribution reads
// the live config on startup and re-applies it on every change. Other processes
// (electron-main) run on vibeLog's defaults until IPC wiring lands.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { vibeLog } from '../common/vibeLog.js';

class VibeLogConfigContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeLogConfig';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretDetectionService private readonly secretDetectionService: ISecretDetectionService,
	) {
		super();
		this.apply();

		// Redact secrets in EVERY vibeLog output (console, ring buffer → clipboard, Output
		// channel, persistent file). firstRunValidation only wraps console.*, so without this
		// the buffer/file/clipboard paths would carry raw secrets.
		vibeLog.setRedactor(args => {
			try {
				if (!this.secretDetectionService.getConfig().enabled) { return args; }
				const r = this.secretDetectionService.redactSecretsInObject(args as unknown[]);
				return r.hasSecrets ? r.redacted : args;
			} catch {
				return args; // redaction must never break logging
			}
		});
		this._register({ dispose: () => vibeLog.setRedactor(undefined) });

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.logging')) {
				this.apply();
			}
		}));
	}

	private apply(): void {
		const c = this.configurationService;
		vibeLog.configure({
			enabled: c.getValue<boolean>('vibeide.logging.enabled'),
			level: c.getValue<string>('vibeide.logging.level'),
			categories: c.getValue<string[]>('vibeide.logging.categories'),
			categoryLevels: c.getValue<{ [category: string]: string }>('vibeide.logging.categoryLevels'),
			timestamps: c.getValue<boolean>('vibeide.logging.timestamps'),
			bufferSize: c.getValue<number>('vibeide.logging.bufferSize'),
			dedupe: c.getValue<boolean>('vibeide.logging.collapseRepeats'),
		});
	}
}

registerWorkbenchContribution2(VibeLogConfigContribution.ID, VibeLogConfigContribution, WorkbenchPhase.BlockStartup);
