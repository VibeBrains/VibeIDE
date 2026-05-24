/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeModalButton, VibeModalQueueEntry } from '../../../../common/vibeModalTypes.js';

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
export const VibeModal: React.FC<{ entry: VibeModalQueueEntry; isActive: boolean }> = ({ entry, isActive }) => {
	const accessor = useAccessor();
	const modalService = accessor.get('IVibeModalService');
	const { options } = entry;

	const [inputValue, setInputValue] = useState(options.input?.initialValue ?? '');
	const [validationError, setValidationError] = useState<string | null>(null);
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
		if (!isActive) return;
		if (options.loading) return; // don't grab focus while loading; buttons are disabled
		if (inputRef.current) { inputRef.current.focus(); return; }
		if (firstFocusableRef.current) { firstFocusableRef.current.focus(); return; }
		// Fallback — focus the first interactive element we can find inside modal.
		const firstBtn = modalRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
		firstBtn?.focus();
	}, [isActive, entry.id, options.loading]);

	// ESC handler (only when dismissible !== false AND not loading).
	useEffect(() => {
		if (!isActive) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && options.dismissible !== false && !options.loading) {
				e.preventDefault();
				modalService.dismissHead();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [isActive, options.dismissible, options.loading, modalService]);

	const onButtonClick = useCallback((btn: VibeModalButton) => {
		if (btn.disabled) return;
		if (options.loading) return;
		if (btn.role === 'primary' && validationError) return;
		modalService.resolveHead(btn.id, options.input ? inputValue : undefined);
	}, [modalService, options.input, options.loading, inputValue, validationError]);

	const onBackdropClick = useCallback(() => {
		if (options.dismissible === false) return;
		if (options.loading) return;
		modalService.dismissHead();
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
		if (e.key !== 'Tab' || !modalRef.current) return;
		const focusables = Array.from(
			modalRef.current.querySelectorAll<HTMLElement>('input, textarea, button:not(:disabled)'),
		);
		if (focusables.length === 0) return;
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
	const sizeClass = `size-${options.size ?? 'medium'}`;
	let assignedPrimary = false;

	return (
		<>
			<div className="vibeide-modal-backdrop" onClick={onBackdropClick} />
			<div
				ref={modalRef}
				className={`vibeide-modal ${sizeClass}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={options.body ? bodyId : undefined}
				aria-busy={options.loading ? true : undefined}
				onKeyDown={onTrapKeyDown}
			>
				<div className="vibeide-modal-header">
					{options.icon && (
						<span className={`vibeide-modal-icon codicon codicon-${options.icon}`} aria-hidden="true" />
					)}
					<h2 id={titleId} className="vibeide-modal-title">{options.title}</h2>
				</div>

				{options.body && (
					<div id={bodyId} className="vibeide-modal-body">{options.body}</div>
				)}

				{options.input && (
					<div className="vibeide-modal-input-wrap">
						{options.input.multiline ? (
							<textarea
								ref={r => { inputRef.current = r; }}
								className={`vibeide-modal-textarea${validationError ? ' is-invalid' : ''}`}
								placeholder={options.input.placeholder}
								value={inputValue}
								onChange={e => setInputValue(e.target.value)}
								onKeyDown={onInputKeyDown}
								aria-invalid={!!validationError}
							/>
						) : (
							<input
								ref={r => { inputRef.current = r; }}
								className={`vibeide-modal-input${validationError ? ' is-invalid' : ''}`}
								type="text"
								placeholder={options.input.placeholder}
								value={inputValue}
								onChange={e => setInputValue(e.target.value)}
								onKeyDown={onInputKeyDown}
								aria-invalid={!!validationError}
							/>
						)}
						<div className="vibeide-modal-validation" role="alert">
							{validationError ?? ''}
						</div>
					</div>
				)}

				<div className="vibeide-modal-buttons">
					{options.buttons.map(btn => {
						const role = btn.role ?? 'secondary';
						const disabled = !!btn.disabled
							|| !!options.loading
							|| (role === 'primary' && !!validationError);
						const ref = !assignedPrimary && role === 'primary' ? firstFocusableRef : null;
						if (ref) assignedPrimary = true;
						return (
							<button
								key={btn.id}
								ref={ref}
								type="button"
								className={`vibeide-modal-button role-${role}`}
								disabled={disabled}
								onClick={() => onButtonClick(btn)}
							>
								{btn.label}
							</button>
						);
					})}
				</div>

				{options.loading && (
					<div className="vibeide-modal-loading-overlay" aria-hidden="true">
						<div className="vibeide-modal-loading-spinner" />
					</div>
				)}
			</div>
		</>
	);
};
