/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VibeModal — types shared between renderer-side service and React UI.
 *
 * Theming policy: ALL styling MUST go through `var(--vscode-*)` tokens, NOT
 * `vibe-*` tailwind classes. Custom themes (Vibe Neon overrides) work because
 * the underlying token keys are themable; non-Vibe themes (Default Dark+,
 * Light+, High Contrast) keep modals looking native. See `vibeModal.css`
 * comment block for the full token map.
 */

/**
 * Semantic role of a modal button. Drives styling AND keyboard semantics:
 *  - `primary` — focused first; activated by Enter when input not focused.
 *  - `secondary` — neutral; standard Tab order.
 *  - `danger`   — destructive intent (delete, force-overwrite). Themed with
 *                 error tokens so it's visually distinct in any theme.
 */
export type VibeModalButtonRole = 'primary' | 'secondary' | 'danger';

export interface VibeModalButton<TId extends string = string> {
	readonly id: TId;
	readonly label: string;
	readonly role?: VibeModalButtonRole;
	readonly disabled?: boolean;
	/**
	 * Optional keyboard shortcut — a single character (case-insensitive).
	 * Pressing this character anywhere inside the modal (with the input NOT
	 * focused, to avoid stealing typing) activates this button as if clicked.
	 * Useful for «Y/N» style confirmations: `[ {id:'ok', hotkey:'Y'}, {id:'no', hotkey:'N'} ]`.
	 *
	 * Note: ESC is reserved for dismiss; Enter is reserved for the primary
	 * button. Use any other single character (A-Z, 0-9, simple punctuation).
	 */
	readonly hotkey?: string;
}

export interface VibeModalInputSpec {
	readonly placeholder?: string;
	readonly initialValue?: string;
	readonly multiline?: boolean;
	/**
	 * Optional validator. Returns `null` if valid, OR an error string to show
	 * inline below the input. While the validator returns non-null, the
	 * `primary` button is auto-disabled.
	 */
	readonly validator?: (value: string) => string | null;
}

/**
 * Modal size variant — drives max-width via CSS class (`size-{small,medium,large}`).
 * Default `medium` (560px). Use `small` for confirmations, `large` for diff/preview.
 */
export type VibeModalSize = 'small' | 'medium' | 'large';

/**
 * Static body — markdown-shaped plain string (no HTML for v1).
 * Future: support React node body once the input shape is settled.
 */
export interface VibeModalOptions<TButtonId extends string = string> {
	readonly title: string;
	readonly body?: string;
	readonly buttons: ReadonlyArray<VibeModalButton<TButtonId>>;
	readonly input?: VibeModalInputSpec;
	/** Default true. When false, ESC + backdrop click do nothing. */
	readonly dismissible?: boolean;
	/** Optional codicon name (e.g. `info`, `warning`, `error`). */
	readonly icon?: string;
	/** Default `medium`. Controls modal max-width via CSS class. */
	readonly size?: VibeModalSize;
	/**
	 * When true, the modal renders a loading overlay (spinner) on top of
	 * content and all buttons are disabled. Useful for showing async progress
	 * inside the modal (e.g. «Saving...») without dismounting. Caller toggles
	 * via `updateHeadLoading(true|false)` on the service.
	 */
	readonly loading?: boolean;
	/**
	 * If set, the modal auto-dismisses after the given duration (milliseconds).
	 * Resolves with `__dismiss__` unless the user clicked a button first.
	 * Implementation pauses the timer while the modal is `loading` (auto-close
	 * during async work would be a footgun). Hover/focus pauses the timer too —
	 * users actively reading should not be timed out.
	 *
	 * Use for transient success messages (e.g. «Saved», «Catalog updated»).
	 * Don't use for anything requiring an action.
	 */
	readonly autoDismissAfterMs?: number;
	/**
	 * Optional pre-dismiss veto callback. Runs on ESC, backdrop click, AND
	 * auto-dismiss. Returns `true` to allow dismiss, `false` to block it.
	 * Use case: «Unsaved changes — really close?» style confirmations.
	 * Errors are treated as a block (defensive — don't lose user state on
	 * a thrown callback).
	 *
	 * NOT invoked by the explicit button-click path, `resolveHead()`, or
	 * `closeHead()` — those are deliberate caller intent.
	 */
	readonly onBeforeDismiss?: () => boolean | Promise<boolean>;
}

/**
 * Result of a modal interaction.
 *  - `buttonId` is the id of the clicked button OR the sentinel `__dismiss__`
 *    when ESC/backdrop closed the modal (only possible if `dismissible !== false`).
 *  - `inputValue` is the input field value (always a string; trimmed by caller
 *    if desired) when `input` was specified in options; undefined otherwise.
 */
export interface VibeModalResult<TButtonId extends string = string> {
	readonly buttonId: TButtonId | '__dismiss__';
	readonly inputValue?: string;
}

/** Sentinel used in `buttonId` when the modal was dismissed (ESC/backdrop). */
export const VIBE_MODAL_DISMISS_ID = '__dismiss__' as const;

/**
 * Internal — entry in the service's display queue. The React container
 * reads this shape via `IVibeModalService.getQueue()`.
 */
export interface VibeModalQueueEntry {
	readonly id: number;
	readonly options: VibeModalOptions;
}
