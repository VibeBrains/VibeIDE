/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CompositeBar, ICompositeBarItem, ICompositeBarOptions } from '../../../browser/parts/compositeBar.js';
import { CompositeBarAction } from '../../../browser/parts/compositeBarActions.js';
import { ICompositeDragAndDrop } from '../../../browser/dnd.js';
import { IViewDescriptorService } from '../../../common/views.js';

suite('CompositeBar', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface ITestBar {
		readonly bar: CompositeBar;
		readonly opened: { id: string; preserveFocus: boolean | undefined }[];
		isActive(id: string): boolean;
	}

	/**
	 * The bar is not rendered, so only the model is exercised: pinned state, the active tab and the follow-up opening
	 */
	function createBar(items: { id: string; pinned: boolean }[], defaultCompositeId: string, activeId?: string): ITestBar {
		const actions = new Map(items.map(item => [item.id, disposables.add(new CompositeBarAction({ id: item.id, name: item.id }))]));
		const opened: { id: string; preserveFocus: boolean | undefined }[] = [];

		const options: ICompositeBarOptions = {
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			colors: () => ({}),
			compositeSize: 0,
			overflowActionSize: 0,
			dndHandler: {} as ICompositeDragAndDrop,
			activityHoverOptions: { position: () => { throw new Error('not expected'); } },
			getActivityAction: id => actions.get(id)!,
			getCompositePinnedAction: () => { throw new Error('not expected'); },
			getCompositeBadgeAction: () => { throw new Error('not expected'); },
			getOnCompositeClickAction: () => { throw new Error('not expected'); },
			fillExtraContextMenuActions: () => { },
			getContextMenuActionsForComposite: () => [],
			openComposite: async (id, preserveFocus) => { opened.push({ id, preserveFocus }); return null; },
			getDefaultCompositeId: () => defaultCompositeId,
		};

		const barItems: ICompositeBarItem[] = items.map(item => ({ id: item.id, name: item.id, pinned: item.pinned, visible: true }));
		const bar = disposables.add(new CompositeBar(barItems, options, {} as IInstantiationService, {} as IContextMenuService, {} as IViewDescriptorService));
		if (activeId) {
			bar.activateComposite(activeId);
		}

		return { bar, opened, isActive: id => actions.get(id)!.checked === true };
	}

	test('close unpins an inactive tab and leaves the rest alone', () => {
		const { bar, opened, isActive } = createBar([{ id: 'chat', pinned: true }, { id: 'ext', pinned: true }], 'chat', 'chat');

		assert.deepStrictEqual({
			closed: bar.close('ext'),
			pinned: bar.getPinnedCompositeIds(),
			active: isActive('chat'),
			opened,
		}, { closed: true, pinned: ['chat'], active: true, opened: [] });
	});

	test('close of the active tab deactivates it and opens the default tab', () => {
		const { bar, opened, isActive } = createBar([{ id: 'chat', pinned: true }, { id: 'ext', pinned: true }], 'chat', 'ext');

		assert.deepStrictEqual({
			closed: bar.close('ext'),
			pinned: bar.getPinnedCompositeIds(),
			active: isActive('ext'),
			opened,
		}, { closed: true, pinned: ['chat'], active: false, opened: [{ id: 'chat', preserveFocus: true }] });
	});

	test('close of a tab that is shown only because it is active opens the default tab', () => {
		const { bar, opened, isActive } = createBar([{ id: 'chat', pinned: true }, { id: 'ext', pinned: false }], 'chat', 'ext');

		assert.deepStrictEqual({
			closed: bar.close('ext'),
			pinned: bar.getPinnedCompositeIds(),
			active: isActive('ext'),
			opened,
		}, { closed: true, pinned: ['chat'], active: false, opened: [{ id: 'chat', preserveFocus: true }] });
	});

	test('close refuses the only tab and keeps it pinned, the caller hides the part', () => {
		const { bar, opened, isActive } = createBar([{ id: 'chat', pinned: true }, { id: 'ext', pinned: false }], 'chat', 'chat');

		assert.deepStrictEqual({
			closed: bar.close('chat'),
			pinned: bar.getPinnedCompositeIds(),
			active: isActive('chat'),
			opened,
		}, { closed: false, pinned: ['chat'], active: true, opened: [] });
	});

	test('close refuses an unpinned active tab when nothing else is shown', () => {
		const { bar, opened } = createBar([{ id: 'chat', pinned: false }], 'chat', 'chat');

		assert.deepStrictEqual({ closed: bar.close('chat'), pinned: bar.getPinnedCompositeIds(), opened }, { closed: false, pinned: [], opened: [] });
	});

	test('the active tab keeps the bar from being empty when the only pinned tab is closed', () => {
		const { bar, isActive } = createBar([{ id: 'chat', pinned: false }, { id: 'ext', pinned: true }], 'chat', 'chat');

		assert.deepStrictEqual({
			closed: bar.close('ext'),
			pinned: bar.getPinnedCompositeIds(),
			active: isActive('chat'),
		}, { closed: true, pinned: [], active: true });
	});

	test('pinFirst puts a pinned tab in front of the others', () => {
		const { bar } = createBar([{ id: 'a', pinned: true }, { id: 'b', pinned: true }, { id: 'c', pinned: true }], 'a');

		bar.pinFirst('c');

		assert.deepStrictEqual({ order: bar.getCompositeBarItems().map(item => item.id), pinned: bar.getPinnedCompositeIds() }, { order: ['c', 'a', 'b'], pinned: ['c', 'a', 'b'] });
	});

	test('pinFirst pins a tab that was taken off and puts it in front', () => {
		const { bar } = createBar([{ id: 'a', pinned: true }, { id: 'b', pinned: true }, { id: 'c', pinned: false }], 'a');

		bar.pinFirst('c');

		assert.deepStrictEqual({ order: bar.getCompositeBarItems().map(item => item.id), pinned: bar.getPinnedCompositeIds() }, { order: ['c', 'a', 'b'], pinned: ['c', 'a', 'b'] });
	});

	test('pinFirst only pins a tab that is the first one already', () => {
		const { bar } = createBar([{ id: 'a', pinned: false }, { id: 'b', pinned: true }], 'a');

		bar.pinFirst('a');

		assert.deepStrictEqual({ order: bar.getCompositeBarItems().map(item => item.id), pinned: bar.getPinnedCompositeIds() }, { order: ['a', 'b'], pinned: ['a', 'b'] });
	});

	test('pinFirst leaves a tab the bar does not know alone', () => {
		const { bar } = createBar([{ id: 'a', pinned: true }, { id: 'b', pinned: false }], 'a');

		bar.pinFirst('x');

		assert.deepStrictEqual({ order: bar.getCompositeBarItems().map(item => item.id), pinned: bar.getPinnedCompositeIds() }, { order: ['a', 'b'], pinned: ['a'] });
	});
});
