/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeModal } from './VibeModal.js';
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
			if (active instanceof HTMLElement) setRestoreFocusEl(active);
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
	useEffect(() => {
		const portal = document.getElementById('vibeide-modal-portal');
		const workbench = portal?.parentElement ?? document.body;
		if (!workbench) return;
		// Apply to every direct child of workbench EXCEPT our portal.
		const targets: HTMLElement[] = [];
		for (const child of Array.from(workbench.children)) {
			if (child === portal) continue;
			if (!(child instanceof HTMLElement)) continue;
			targets.push(child);
		}
		if (head) {
			for (const el of targets) {
				el.setAttribute('inert', '');
				el.setAttribute('aria-hidden', 'true');
			}
		} else {
			for (const el of targets) {
				el.removeAttribute('inert');
				el.removeAttribute('aria-hidden');
			}
		}
		return () => {
			// Cleanup if container unmounts while modal active — restore inert state.
			for (const el of targets) {
				el.removeAttribute('inert');
				el.removeAttribute('aria-hidden');
			}
		};
	}, [head]);

	return (
		<div className={`vibeide-modal-root${head ? ' is-active' : ''}`} aria-hidden={head ? undefined : true}>
			{head && <VibeModal entry={head} isActive={true} />}
		</div>
	);
};
