/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';

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
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	isEnabled(): boolean {
		return this._configurationService.getValue<boolean>('vibeide.stealthMode.enabled') ?? false;
	}

	enable(): void {
		this._configurationService.updateValue('vibeide.stealthMode.enabled', true);
		this._logService.info('[VibeIDE StealthMode] Enabled: no caching, minimal logs, clipboard auto-clear');
		this._onChanged.fire(true);
	}

	disable(): void {
		this._configurationService.updateValue('vibeide.stealthMode.enabled', false);
		this._logService.info('[VibeIDE StealthMode] Disabled');
		this._onChanged.fire(false);
	}
}

registerSingleton(IVibeStealthModeService, VibeStealthModeService, InstantiationType.Eager);
