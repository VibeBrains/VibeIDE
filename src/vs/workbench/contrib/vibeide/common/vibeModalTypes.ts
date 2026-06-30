/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
	/**
	 * When true, `body` is rendered as Markdown (via ChatMarkdownRender:
	 * GFM tables, lists, code, links) instead of plain text. Opt-in only —
	 * default keeps the plain-text rendering so existing callers are unaffected
	 * and no untrusted string is ever auto-parsed as markup.
	 */
	readonly bodyMarkdown?: boolean;
	readonly buttons: ReadonlyArray<VibeModalButton<TButtonId>>;
	readonly input?: VibeModalInputSpec;
	/**
	 * Optional «remember my choice» checkbox rendered above the buttons. Its live state is reflected
	 * back into `VibeModalResult.checked` on EVERY close path (button click, ESC, backdrop) — the
	 * React component mirrors toggles into `initialChecked`, so callers read one boolean regardless
	 * of how the modal was closed. Canonical use: «Don't show this again».
	 */
	readonly checkbox?: {
		readonly label: string;
		/** Initial checked state; also used as the live value carrier (mirrored on toggle). */
		readonly initialChecked?: boolean;
	};
	/** Default true. When false, ESC + backdrop click do nothing. */
	readonly dismissible?: boolean;
	/**
	 * Default `true` — modal applies `inert` + `aria-hidden` to workbench
	 * siblings and renders a dimming backdrop, fully blocking interaction
	 * with anything beneath it (canonical modal UX).
	 *
	 * Set to `false` for an **attention-grabbing-but-non-blocking** flavour:
	 * modal renders centred but workbench stays interactive (no inert, no
	 * backdrop dim, just a floating card). Use for informational notices
	 * that deserve more weight than a toast but don't require the user to
	 * stop what they're doing (e.g. «catalog offline — info only»).
	 *
	 * **Trade-off:** non-blocking modals don't enforce attention via inert,
	 * so user CAN ignore them (similar to a toast). The advantage over toast
	 * is central placement + larger surface for actions/body text.
	 */
	readonly blocking?: boolean;
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
	 * Optional progress indicator rendered inside the loading overlay (or
	 * standalone if `loading` is false). Use when the async operation knows
	 * its step count (chunked download, multi-step pipeline). `total === 0`
	 * renders as an indeterminate bar. `label` shown above the bar.
	 *
	 * Use `updateHeadOptions({ progress: { current, total } })` to advance.
	 */
	readonly progress?: {
		readonly current: number;
		readonly total: number;
		readonly label?: string;
	};
	/**
	 * Hide the bottom keyboard-shortcut hint footer. The footer auto-generates
	 * from button hotkeys + dismissibility (e.g. «ESC закрыть · Enter применить
	 * · Y/N»). Default `true` (show). Set `false` for ultra-compact modals.
	 */
	readonly showKeyboardHint?: boolean;
	/**
	 * Explicit aria-live announcement when the modal mounts. Use when the
	 * title is generic but the body has unique info that screen readers
	 * should hear (e.g. error messages with dynamic detail). If omitted,
	 * screen readers rely on the title + body via aria-labelledby/-describedby.
	 */
	readonly announceLabel?: string;
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
	/**
	 * Safety net for `onBeforeDismiss` callbacks that hang. If the callback
	 * doesn't resolve within this duration, the veto is auto-allowed and a
	 * console warning is emitted — without this, a buggy hung callback
	 * would trap the user with no way to close the modal (ESC + backdrop
	 * both go through veto).
	 *
	 * Default 30_000 (30s). Set to 0 to disable timeout (caller takes
	 * responsibility for the callback completing).
	 */
	readonly onBeforeDismissTimeoutMs?: number;
	/**
	 * Lifecycle hook fired on first mount (DOM attached, initial focus set).
	 * Fires AT MOST once per `showModal()` call. Use for telemetry / analytics
	 * pipelines that need to know «modal is now visible». Errors swallowed
	 * with `console.warn` — a buggy hook MUST NOT break the modal flow.
	 */
	readonly onMount?: () => void;
	/**
	 * Lifecycle hook fired AFTER the modal is resolved/dismissed (queue head
	 * advanced). Receives the same shape as `showModal()` resolves with.
	 * Synchronous; runs before the next queued modal mounts.
	 *
	 * Distinct from `await showModal()` — use this for fire-and-forget callers
	 * (notification pipelines, side-channel observers) that don't track the
	 * returned promise but still want a hook on close. Errors swallowed with
	 * `console.warn`.
	 */
	readonly onClose?: (result: { buttonId: string; inputValue?: string; checked?: boolean }) => void;
}

/** Lower bound for `autoDismissAfterMs` — anything shorter is a visual flash. */
export const VIBE_MODAL_MIN_AUTO_DISMISS_MS = 500;

/** Default timeout for `onBeforeDismiss` callbacks (30 seconds). */
export const VIBE_MODAL_DEFAULT_VETO_TIMEOUT_MS = 30_000;

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
	/** Live checkbox state at close time, when `options.checkbox` was set; undefined otherwise. */
	readonly checked?: boolean;
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
