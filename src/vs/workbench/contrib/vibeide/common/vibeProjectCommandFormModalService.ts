/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { AddCommandDraft } from './projectCommandsAddFormPolicy.js';

export interface VibeProjectCommandFormModalProps {
	readonly mode: 'add' | 'edit';
	/** For edit: the original (immutable) id. */
	readonly commandIdForEdit?: string;
	/** Prefilled draft (edit mode). Undefined ⇒ empty draft (add mode). */
	readonly initialDraft?: AddCommandDraft;
}

export const IVibeProjectCommandFormModalService = createDecorator<IVibeProjectCommandFormModalService>('vibeProjectCommandFormModalService');

/**
 * Bridge between the `vibeide.commands.add` / `vibeide.commands.editById` actions and the React
 * Add/Edit form modal. Replaces the old editor-tab host (`VibeProjectCommandFormPane`): the same
 * form now renders inside a resizable modal. The action sets `props` and flips `isOpen`; the React
 * `VibeProjectCommandFormModal` subscribes and shows/hides itself.
 */
export interface IVibeProjectCommandFormModalService {
	readonly _serviceBrand: undefined;
	readonly isOpen: boolean;
	readonly props: VibeProjectCommandFormModalProps | null;
	readonly onDidChange: Event<void>;
	open(props: VibeProjectCommandFormModalProps): void;
	close(): void;
}

class VibeProjectCommandFormModalService extends Disposable implements IVibeProjectCommandFormModalService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _isOpen = false;
	private _props: VibeProjectCommandFormModalProps | null = null;

	get isOpen(): boolean { return this._isOpen; }
	get props(): VibeProjectCommandFormModalProps | null { return this._props; }

	open(props: VibeProjectCommandFormModalProps): void {
		this._props = props;
		this._isOpen = true;
		this._onDidChange.fire();
	}

	close(): void {
		if (!this._isOpen) { return; }
		this._isOpen = false;
		this._onDidChange.fire();
	}
}

registerSingleton(IVibeProjectCommandFormModalService, VibeProjectCommandFormModalService, InstantiationType.Delayed);
