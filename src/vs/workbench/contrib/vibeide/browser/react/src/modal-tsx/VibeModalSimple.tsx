/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VIBE_MODAL_MIN_AUTO_DISMISS_MS, VibeModalButton, VibeModalQueueEntry } from '../../../../common/vibeModalTypes.js';
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js';

/** Lower bound for the post-pause `remaining` clamp — avoids zero/negative
 *  timer values after rapid hover-in/out cycles. */
const MIN_REMAINING_MS_AFTER_PAUSE = 50;

/** Session-scoped dedupe for autoDismiss clamp warnings — log once, not on
 *  every modal that uses a too-small value. */
let _autoDismissClampWarned = false;

/**
 * Renders the button label with the hotkey character underlined (first
 * case-insensitive occurrence). Falls back to plain text if no hotkey or no
 * match in the label.
 */
const renderButtonLabel = (label: string, hotkey?: string): React.ReactNode => {
	if (!hotkey || hotkey.length === 0) {return label;}
	const idx = label.toLowerCase().indexOf(hotkey.toLowerCase());
	if (idx === -1) {
		// Show hotkey hint at end for accessibility: «Apply (Y)».
		return <>{label}<span className="@@vibeide-modal-button-hotkey-hint"> ({hotkey.toUpperCase()})</span></>;
	}
	return (
		<>
			{label.slice(0, idx)}
			<u>{label[idx]}</u>
			{label.slice(idx + 1)}
		</>
	);
};

/**
 * Renders a single modal — the head of the queue. Container handles fade-in
 * animation via `.is-active` class on the root element (set by parent).
 *
 * Theming: ALL styling lives in `media/vibeModal.css` and uses `var(--vscode-*)`
 * tokens. No inline color styles, no `vibe-*` Tailwind classes.
 *
 * Accessibility:
 *  - role="dialog", aria-modal="true"
 *  - aria-labelledby points at the title h2
 *  - Focus trapped within modal (Tab/Shift+Tab cycle)
 *  - ESC dismisses if `dismissible !== false`
 *  - Enter activates the FIRST primary button when input is not focused (or
 *    input is single-line; multiline textareas keep Enter for newlines)
 *  - Focus returns to previously-focused element on close (handled by container)
 */
// The component is only rendered when there's a head modal, so `isActive`
// would always be `true`. Effect deps that previously gated on `isActive`
// are kept (`true` literal) — they re-fire when the entry changes.
export const VibeModalSimple: React.FC<{ entry: VibeModalQueueEntry }> = ({ entry }) => {
	const accessor = useAccessor();
	const modalService = accessor.get('IVibeModalService');
	const { options } = entry;

	const [inputValue, setInputValue] = useState(options.input?.initialValue ?? '');
	const [validationError, setValidationError] = useState<string | null>(null);
	const [checked, setChecked] = useState(options.checkbox?.initialChecked ?? false);
	const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
	const firstFocusableRef = useRef<HTMLButtonElement | null>(null);
	const modalRef = useRef<HTMLDivElement | null>(null);

	// Validate input value on every change. Primary button auto-disables while
	// validator returns a non-null error string.
	useEffect(() => {
		if (!options.input?.validator) {
			setValidationError(null);
			return;
		}
		const err = options.input.validator(inputValue);
		setValidationError(err);
	}, [inputValue, options.input]);

	const primaryButton = useMemo(() => options.buttons.find(b => b.role === 'primary'), [options.buttons]);

	// Initial focus: input → first primary button → ANY first button (audit
	// fallback for modals with only secondary/danger buttons and no input).
	useEffect(() => {
		if (options.loading) {return;} // don't grab focus while loading; buttons are disabled
		if (inputRef.current) { inputRef.current.focus(); return; }
		if (firstFocusableRef.current) { firstFocusableRef.current.focus(); return; }
		// Fallback — focus the first interactive element we can find inside modal.
		const firstBtn = modalRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
		firstBtn?.focus();
	}, [entry.id, options.loading]);

	// onMount lifecycle — fire once per modal instance, after first focus is set.
	// Errors swallowed so a buggy hook can't break the modal flow.
	useEffect(() => {
		if (!options.onMount) {return;}
		try { options.onMount(); }
		catch (e) { vibeLog.warn('VibeModalSimple', '[VibeModalSimple] onMount threw', e); }
		// Intentionally only fires on entry.id change; options.onMount changes
		// shouldn't refire (caller expectation: «mount» = once per showModal call).
	}, [entry.id]);

	// ESC + hotkey handler. ESC honors dismissible + loading + onBeforeDismiss.
	// Hotkeys (per-button single-char shortcut) activate buttons without click.
	useEffect(() => {
		const hotkeyMap = new Map<string, VibeModalButton>();
		for (const btn of options.buttons) {
			if (btn.hotkey && btn.hotkey.length > 0) {
				hotkeyMap.set(btn.hotkey.toLowerCase(), btn);
			}
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && options.dismissible !== false && !options.loading) {
				e.preventDefault();
				void modalService.dismissHeadWithVeto();
				return;
			}
			// Hotkey activation — skip when modifier keys held or input is focused.
			if (e.ctrlKey || e.altKey || e.metaKey || options.loading) {return;}
			const targetIsInput = (e.target instanceof HTMLElement)
				&& (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
			if (targetIsInput) {return;}
			const btn = hotkeyMap.get(e.key.toLowerCase());
			if (!btn || btn.disabled) {return;}
			if (btn.role === 'primary' && validationError) {return;}
			e.preventDefault();
			modalService.resolveHead(btn.id, options.input ? inputValue : undefined);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [options.dismissible, options.loading, options.buttons, options.input, validationError, inputValue, modalService]);

	// autoDismissAfterMs — timer that fires dismiss after the given duration.
	// Paused while loading (no auto-close during async work). Also paused on
	// hover/focus inside the modal — active reading should not be timed out.
	useEffect(() => {
		const rawMs = options.autoDismissAfterMs;
		if (!rawMs || rawMs <= 0) {return;}
		if (options.loading) {return;} // paused during async
		if (options.dismissible === false) {return;} // can't dismiss anyway
		// Clamp to a sensible minimum — anything shorter is a visual flash.
		const ms = Math.max(VIBE_MODAL_MIN_AUTO_DISMISS_MS, rawMs);
		if (rawMs < VIBE_MODAL_MIN_AUTO_DISMISS_MS && !_autoDismissClampWarned) {
			_autoDismissClampWarned = true;
			vibeLog.warn('VibeModalSimple', `[VibeModalSimple] autoDismissAfterMs=${rawMs}ms is below the floor (${VIBE_MODAL_MIN_AUTO_DISMISS_MS}ms); clamped. Anything shorter is a visual flash — pick >= ${VIBE_MODAL_MIN_AUTO_DISMISS_MS}ms.`);
		}
		let cancelled = false;
		let pausedByHover = false;
		let remaining = ms;
		let startedAt = Date.now();
		let timerId: ReturnType<typeof setTimeout> | null = null;
		const start = () => {
			startedAt = Date.now();
			timerId = setTimeout(() => {
				if (cancelled) {return;}
				void modalService.dismissHeadWithVeto();
			}, remaining);
		};
		const pause = () => {
			if (timerId === null) {return;}
			clearTimeout(timerId);
			timerId = null;
			remaining -= Date.now() - startedAt;
			if (remaining < MIN_REMAINING_MS_AFTER_PAUSE) {remaining = MIN_REMAINING_MS_AFTER_PAUSE;}
		};
		const onEnter = () => { pausedByHover = true; pause(); };
		const onLeave = () => { if (pausedByHover) { pausedByHover = false; start(); } };
		const el = modalRef.current;
		el?.addEventListener('mouseenter', onEnter);
		el?.addEventListener('mouseleave', onLeave);
		el?.addEventListener('focusin', onEnter);
		el?.addEventListener('focusout', onLeave);
		start();
		return () => {
			cancelled = true;
			if (timerId !== null) {clearTimeout(timerId);}
			el?.removeEventListener('mouseenter', onEnter);
			el?.removeEventListener('mouseleave', onLeave);
			el?.removeEventListener('focusin', onEnter);
			el?.removeEventListener('focusout', onLeave);
		};
	}, [options.autoDismissAfterMs, options.loading, options.dismissible, entry.id, modalService]);

	const onButtonClick = useCallback((btn: VibeModalButton) => {
		if (btn.disabled) {return;}
		if (options.loading) {return;}
		if (btn.role === 'primary' && validationError) {return;}
		modalService.resolveHead(btn.id, options.input ? inputValue : undefined);
	}, [modalService, options.input, options.loading, inputValue, validationError]);

	const onBackdropClick = useCallback(() => {
		if (options.dismissible === false) {return;}
		if (options.loading) {return;}
		void modalService.dismissHeadWithVeto();
	}, [modalService, options.dismissible, options.loading]);

	const onInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		// Enter on single-line input commits the primary button. On multiline
		// textarea Enter inserts newline (default behavior); Ctrl/Cmd+Enter
		// commits the primary button.
		const multiline = options.input?.multiline === true;
		const commit = !multiline ? e.key === 'Enter' && !e.shiftKey : (e.key === 'Enter' && (e.ctrlKey || e.metaKey));
		if (commit && primaryButton && !validationError) {
			e.preventDefault();
			modalService.resolveHead(primaryButton.id, inputValue);
		}
	}, [options.input, primaryButton, validationError, modalService, inputValue]);

	// Focus trap: cycle Tab within modal. Implementation captures focusable
	// elements at render time; for v1 that's input + buttons.
	const onTrapKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Tab' || !modalRef.current) {return;}
		const focusables = Array.from(
			modalRef.current.querySelectorAll<HTMLElement>('input, textarea, button:not(:disabled)'),
		);
		if (focusables.length === 0) {return;}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement as HTMLElement | null;
		if (e.shiftKey && active === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}, []);

	const titleId = `vibeide-modal-title-${entry.id}`;
	const bodyId = `vibeide-modal-body-${entry.id}`;
	// `@@` is scope-tailwind's ignore-prefix marker: it strips `@@` and leaves the
	// class UNPREFIXED (verified). Without it the build rewrites `vibeide-modal` →
	// `vibe-vibeide-modal`, which no longer matches the hand-written `vibeModal.css`
	// (loaded via workbench contribution, outside the tailwind pipeline) → the modal
	// renders unstyled/fullscreen with dead buttons. Every modal class is `@@`-marked
	// so it ships raw and the CSS applies. codicon* MUST also stay raw (icon font).
	// Built as a variable → scope-tailwind doesn't see it → already ships raw (no
	// `@@` needed). The inline `@@vibeide-modal` literal below DOES need `@@`.
	const sizeClass = `size-${options.size ?? 'medium'}`;
	const hintParts = buildKeyboardHint(options);
	let assignedPrimary = false;

	return (
		<>
			<div className="@@vibeide-modal-backdrop" onClick={onBackdropClick} />
			<div
				ref={modalRef}
				className={`@@vibeide-modal ${sizeClass}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={options.body ? bodyId : undefined}
				aria-busy={options.loading ? true : undefined}
				onKeyDown={onTrapKeyDown}
			>
				<div className="@@vibeide-modal-header">
					{options.icon && (
						<span className={`@@vibeide-modal-icon @@codicon @@codicon-${options.icon}`} aria-hidden="true" />
					)}
					<h2 id={titleId} className="@@vibeide-modal-title">{options.title}</h2>
				</div>

				{options.body && (
					<div id={bodyId} className="@@vibeide-modal-body">
						{options.bodyMarkdown
							? <ChatMarkdownRender string={options.body} chatMessageLocation={undefined} />
							: options.body}
					</div>
				)}

				{options.input && (
					<div className="@@vibeide-modal-input-wrap">
						{options.input.multiline ? (
							<textarea
								ref={r => { inputRef.current = r; }}
								className={`@@vibeide-modal-textarea${validationError ? ' @@is-invalid' : ''}`}
								placeholder={options.input.placeholder}
								value={inputValue}
								onChange={e => setInputValue(e.target.value)}
								onKeyDown={onInputKeyDown}
								aria-invalid={!!validationError}
							/>
						) : (
							<input
								ref={r => { inputRef.current = r; }}
								className={`@@vibeide-modal-input${validationError ? ' @@is-invalid' : ''}`}
								type="text"
								placeholder={options.input.placeholder}
								value={inputValue}
								onChange={e => setInputValue(e.target.value)}
								onKeyDown={onInputKeyDown}
								aria-invalid={!!validationError}
							/>
						)}
						<div className="@@vibeide-modal-validation" role="alert">
							{validationError ?? ''}
						</div>
					</div>
				)}

				{options.checkbox && (
					<label className="@@vibeide-modal-checkbox">
						<input
							type="checkbox"
							checked={checked}
							disabled={options.loading}
							onChange={e => {
								const next = e.target.checked;
								setChecked(next);
								// Mirror into head options so the service reports `checked` on EVERY close
								// path (button click, ESC, backdrop) — see checkedFor() in the impl.
								if (options.checkbox) {
									modalService.updateHeadOptions({ checkbox: { label: options.checkbox.label, initialChecked: next } });
								}
							}}
						/>
						<span>{options.checkbox.label}</span>
					</label>
				)}

				<div className="@@vibeide-modal-buttons">
					{options.buttons.map(btn => {
						const role = btn.role ?? 'secondary';
						const disabled = !!btn.disabled
							|| !!options.loading
							|| (role === 'primary' && !!validationError);
						const ref = !assignedPrimary && role === 'primary' ? firstFocusableRef : null;
						if (ref) {assignedPrimary = true;}
						return (
							<button
								key={btn.id}
								ref={ref}
								type="button"
								className={`@@vibeide-modal-button @@role-${role}`}
								disabled={disabled}
								onClick={() => onButtonClick(btn)}
								title={btn.hotkey ? `${btn.label} (${btn.hotkey.toUpperCase()})` : undefined}
							>
								{renderButtonLabel(btn.label, btn.hotkey)}
							</button>
						);
					})}
				</div>

				{options.progress && (
					<div className="@@vibeide-modal-progress">
						{options.progress.label && (
							<div className="@@vibeide-modal-progress-label">{options.progress.label}</div>
						)}
						<div className="@@vibeide-modal-progress-track">
							{options.progress.total === 0 ? (
								<div className="@@vibeide-modal-progress-bar @@is-indeterminate" />
							) : (
								<div
									className="@@vibeide-modal-progress-bar"
									style={{ width: `${Math.max(0, Math.min(100, (options.progress.current / options.progress.total) * 100))}%` }}
								/>
							)}
						</div>
					</div>
				)}

				{options.showKeyboardHint !== false && hintParts.length > 0 && (
					<div className="@@vibeide-modal-keyboard-hint" aria-hidden="true">
						{hintParts.map((part, idx) => (
							<React.Fragment key={idx}>
								{idx > 0 && <span>{' · '}</span>}
								<span><kbd>{part.key}</kbd>{' '}{part.action}</span>
							</React.Fragment>
						))}
					</div>
				)}

				{options.announceLabel && (
					<div className="@@vibeide-modal-sr-only" role="status" aria-live="polite">
						{options.announceLabel}
					</div>
				)}

				{options.loading && (
					<div className="@@vibeide-modal-loading-overlay" aria-hidden="true">
						<div className="@@vibeide-modal-loading-spinner" />
					</div>
				)}
			</div>
		</>
	);
};

/**
 * Build the keyboard-hint footer parts from button hotkeys + dismissibility.
 * Returns ordered list `[{key, action}, ...]` rendered by `<kbd>` chips.
 * Empty array → footer hidden entirely.
 *
 * Multiline input behaviour: when the modal has a multiline textarea, Enter
 * inserts a newline (default browser behaviour) and Ctrl/Cmd+Enter commits
 * the primary button — so the hint shows the actual commit shortcut, not a
 * lie that misleads the user. Single-line input keeps Enter = commit.
 */
const buildKeyboardHint = (options: VibeModalQueueEntry['options']): Array<{ key: string; action: string }> => {
	const parts: Array<{ key: string; action: string }> = [];
	if (options.dismissible !== false && !options.loading) {
		parts.push({ key: 'Esc', action: 'закрыть' });
	}
	const primary = options.buttons.find(b => b.role === 'primary');
	if (primary && !primary.disabled && !options.loading) {
		const isMultilineInput = options.input?.multiline === true;
		const commitKey = isMultilineInput ? (isMacLike() ? '⌘+Enter' : 'Ctrl+Enter') : 'Enter';
		parts.push({ key: commitKey, action: primary.label.toLowerCase() });
	}
	if (!options.loading) {
		for (const b of options.buttons) {
			if (!b.hotkey || b.disabled) {continue;}
			// Skip duplicate of primary if Enter already covers it AND there's no
			// separate hotkey-binding intent (same action twice in the hint is noise).
			parts.push({ key: b.hotkey.toUpperCase(), action: b.label.toLowerCase() });
		}
	}
	return parts;
};

const isMacLike = (): boolean => {
	if (typeof navigator === 'undefined') {return false;}
	return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
};
