/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeModalService } from '../common/vibeModalService.js';
import {
	VIBE_MODAL_DEFAULT_VETO_TIMEOUT_MS,
	VIBE_MODAL_DISMISS_ID,
	VibeModalOptions,
	VibeModalQueueEntry,
	VibeModalResult,
	VibeModalSize,
} from '../common/vibeModalTypes.js';

interface InternalQueueEntry<TButtonId extends string> {
	readonly id: number;
	options: VibeModalOptions;
	readonly resolve: (result: VibeModalResult<TButtonId>) => void;
}

/**
 * Invoke `options.onClose` defensively — a buggy caller hook must not break
 * the modal flow. Called from every code path that resolves a queue entry.
 */
function safeOnClose(options: VibeModalOptions, result: { buttonId: string; inputValue?: string; checked?: boolean }): void {
	if (!options.onClose) { return; }
	try {
		options.onClose(result);
	} catch (e) {
		vibeLog.warn('vibeModalServiceImpl', '[VibeModalService] onClose threw', e);
	}
}

/**
 * Live checkbox state to attach to a result, when the modal declared a checkbox. The React
 * component mirrors every toggle into `options.checkbox.initialChecked` (via `updateHeadOptions`),
 * so this reads the current value — making `checked` correct on ALL close paths (button/ESC/backdrop).
 */
function checkedFor(options: VibeModalOptions): { checked?: boolean } {
	return options.checkbox ? { checked: !!options.checkbox.initialChecked } : {};
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
					const result = { buttonId: VIBE_MODAL_DISMISS_ID, ...checkedFor(head.options) };
					head.resolve(result);
					safeOnClose(head.options, result);
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
		if (!head) { return; }
		const result = inputValue !== undefined
			? { buttonId, inputValue, ...checkedFor(head.options) }
			: { buttonId, ...checkedFor(head.options) };
		head.resolve(result);
		safeOnClose(head.options, result);
		this._onDidChangeQueue.fire();
	}

	dismissHead(): void {
		const head = this._queue[0];
		if (!head) { return; }
		// `dismissible` defaults to true. Reject dismiss only when explicitly false.
		if (head.options.dismissible === false) { return; }
		this._queue.shift();
		const result = { buttonId: VIBE_MODAL_DISMISS_ID, ...checkedFor(head.options) };
		head.resolve(result);
		safeOnClose(head.options, result);
		this._onDidChangeQueue.fire();
	}

	async dismissHeadWithVeto(): Promise<boolean> {
		const head = this._queue[0];
		if (!head) { return false; }
		if (head.options.dismissible === false) { return false; }
		const veto = head.options.onBeforeDismiss;
		if (veto) {
			// Wrap with a timeout so a hung callback can't trap the user.
			// `0` disables the timeout entirely (caller responsibility).
			const timeoutMs = head.options.onBeforeDismissTimeoutMs ?? VIBE_MODAL_DEFAULT_VETO_TIMEOUT_MS;
			let timedOut = false;
			const timeoutSentinel = Symbol('vibeModalVetoTimeout');
			const vetoCall = (async () => {
				try {
					return await veto();
				} catch (e) {
					// Defensive — a throwing callback BLOCKS dismiss (user-state preservation).
					vibeLog.warn('vibeModalServiceImpl', '[VibeModalService] onBeforeDismiss threw; blocking dismiss', e);
					return false;
				}
			})();
			let raceResult: boolean | typeof timeoutSentinel;
			if (timeoutMs > 0) {
				let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
				const timeoutPromise = new Promise<typeof timeoutSentinel>(resolve => {
					timeoutHandle = setTimeout(() => { timedOut = true; resolve(timeoutSentinel); }, timeoutMs);
				});
				raceResult = await Promise.race([vetoCall, timeoutPromise]);
				if (timeoutHandle !== null) { clearTimeout(timeoutHandle); }
			} else {
				raceResult = await vetoCall;
			}
			if (raceResult === timeoutSentinel) {
				// Timeout reached — auto-allow dismiss with a warning. Better to
				// release a stuck modal than strand the user inside it.
				vibeLog.warn('vibeModalServiceImpl', `[VibeModalService] onBeforeDismiss did not resolve within ${timeoutMs}ms; auto-allowing dismiss`);
			} else if (!raceResult && !timedOut) {
				return false;
			}
			// Head might have been resolved during the async callback wait.
			if (this._queue[0] !== head) { return false; }
		}
		this._queue.shift();
		const result = { buttonId: VIBE_MODAL_DISMISS_ID, ...checkedFor(head.options) };
		head.resolve(result);
		safeOnClose(head.options, result);
		this._onDidChangeQueue.fire();
		return true;
	}

	closeHead(buttonId?: string, inputValue?: string): void {
		const head = this._queue.shift();
		if (!head) { return; }
		const finalId = buttonId ?? VIBE_MODAL_DISMISS_ID;
		const result = inputValue !== undefined
			? { buttonId: finalId, inputValue, ...checkedFor(head.options) }
			: { buttonId: finalId, ...checkedFor(head.options) };
		head.resolve(result);
		safeOnClose(head.options, result);
		this._onDidChangeQueue.fire();
	}

	updateHeadLoading(loading: boolean): void {
		this.updateHeadOptions({ loading });
	}

	updateHeadOptions(partial: Partial<VibeModalOptions>): boolean {
		const head = this._queue[0];
		if (!head) { return false; }
		// Cheap no-op detection — if every key in `partial` matches existing,
		// skip the change-event to avoid spurious React re-renders.
		let changed = false;
		for (const key of Object.keys(partial) as (keyof VibeModalOptions)[]) {
			const existing = (head.options as unknown as Record<string, unknown>)[key as string];
			const incoming = (partial as unknown as Record<string, unknown>)[key as string];
			if (existing !== incoming) {
				changed = true;
				break;
			}
		}
		if (!changed) { return false; }
		head.options = { ...head.options, ...partial };
		this._onDidChangeQueue.fire();
		return true;
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

	showImportantInfoModal(args: {
		readonly title: string;
		readonly body: string;
		readonly icon?: string;
		readonly okLabel?: string;
		readonly size?: VibeModalSize;
		readonly autoDismissAfterMs?: number;
		readonly blocking?: boolean;
		readonly secondaryAction?: { readonly id: string; readonly label: string; readonly onClick: () => void | Promise<void> };
	}): Promise<void> {
		const buttons: Array<{ id: string; label: string; role: 'primary' | 'secondary' }> = [];
		if (args.secondaryAction) {
			buttons.push({ id: args.secondaryAction.id, label: args.secondaryAction.label, role: 'secondary' });
		}
		buttons.push({ id: 'ok', label: args.okLabel ?? 'Понятно', role: 'primary' });
		return this.showModal<string>({
			title: args.title,
			body: args.body,
			icon: args.icon ?? 'info',
			size: args.size ?? 'small',
			autoDismissAfterMs: args.autoDismissAfterMs,
			blocking: args.blocking,
			buttons,
		}).then(async result => {
			if (args.secondaryAction && result.buttonId === args.secondaryAction.id) {
				try { await args.secondaryAction.onClick(); }
				catch (e) { vibeLog.warn('vibeModalServiceImpl', '[showImportantInfoModal] secondaryAction.onClick threw', e); }
			}
		});
	}

	successModal(args: { readonly title: string; readonly body: string; readonly autoDismissAfterMs?: number; readonly size?: VibeModalSize }): Promise<void> {
		return this.showImportantInfoModal({
			title: args.title,
			body: args.body,
			icon: 'check',
			size: args.size ?? 'small',
			// Success is transient — default 4s auto-dismiss matches the
			// "Catalog updated" pattern from modelsDevCatalogRecheckAction.
			autoDismissAfterMs: args.autoDismissAfterMs ?? 4000,
			okLabel: 'Отлично',
		});
	}

	errorModal(args: { readonly title: string; readonly body: string; readonly size?: VibeModalSize }): Promise<void> {
		return this.showImportantInfoModal({
			title: args.title,
			body: args.body,
			icon: 'error',
			size: args.size ?? 'medium',
			// Errors require explicit acknowledgement — no auto-dismiss.
		});
	}

	warnModal(args: { readonly title: string; readonly body: string; readonly size?: VibeModalSize }): Promise<void> {
		return this.showImportantInfoModal({
			title: args.title,
			body: args.body,
			icon: 'warning',
			size: args.size ?? 'medium',
		});
	}
}

registerSingleton(IVibeModalService, VibeModalService, InstantiationType.Delayed);
