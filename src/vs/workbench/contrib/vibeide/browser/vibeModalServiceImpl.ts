/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeModalService } from '../common/vibeModalService.js';
import { VIBE_MODAL_DISMISS_ID, VibeModalOptions, VibeModalQueueEntry, VibeModalResult } from '../common/vibeModalTypes.js';

interface InternalQueueEntry<TButtonId extends string> extends VibeModalQueueEntry {
	readonly resolve: (result: VibeModalResult<TButtonId>) => void;
}

export class VibeModalService extends Disposable implements IVibeModalService {
	declare readonly _serviceBrand: undefined;

	private readonly _queue: InternalQueueEntry<string>[] = [];
	private _nextId = 1;

	private readonly _onDidChangeQueue = this._register(new Emitter<void>());
	readonly onDidChangeQueue: Event<void> = this._onDidChangeQueue.event;

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
}

registerSingleton(IVibeModalService, VibeModalService, InstantiationType.Delayed);
