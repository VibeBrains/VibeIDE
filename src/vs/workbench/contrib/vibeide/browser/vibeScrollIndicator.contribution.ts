/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, isHTMLElement, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

/** Class that `vibeScroll.css` reads to keep the thumb drawn while its container is being scrolled */
export const VIBE_SCROLLING_CLASS = 'vibe-scrolling';

/** How long the thumb stays after the last scroll event: long enough to see where the list is and how long it is */
export const VIBE_SCROLLING_HIDE_DELAY_MS = 1000;

/** The scroll containers `vibeScroll.css` styles: the marked ones and everything inside them */
const VIBE_SCROLL_ROOTS = '.vibe-scroll, .vibe-scope';

interface IScrollingState {
	lastScrollAt: number;
}

/**
 * CSS cannot tell that a container is being scrolled, only that the pointer is over it
 * The chat scrolls itself while an answer streams and the pointer is elsewhere, the keyboard scrolls without any pointer
 * So the element that scrolls is marked here for a moment, and the stylesheet keeps its thumb visible meanwhile
 *
 * One listener per window instead of one per container: `scroll` does not bubble, but it is seen in the capture phase
 * The handler reads no layout: a selector match, a class write and a timestamp
 */
export class VibeScrollIndicator extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeScrollIndicator';

	private readonly scrolling = new WeakMap<HTMLElement, IScrollingState>();

	constructor() {
		super();

		// The main window and every window opened later, modal portals live in the document of their window
		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			disposables.add(addDisposableListener(window.document, 'scroll', e => this.onScroll(e.target), { capture: true, passive: true }));
		}, { window: mainWindow, disposables: this._store }));
	}

	private onScroll(target: EventTarget | null): void {
		if (!isHTMLElement(target) || !target.closest(VIBE_SCROLL_ROOTS)) {
			return;
		}

		const now = Date.now();
		const state = this.scrolling.get(target);
		if (state) {
			state.lastScrollAt = now;
			return;
		}

		this.scrolling.set(target, { lastScrollAt: now });
		target.classList.add(VIBE_SCROLLING_CLASS);
		this.scheduleCheck(target, VIBE_SCROLLING_HIDE_DELAY_MS);
	}

	/**
	 * One timer per element at a time: when it fires and the element was scrolled meanwhile, it waits for the rest
	 * Resetting a timer on every scroll event would cost far more than the events themselves
	 */
	private scheduleCheck(target: HTMLElement, delay: number): void {
		setTimeout(() => {
			const state = this.scrolling.get(target);
			if (!state) {
				return;
			}

			const remaining = state.lastScrollAt + VIBE_SCROLLING_HIDE_DELAY_MS - Date.now();
			if (remaining > 0) {
				this.scheduleCheck(target, remaining);
				return;
			}

			this.scrolling.delete(target);
			target.classList.remove(VIBE_SCROLLING_CLASS);
		}, delay);
	}
}

registerWorkbenchContribution2(VibeScrollIndicator.ID, VibeScrollIndicator, WorkbenchPhase.AfterRestored);
