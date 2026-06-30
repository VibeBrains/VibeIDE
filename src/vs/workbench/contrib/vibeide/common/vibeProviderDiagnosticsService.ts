/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export const IVibeProviderDiagnosticsService = createDecorator<IVibeProviderDiagnosticsService>('vibeProviderDiagnosticsService');

/**
 * Tiny renderer-side bridge between the «Проверка провайдеров» Action2 (browser) and
 * the React overlay (`VibeProviderDiagnostics`). The command flips `open`; the React
 * component subscribes to `onDidChangeOpen` and shows/hides its resizable window.
 *
 * Same pattern as IVibeCommandsPaletteService — deliberately NOT routed through
 * IVibeModalService (which is a FIFO queue of fixed-size, string-body modals and
 * can't host an interactive, user-resizable diagnostics surface).
 * See docs/knowledge/architecture/provider-diagnostics.md.
 */
export interface IVibeProviderDiagnosticsService {
	readonly _serviceBrand: undefined;
	readonly isOpen: boolean;
	readonly onDidChangeOpen: Event<boolean>;
	open(): void;
	close(): void;
	toggle(): void;
}

class VibeProviderDiagnosticsService extends Disposable implements IVibeProviderDiagnosticsService {
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

registerSingleton(IVibeProviderDiagnosticsService, VibeProviderDiagnosticsService, InstantiationType.Delayed);
