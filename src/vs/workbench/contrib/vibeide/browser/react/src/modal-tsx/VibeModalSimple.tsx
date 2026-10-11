/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VIBE_MODAL_MIN_AUTO_DISMISS_MS, VibeModalButton, VibeModalQueueEntry } from '../../../../common/vibeModalTypes.js';
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js';
import { AgentRoleModels } from '../vibe-settings-tsx/AgentRoleModels.js';
import { useImageAttachments } from '../util/useImageAttachments.js';
import { usePDFAttachments } from '../util/usePDFAttachments.js';

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
	// Numeric override fields (below the main input) — initialised from each field's default.
	const [fieldValues, setFieldValues] = useState<Record<string, number>>(() =>
		Object.fromEntries((options.numberFields ?? []).map(f => [f.id, f.default])));
	const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
	const firstFocusableRef = useRef<HTMLButtonElement | null>(null);
	const modalRef = useRef<HTMLDivElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	// File attachments (only when options.imageInput) — reuses the chat composer's converters so
	// drag-drop / paste / file-pick produce the same `ChatImageAttachment` / `ChatPDFAttachment`
	// shapes used everywhere. Images ride the message as image parts; PDFs contribute extracted text.
	// NOTE: attachments live in this modal instance; they do NOT survive a «Роли» sub-modal round-trip
	// (a fresh VibeModalSimple mounts). The primary attach→run flow is unaffected.
	const imageInput = !!options.imageInput && !!options.input;
	const { attachments: images, addImages, removeImage } = useImageAttachments();
	const { attachments: pdfs, addPDFs, removePDF } = usePDFAttachments();
	const addAttachmentFiles = useCallback((fileList: FileList | null | undefined) => {
		const files = Array.from(fileList ?? []);
		const imgs = files.filter(f => f.type.startsWith('image/'));
		const docs = files.filter(f => f.type === 'application/pdf');
		if (imgs.length) { void addImages(imgs); }
		if (docs.length) { void addPDFs(docs); }
	}, [addImages, addPDFs]);

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
			modalService.resolveHead(btn.id, options.input ? inputValue : undefined, options.numberFields ? fieldValues : undefined, imageInput ? images : undefined, imageInput ? pdfs : undefined);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [options.dismissible, options.loading, options.buttons, options.input, options.numberFields, validationError, inputValue, fieldValues, modalService]);

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
		modalService.resolveHead(btn.id, options.input ? inputValue : undefined, options.numberFields ? fieldValues : undefined, imageInput ? images : undefined, imageInput ? pdfs : undefined);
	}, [modalService, options.input, options.numberFields, options.loading, inputValue, fieldValues, validationError]);

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
			modalService.resolveHead(primaryButton.id, inputValue, options.numberFields ? fieldValues : undefined, imageInput ? images : undefined, imageInput ? pdfs : undefined);
		}
	}, [options.input, options.numberFields, primaryButton, validationError, modalService, inputValue, fieldValues]);

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
				{/* Shared top-right close «×» — the standard way to close any dismissible modal (mirrors ESC).
				    Hidden for non-dismissible modals, where ESC/backdrop are also inert. */}
				{options.dismissible !== false && (
					<button
						type="button"
						className="@@vibeide-modal-close @@codicon @@codicon-close"
						aria-label="Закрыть"
						title="Закрыть (Esc)"
						disabled={options.loading}
						onClick={() => { void modalService.dismissHeadWithVeto(); }}
					/>
				)}
				<div className="@@vibeide-modal-header">
					{options.icon && (
						<span className={`@@vibeide-modal-icon @@codicon @@codicon-${options.icon}`} aria-hidden="true" />
					)}
					<h2 id={titleId} className="@@vibeide-modal-title">{options.title}</h2>
				</div>

				{options.body && (
					<div id={bodyId} className="@@vibeide-modal-body @@vibe-scroll">
						{options.bodyMarkdown
							? <ChatMarkdownRender string={options.body} chatMessageLocation={undefined} />
							: options.body}
					</div>
				)}

				{options.contentKey && (
					<div className="@@vibeide-modal-content">
						{options.contentKey === 'agentRoleModels' && <AgentRoleModels />}
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
								onPaste={imageInput ? (e => { const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/') || f.type === 'application/pdf'); if (files.length) { e.preventDefault(); addAttachmentFiles(e.clipboardData.files); } }) : undefined}
								onDrop={imageInput ? (e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addAttachmentFiles(e.dataTransfer.files); } }) : undefined}
								onDragOver={imageInput ? (e => e.preventDefault()) : undefined}
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
								onPaste={imageInput ? (e => { const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/') || f.type === 'application/pdf'); if (files.length) { e.preventDefault(); addAttachmentFiles(e.clipboardData.files); } }) : undefined}
								aria-invalid={!!validationError}
							/>
						)}
						{imageInput && (
							<div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
								<button
									type="button"
									title="Прикрепить картинку или PDF (или перетащите / вставьте в поле)"
									onClick={() => fileInputRef.current?.click()}
									style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer', padding: '2px 8px', borderRadius: '6px', border: '1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent))', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)' }}
								>
									📎 Прикрепить
								</button>
								<input
									ref={fileInputRef}
									type="file"
									accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,application/pdf"
									multiple
									style={{ display: 'none' }}
									onChange={e => { addAttachmentFiles(e.target.files); e.target.value = ''; }}
								/>
								{images.map(img => (
									<span
										key={img.id}
										title={img.filename}
										style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', maxWidth: '160px', padding: '2px 6px', borderRadius: '6px', border: '1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent))', color: 'var(--vscode-input-foreground)', opacity: img.uploadStatus === 'failed' ? 0.6 : 1 }}
									>
										<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>🖼 {img.filename}</span>
										<button type="button" title="Убрать" onClick={() => removeImage(img.id)} style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: 0, lineHeight: 1 }}>✕</button>
									</span>
								))}
								{pdfs.map(pdf => (
									<span
										key={pdf.id}
										title={pdf.filename}
										style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', maxWidth: '180px', padding: '2px 6px', borderRadius: '6px', border: '1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent))', color: 'var(--vscode-input-foreground)', opacity: pdf.uploadStatus === 'failed' ? 0.6 : 1 }}
									>
										<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {pdf.filename}{pdf.uploadStatus === 'processing' ? ' …' : ''}</span>
										<button type="button" title="Убрать" onClick={() => removePDF(pdf.id)} style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: 0, lineHeight: 1 }}>✕</button>
									</span>
								))}
							</div>
						)}
						<div className="@@vibeide-modal-validation" role="alert">
							{validationError ?? ''}
						</div>
					</div>
				)}

				{options.numberFields && options.numberFields.length > 0 && (
					<div className="@@vibeide-modal-numberfields">
						{options.numberFields.map(f => (
							<label key={f.id} className="@@vibeide-modal-numberfield">
								<span className="@@vibeide-modal-numberfield-label">{f.label}</span>
								<span className="@@vibeide-modal-numberfield-control">
									<input
										type="number"
										className="@@vibeide-modal-input"
										value={fieldValues[f.id] ?? f.default}
										min={f.min}
										max={f.max}
										disabled={options.loading}
										onChange={e => {
											const raw = Number(e.target.value);
											const clamped = Number.isFinite(raw)
												? Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, Math.floor(raw)))
												: f.default;
											setFieldValues(prev => ({ ...prev, [f.id]: clamped }));
										}}
									/>
								</span>
							</label>
						))}
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
					{options.footerLeftButton && (
						<button
							type="button"
							className={`@@vibeide-modal-button @@role-${options.footerLeftButton.role ?? 'secondary'} @@vibeide-modal-footer-left`}
							disabled={!!options.footerLeftButton.disabled || !!options.loading}
							onClick={() => onButtonClick(options.footerLeftButton!)}
						>
							{renderButtonLabel(options.footerLeftButton.label, options.footerLeftButton.hotkey)}
						</button>
					)}
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
