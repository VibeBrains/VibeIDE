/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IVibeSettingsNavigationService {
	readonly _serviceBrand: undefined;

	/** Fires when a section is asked for while the settings are already on screen */
	readonly onDidRequestSection: Event<string>;

	/** Ask the VibeIDE settings to show a section (`agents`, `mcp`…): a command opens them, and they open on it */
	requestSection(section: string): void;

	/**
	 * The section asked for before the settings were on screen, taken once
	 * The request survives until the view mounts and asks, as it does for the chat history popover
	 */
	pullPendingSection(): string | undefined;
}

export const IVibeSettingsNavigationService = createDecorator<IVibeSettingsNavigationService>('vibeSettingsNavigationService');

class VibeSettingsNavigationService extends Disposable implements IVibeSettingsNavigationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequestSection = this._register(new Emitter<string>());
	readonly onDidRequestSection: Event<string> = this._onDidRequestSection.event;

	private _pending: string | undefined;

	requestSection(section: string): void {
		this._pending = section;
		this._onDidRequestSection.fire(section);
	}

	pullPendingSection(): string | undefined {
		const section = this._pending;
		this._pending = undefined;
		return section;
	}
}

registerSingleton(IVibeSettingsNavigationService, VibeSettingsNavigationService, InstantiationType.Delayed);
