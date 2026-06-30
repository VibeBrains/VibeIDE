/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useEffect, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeModalSimple } from './VibeModalSimple.js';
import { VibeModalQueueEntry } from '../../../../common/vibeModalTypes.js';

/**
 * Workbench-level modal mount point. Subscribes to `IVibeModalService` queue
 * changes and renders the head entry. When queue is empty, root has no
 * `is-active` class — backdrop fades out and pointer-events drop to none
 * so the underlying editor remains interactive.
 *
 * Returns focus to the previously-focused element when the modal closes.
 * (Important for keyboard users — modal-triggered actions should not strand
 * focus.)
 */
export const VibeModalContainer: React.FC = () => {
	const accessor = useAccessor();
	const modalService = accessor.get('IVibeModalService');

	const [queue, setQueue] = useState<ReadonlyArray<VibeModalQueueEntry>>(() => modalService.getQueue());

	useEffect(() => {
		const sub = modalService.onDidChangeQueue(() => {
			setQueue(modalService.getQueue());
		});
		return () => sub.dispose();
	}, [modalService]);

	// Track the element that had focus before the modal opened so we can
	// restore it when the modal closes. `isConnected` guard handles the case
	// where the trigger element was removed from DOM while the modal was open
	// (e.g. parent component unmounted) — without the guard, `.focus()` on
	// a detached element silently no-ops but leaks the reference.
	const [restoreFocusEl, setRestoreFocusEl] = useState<HTMLElement | null>(null);
	useEffect(() => {
		if (queue.length > 0 && !restoreFocusEl) {
			const active = document.activeElement;
			if (active instanceof HTMLElement) {setRestoreFocusEl(active);}
		} else if (queue.length === 0 && restoreFocusEl) {
			if (restoreFocusEl.isConnected) {
				restoreFocusEl.focus?.();
			}
			setRestoreFocusEl(null);
		}
	}, [queue.length, restoreFocusEl]);

	const head = queue[0];

	// a11y — when a modal is active, mark the rest of the workbench as inert
	// + aria-hidden so screen readers + keyboard nav can't escape the modal
	// via assistive-tech jump commands (e.g. screen reader heading navigation).
	// Standard pattern is `inert` attribute on siblings of the portal root.
	//
	// AUDIT-FIX: we save EACH element's ORIGINAL attribute values before
	// mutating, so cleanup restores rather than clobbers. Without this,
	// `removeAttribute('aria-hidden')` on a child that VS Code had set
	// aria-hidden=true on (collapsed sidebar, etc) would corrupt a11y
	// state once the modal closes.
	useEffect(() => {
		if (!head) {return;} // Effect only meaningful while a modal is active.
		// `blocking: false` modals don't take over workbench — skip inert apply
		// entirely. Centred floating card without backdrop, workbench stays
		// fully interactive (the trade-off: easier to ignore than a blocking
		// modal, but still more prominent than a toast).
		if (head.options.blocking === false) {
			vibeLog.warn('VibeModalContainer', `[VibeModalContainer] non-blocking modal id=${head.id} — skipping inert apply`);
			return;
		}
		const portal = document.getElementById('vibeide-modal-portal');
		const workbench = portal?.parentElement ?? document.body;
		if (!workbench) {return;}
		const restores: Array<{ el: HTMLElement; inert: string | null; ariaHidden: string | null }> = [];
		try {
			for (const child of Array.from(workbench.children)) {
				if (child === portal) {continue;}
				if (!(child instanceof HTMLElement)) {continue;}
				restores.push({
					el: child,
					inert: child.getAttribute('inert'),
					ariaHidden: child.getAttribute('aria-hidden'),
				});
				child.setAttribute('inert', '');
				child.setAttribute('aria-hidden', 'true');
			}
			vibeLog.warn('VibeModalContainer', `[VibeModalContainer] inert applied to ${restores.length} workbench siblings for modal id=${head.id}`);
		} catch (e) {
			// If anything in the apply loop throws, we still register the cleanup
			// so partially-inerted siblings get restored — better than leaving
			// the workbench locked.
			vibeLog.warn('VibeModalContainer', '[VibeModalContainer] inert apply threw — partial restore on cleanup', e);
		}
		return () => {
			try {
				for (const { el, inert, ariaHidden } of restores) {
					if (inert === null) {el.removeAttribute('inert');}
					else {el.setAttribute('inert', inert);}
					if (ariaHidden === null) {el.removeAttribute('aria-hidden');}
					else {el.setAttribute('aria-hidden', ariaHidden);}
				}
				vibeLog.warn('VibeModalContainer', `[VibeModalContainer] inert restored for ${restores.length} siblings (modal id=${head.id} closed)`);
			} catch (e) {
				// Cleanup MUST NOT silently fail — log loudly so we can diagnose
				// if the workbench gets stuck inert. If any element couldn't be
				// restored, surface it; user can then F12 → see the warning →
				// force-restore via DevTools while we ship a real fix.
				vibeLog.error('VibeModalContainer', '[VibeModalContainer] inert restore FAILED — workbench may be stuck. To force-unblock: document.querySelectorAll(".monaco-workbench > *").forEach(el => { el.removeAttribute("inert"); el.removeAttribute("aria-hidden"); });', e);
			}
		};
	}, [head]);

	const nonBlocking = head?.options.blocking === false;
	// NOTE: this class list is built as a VARIABLE (not an inline `className={...}`
	// literal), so scope-tailwind never sees it → never prefixes it. These ship
	// raw as-is and match `vibeModal.css` directly — no `@@` ignore-marker needed
	// (unlike VibeModalSimple.tsx, whose inline literals DO get prefixed without `@@`).
	const rootClassName = `vibeide-modal-root${head ? ' is-active' : ''}${nonBlocking ? ' non-blocking' : ''}`;

	return (
		<div className={rootClassName} aria-hidden={head ? undefined : true}>
			{head && <VibeModalSimple entry={head} />}
		</div>
	);
};
