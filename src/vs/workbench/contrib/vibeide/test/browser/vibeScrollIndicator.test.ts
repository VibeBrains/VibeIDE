/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VIBE_SCROLLING_CLASS, VIBE_SCROLLING_HIDE_DELAY_MS, VibeScrollIndicator } from '../../browser/vibeScrollIndicator.contribution.js';

suite('VibeScrollIndicator', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let clock: sinon.SinonFakeTimers;
	let fixture: HTMLElement;

	setup(() => {
		clock = sinon.useFakeTimers();
		fixture = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(fixture);
		store.add(new VibeScrollIndicator());
	});

	teardown(() => {
		fixture.remove();
		clock.restore();
	});

	function createScroller(parentClass: string): HTMLElement {
		const parent = mainWindow.document.createElement('div');
		parent.className = parentClass;
		const scroller = mainWindow.document.createElement('div');
		parent.appendChild(scroller);
		fixture.appendChild(parent);
		return scroller;
	}

	function scroll(element: HTMLElement): void {
		element.dispatchEvent(new Event('scroll'));
	}

	test('marks the element that scrolls and takes the mark off after the delay', () => {
		const scroller = createScroller('vibe-scroll');

		scroll(scroller);
		const marked = scroller.classList.contains(VIBE_SCROLLING_CLASS);
		clock.tick(VIBE_SCROLLING_HIDE_DELAY_MS - 1);
		const stillMarked = scroller.classList.contains(VIBE_SCROLLING_CLASS);
		clock.tick(1);

		assert.deepStrictEqual({ marked, stillMarked, markedAfter: scroller.classList.contains(VIBE_SCROLLING_CLASS) }, { marked: true, stillMarked: true, markedAfter: false });
	});

	test('every scroll event moves the end of the delay', () => {
		const scroller = createScroller('vibe-scope');

		scroll(scroller);
		clock.tick(VIBE_SCROLLING_HIDE_DELAY_MS - 100);
		scroll(scroller);
		clock.tick(VIBE_SCROLLING_HIDE_DELAY_MS - 100);
		const markedBeforeEnd = scroller.classList.contains(VIBE_SCROLLING_CLASS);
		clock.tick(100);

		assert.deepStrictEqual({ markedBeforeEnd, markedAfter: scroller.classList.contains(VIBE_SCROLLING_CLASS) }, { markedBeforeEnd: true, markedAfter: false });
	});

	test('a container that scrolls again after the mark went away is marked again', () => {
		const scroller = createScroller('vibe-scroll');

		scroll(scroller);
		clock.tick(VIBE_SCROLLING_HIDE_DELAY_MS);
		scroll(scroller);

		assert.strictEqual(scroller.classList.contains(VIBE_SCROLLING_CLASS), true);
	});

	test('containers that are not ours are left alone', () => {
		const scroller = createScroller('some-other-container');

		scroll(scroller);

		assert.strictEqual(scroller.classList.contains(VIBE_SCROLLING_CLASS), false);
	});

	test('two containers are timed apart', () => {
		const first = createScroller('vibe-scroll');
		const second = createScroller('vibe-scroll');

		scroll(first);
		clock.tick(VIBE_SCROLLING_HIDE_DELAY_MS / 2);
		scroll(second);
		clock.tick(VIBE_SCROLLING_HIDE_DELAY_MS / 2);

		assert.deepStrictEqual({ first: first.classList.contains(VIBE_SCROLLING_CLASS), second: second.classList.contains(VIBE_SCROLLING_CLASS) }, { first: false, second: true });
	});
});
