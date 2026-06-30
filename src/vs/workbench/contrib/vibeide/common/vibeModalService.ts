/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { VibeModalOptions, VibeModalQueueEntry, VibeModalResult } from './vibeModalTypes.js';

export const IVibeModalService = createDecorator<IVibeModalService>('vibeModalService');

/**
 * Renderer-side service for displaying VibeModal dialogs. Replaces ad-hoc
 * uses of `IDialogService.confirm()` when the interaction needs richer UI
 * (icons, multi-line body, validated input, branded styling) or stickiness
 * (notification toasts can be dismissed without action — modals require it).
 *
 * Usage:
 *   const { buttonId, inputValue } = await vibeModalService.showModal({
 *     title: 'Подтвердить удаление',
 *     body: 'Файл будет удалён без возможности восстановления.',
 *     buttons: [
 *       { id: 'ok', label: 'Удалить', role: 'danger' },
 *       { id: 'cancel', label: 'Отмена', role: 'secondary' },
 *     ],
 *   });
 *   if (buttonId === 'ok') ...
 *
 * Queueing: when multiple modals are requested concurrently, they're shown
 * one at a time (FIFO). The React container always renders the head of the
 * queue. This keeps focus management deterministic and avoids stacked
 * modals fighting over Tab order.
 *
 * Service is renderer-side. Main-process callers must route through
 * an IPC channel (not in scope for v1; toasts via INotificationService
 * remain the option for main).
 */
export interface IVibeModalService {
	readonly _serviceBrand: undefined;

	/**
	 * Show a modal and resolve with the user's choice. Resolves with
	 * `buttonId === '__dismiss__'` if the user pressed ESC / clicked
	 * backdrop (only when `dismissible !== false`).
	 *
	 * Multiple concurrent calls are queued FIFO.
	 */
	showModal<TButtonId extends string = string>(
		options: VibeModalOptions<TButtonId>,
	): Promise<VibeModalResult<TButtonId>>;

	/**
	 * Read the current queue snapshot. Used by the React container to render
	 * the head modal. The container should subscribe to `onDidChangeQueue`
	 * for updates instead of polling.
	 */
	getQueue(): ReadonlyArray<VibeModalQueueEntry>;

	/**
	 * Fires whenever an entry is added, resolved, or removed. The React
	 * container subscribes to this and re-renders with `getQueue()`.
	 */
	readonly onDidChangeQueue: Event<void>;

	/**
	 * Programmatically resolve the head modal with a specific button id.
	 * Used for tests and for keyboard shortcuts that need to commit a choice
	 * without a real click. No-op if no modal is active.
	 */
	resolveHead(buttonId: string, inputValue?: string): void;

	/**
	 * Dismiss the head modal (equivalent to ESC). Only succeeds if the
	 * modal has `dismissible !== false`. No-op otherwise.
	 *
	 * Note: this is the SYNCHRONOUS path — bypasses `onBeforeDismiss`. Use
	 * `dismissHeadWithVeto()` when you want the veto callback respected.
	 */
	dismissHead(): void;

	/**
	 * Async dismiss path that honors `onBeforeDismiss`. Returns `true` if
	 * the dismiss went through, `false` if the callback vetoed it or the
	 * modal is not dismissible. Errors in the callback are treated as a
	 * block (defensive — don't lose user state on a thrown callback).
	 */
	dismissHeadWithVeto(): Promise<boolean>;

	/**
	 * Programmatic close — bypasses `dismissible: false` AND any
	 * `onBeforeDismiss` veto. For internal callers (e.g. a Command that
	 * opened a loading-modal and now finished its async work). Resolves with
	 * the supplied buttonId if any matches a button in the head's options,
	 * otherwise with `__dismiss__`.
	 */
	closeHead(buttonId?: string, inputValue?: string): void;

	/**
	 * Toggle the head modal's `loading` flag. Equivalent to
	 * `updateHeadOptions({ loading })`. Kept as a separate method for the
	 * common case (loading is by far the most-toggled field).
	 */
	updateHeadLoading(loading: boolean): void;

	/**
	 * Generic update for the head modal's options. Merges `partial` into the
	 * current options shape and fires `onDidChangeQueue`. Use for: progress
	 * messages (body), button state changes (disabled), in-flight validation
	 * tweaks, etc. The IMMUTABLE fields are: `title`, `input`, `dismissible`,
	 * `onBeforeDismiss` — they may technically be updated but doing so
	 * mid-flight is confusing for users, prefer to leave those alone.
	 *
	 * Returns `true` if the update was applied, `false` if no head modal.
	 *
	 * Example progress flow:
	 *   const p = svc.showModal({ ..., loading: true });
	 *   for (let i = 1; i <= 10; i++) {
	 *     await tick();
	 *     svc.updateHeadOptions({ body: `Step ${i}/10 — processing...` });
	 *   }
	 *   svc.closeHead();
	 */
	updateHeadOptions(partial: Partial<import('./vibeModalTypes.js').VibeModalOptions>): boolean;

	/**
	 * Shorthand for the common confirm pattern. Returns `true` on the primary
	 * button, `false` on secondary OR dismiss. Saves callers ~10 lines per use.
	 */
	confirmModal(args: {
		readonly title: string;
		readonly body?: string;
		readonly icon?: string;
		readonly okLabel?: string;
		readonly cancelLabel?: string;
		readonly danger?: boolean;
		readonly size?: import('./vibeModalTypes.js').VibeModalSize;
	}): Promise<boolean>;

	/**
	 * Shorthand for «info» pattern: title + body + one «Понятно» button.
	 * Used for important non-actionable info that should be shown as a modal
	 * (not toast) but doesn't need user choice — only acknowledgement.
	 *
	 * Returns when the user dismissed/clicked OK. Auto-dismiss timing is
	 * optional; default infinite (user must explicitly close).
	 */
	showImportantInfoModal(args: {
		readonly title: string;
		readonly body: string;
		readonly icon?: string;
		readonly okLabel?: string;
		readonly size?: import('./vibeModalTypes.js').VibeModalSize;
		readonly autoDismissAfterMs?: number;
		/** When false, modal floats centered without blocking workbench. Default true. */
		readonly blocking?: boolean;
		/**
		 * Optional secondary button shown to the LEFT of the OK button.
		 * Use for «info modal with a quick action» — e.g. "Скопировать URL"
		 * next to "Понятно". `id === 'ok'` is reserved for the primary
		 * acknowledgement.
		 */
		readonly secondaryAction?: { readonly id: string; readonly label: string; readonly onClick: () => void | Promise<void> };
	}): Promise<void>;

	/**
	 * Severity-specific presets — pre-configured icon + sensible defaults for
	 * the three common notification flavours. Save callers from constructing
	 * the option object manually. `autoDismissAfterMs` opt-in (success uses
	 * it by default since it's transient; error/warn don't — user must ack).
	 */
	successModal(args: { readonly title: string; readonly body: string; readonly autoDismissAfterMs?: number; readonly size?: import('./vibeModalTypes.js').VibeModalSize }): Promise<void>;
	errorModal(args: { readonly title: string; readonly body: string; readonly size?: import('./vibeModalTypes.js').VibeModalSize }): Promise<void>;
	warnModal(args: { readonly title: string; readonly body: string; readonly size?: import('./vibeModalTypes.js').VibeModalSize }): Promise<void>;
}
