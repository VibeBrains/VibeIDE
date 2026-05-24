/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeModalService } from '../common/vibeModalService.js';
import { VIBE_MODAL_DISMISS_ID, VibeModalOptions, VibeModalQueueEntry, VibeModalResult, VibeModalSize } from '../common/vibeModalTypes.js';

interface InternalQueueEntry<TButtonId extends string> {
	readonly id: number;
	options: VibeModalOptions;
	readonly resolve: (result: VibeModalResult<TButtonId>) => void;
}

export class VibeModalService extends Disposable implements IVibeModalService {
	declare readonly _serviceBrand: undefined;

	private readonly _queue: InternalQueueEntry<string>[] = [];
	private _nextId = 1;

	private readonly _onDidChangeQueue = this._register(new Emitter<void>());
	readonly onDidChangeQueue: Event<void> = this._onDidChangeQueue.event;

	constructor() {
		super();
		// Audit fix — on dispose, drain pending modals so awaiting callers don't
		// hang forever (window close path was leaking `await showModal(...)`
		// promises into orphaned state). Resolved as `__dismiss__` so caller
		// branch logic treats it as user-cancelled.
		this._register({
			dispose: () => {
				while (this._queue.length > 0) {
					const head = this._queue.shift()!;
					head.resolve({ buttonId: VIBE_MODAL_DISMISS_ID });
				}
			},
		});
	}

	showModal<TButtonId extends string = string>(options: VibeModalOptions<TButtonId>): Promise<VibeModalResult<TButtonId>> {
		return new Promise<VibeModalResult<TButtonId>>(resolve => {
			const entry: InternalQueueEntry<TButtonId> = {
				id: this._nextId++,
				options: options as VibeModalOptions,
				resolve,
			};
			this._queue.push(entry as InternalQueueEntry<string>);
			this._onDidChangeQueue.fire();
		});
	}

	getQueue(): ReadonlyArray<VibeModalQueueEntry> {
		return this._queue.map(({ id, options }) => ({ id, options }));
	}

	resolveHead(buttonId: string, inputValue?: string): void {
		const head = this._queue.shift();
		if (!head) return;
		const result = inputValue !== undefined
			? { buttonId, inputValue }
			: { buttonId };
		head.resolve(result);
		this._onDidChangeQueue.fire();
	}

	dismissHead(): void {
		const head = this._queue[0];
		if (!head) return;
		// `dismissible` defaults to true. Reject dismiss only when explicitly false.
		if (head.options.dismissible === false) return;
		this._queue.shift();
		head.resolve({ buttonId: VIBE_MODAL_DISMISS_ID });
		this._onDidChangeQueue.fire();
	}

	updateHeadLoading(loading: boolean): void {
		const head = this._queue[0];
		if (!head) return;
		if (!!head.options.loading === !!loading) return;
		head.options = { ...head.options, loading };
		this._onDidChangeQueue.fire();
	}

	confirmModal(args: {
		readonly title: string;
		readonly body?: string;
		readonly icon?: string;
		readonly okLabel?: string;
		readonly cancelLabel?: string;
		readonly danger?: boolean;
		readonly size?: VibeModalSize;
	}): Promise<boolean> {
		return this.showModal<'ok' | 'cancel'>({
			title: args.title,
			body: args.body,
			icon: args.icon,
			size: args.size,
			buttons: [
				{ id: 'cancel', label: args.cancelLabel ?? 'Отмена', role: 'secondary' },
				{ id: 'ok', label: args.okLabel ?? 'OK', role: args.danger ? 'danger' : 'primary' },
			],
		}).then(result => result.buttonId === 'ok');
	}
}

registerSingleton(IVibeModalService, VibeModalService, InstantiationType.Delayed);
