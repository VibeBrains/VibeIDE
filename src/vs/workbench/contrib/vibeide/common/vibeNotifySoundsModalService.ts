/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export const IVibeNotifySoundsModalService = createDecorator<IVibeNotifySoundsModalService>('vibeNotifySoundsModalService');

/**
 * Renderer-side bridge between the «VibeIDE Звуки» Action2 (brain menu / palette) and the React
 * overlay (`VibeNotifySounds`). The command flips `open`; the React component subscribes to
 * `onDidChangeOpen` and shows/hides its resizable sound-editor window. Same pattern as
 * IVibeProviderDiagnosticsService (deliberately NOT routed through the fixed-size IVibeModalService).
 */
export interface IVibeNotifySoundsModalService {
	readonly _serviceBrand: undefined;
	readonly isOpen: boolean;
	readonly onDidChangeOpen: Event<boolean>;
	open(): void;
	close(): void;
	toggle(): void;
}

class VibeNotifySoundsModalService extends Disposable implements IVibeNotifySoundsModalService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeOpen = this._register(new Emitter<boolean>());
	readonly onDidChangeOpen = this._onDidChangeOpen.event;

	private _isOpen = false;
	get isOpen(): boolean { return this._isOpen; }

	open(): void {
		if (this._isOpen) { return; }
		this._isOpen = true;
		this._onDidChangeOpen.fire(true);
	}

	close(): void {
		if (!this._isOpen) { return; }
		this._isOpen = false;
		this._onDidChangeOpen.fire(false);
	}

	toggle(): void {
		this._isOpen ? this.close() : this.open();
	}
}

registerSingleton(IVibeNotifySoundsModalService, VibeNotifySoundsModalService, InstantiationType.Delayed);
