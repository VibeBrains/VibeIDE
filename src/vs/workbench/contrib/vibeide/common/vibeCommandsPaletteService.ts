/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export const IVibeCommandsPaletteService = createDecorator<IVibeCommandsPaletteService>('vibeCommandsPaletteService');

/**
 * Tiny renderer-side bridge between the «VibeIDE Команды» Action2 (browser) and
 * the React overlay (`VibeCommandsPalette`). The command flips `open`; the React
 * component subscribes to `onDidChangeOpen` and shows/hides its resizable window.
 *
 * Deliberately NOT routed through `IVibeModalService`: that service is a FIFO
 * queue of string-body, fixed-size modals — it can't host an interactive,
 * user-resizable command list. See docs/knowledge/architecture/commands-palette-modal.md.
 */
export interface IVibeCommandsPaletteService {
	readonly _serviceBrand: undefined;
	readonly isOpen: boolean;
	readonly onDidChangeOpen: Event<boolean>;
	open(): void;
	close(): void;
	toggle(): void;
}

class VibeCommandsPaletteService extends Disposable implements IVibeCommandsPaletteService {
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

registerSingleton(IVibeCommandsPaletteService, VibeCommandsPaletteService, InstantiationType.Delayed);
