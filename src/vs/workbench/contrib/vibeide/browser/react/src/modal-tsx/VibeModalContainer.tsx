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
	// restore it when the modal closes.
	const [restoreFocusEl, setRestoreFocusEl] = useState<HTMLElement | null>(null);
	useEffect(() => {
		if (queue.length > 0 && !restoreFocusEl) {
			const active = document.activeElement;
			if (active instanceof HTMLElement) setRestoreFocusEl(active);
		} else if (queue.length === 0 && restoreFocusEl) {
			restoreFocusEl.focus?.();
			setRestoreFocusEl(null);
		}
	}, [queue.length, restoreFocusEl]);

	const head = queue[0];

	return (
		<div className={`vibeide-modal-root${head ? ' is-active' : ''}`} aria-hidden={head ? undefined : true}>
			{head && <VibeModal entry={head} isActive={true} />}
		</div>
	);
};
