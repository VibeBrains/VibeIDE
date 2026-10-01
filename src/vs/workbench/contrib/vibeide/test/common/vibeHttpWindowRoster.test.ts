/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VibeHttpWindowRoster } from '../../common/httpApi/vibeHttpWindowRoster.js';

function entry(windowId: number, instanceId: string, port = 7391, token = 't') {
	return { windowId, instanceId, port, token };
}

suite('vibeHttpWindowRoster', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the window registered first serves; later windows stand by', () => {
		const roster = new VibeHttpWindowRoster();
		const before = roster.owner;
		roster.register(entry(1, 'a'));
		roster.register(entry(2, 'b'));
		assert.deepStrictEqual([before, roster.owner?.instanceId], [undefined, 'a']);
	});

	test('re-registering keeps the place and takes the new port and token', () => {
		const roster = new VibeHttpWindowRoster();
		roster.register(entry(1, 'a'));
		roster.register(entry(2, 'b'));
		roster.register(entry(1, 'a', 8000, 'rotated'));
		assert.deepStrictEqual(roster.owner, entry(1, 'a', 8000, 'rotated'));
	});

	test('a reload of the owner hands over to the next window, and the reloaded one queues last', () => {
		const roster = new VibeHttpWindowRoster();
		roster.register(entry(1, 'a'));
		roster.register(entry(2, 'b'));
		roster.register(entry(1, 'a2'));
		const afterReload = roster.owner?.instanceId;
		roster.unregister('b');
		assert.deepStrictEqual([afterReload, roster.owner?.instanceId], ['b', 'a2']);
	});

	test('a closed window leaves; when nobody is left there is no owner', () => {
		const roster = new VibeHttpWindowRoster();
		roster.register(entry(1, 'a'));
		roster.register(entry(2, 'b'));
		const retired = roster.retireWindow(1);
		const afterClose = roster.owner?.instanceId;
		const unknown = roster.unregister('nope');
		roster.unregister('b');
		assert.deepStrictEqual([retired, afterClose, unknown, roster.owner], [['a'], 'b', false, undefined]);
	});
});
