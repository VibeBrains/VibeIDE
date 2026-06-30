/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the stealth-mode master flag in VS Code's Settings UI. Without this
// block the key read by `isEnabled()` exists only via `?? false` fallback, so
// users never see it in the editor and can't toggle privacy-strict mode
// without editing settings.json by hand. Also read by `vibeVoiceInputService`
// as a privacy gate; registration here is the single source of truth.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.stealthMode.enabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.stealthMode.enabled', 'Privacy-strict режим: блокирует облачные запросы (LLM-провайдеры с remote endpoint, embedding API, web search), embeddings считаются только локально, audit log не пишет cloud-paths. Off-by-default — явный opt-in для privacy-чувствительных сценариев.'),
		},
	},
});

export const IVibeStealthModeService = createDecorator<IVibeStealthModeService>('vibeStealthModeService');

export interface IVibeStealthModeService {
	readonly _serviceBrand: undefined;
	isEnabled(): boolean;
	enable(): void;
	disable(): void;
	readonly onChanged: Event<boolean>;
}

/**
 * VibeIDE Stealth Mode.
 * For fintech/legal/NDA projects:
 * - No prompt caching at provider
 * - Minimal audit log
 * - Auto-clears clipboard on IDE focus loss
 *
 * When enabled:
 * - Token cost forecast shows only worst case (no "with cache" line)
 * - Context window visualizer hides cache discount
 * - Agent shadow mode forced OFF
 */
class VibeStealthModeService extends Disposable implements IVibeStealthModeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onChanged = this._register(new Emitter<boolean>());
	readonly onChanged = this._onChanged.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	isEnabled(): boolean {
		return this._configurationService.getValue<boolean>('vibeide.stealthMode.enabled') ?? false;
	}

	enable(): void {
		this._configurationService.updateValue('vibeide.stealthMode.enabled', true);
		vibeLog.info('StealthMode', 'Enabled: no caching, minimal logs, clipboard auto-clear');
		this._onChanged.fire(true);
	}

	disable(): void {
		this._configurationService.updateValue('vibeide.stealthMode.enabled', false);
		vibeLog.info('StealthMode', 'Disabled');
		this._onChanged.fire(false);
	}
}

registerSingleton(IVibeStealthModeService, VibeStealthModeService, InstantiationType.Eager);
