/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { threadMatchesWorkspace, threadOwnedBy, HISTORY_SHOW_ALL_PROJECTS_KEY, HISTORY_DEFAULT_SHOW_ALL_KEY } from '../../common/chatHistoryScope.js';

suite('chatHistoryScope — project-scoped history visibility (CH.1/CH.10)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const WS = 'workspace-aaa';

	test('own thread is visible in scoped mode', () => {
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: WS }, WS, false), true);
	});

	test('own thread is visible in all-projects mode too', () => {
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: WS }, WS, true), true);
	});

	test('foreign thread is hidden in scoped mode', () => {
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: 'workspace-bbb' }, WS, false), false);
	});

	test('foreign thread is revealed in all-projects mode', () => {
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: 'workspace-bbb' }, WS, true), true);
	});

	test('legacy thread (no workspaceId) is visible everywhere in scoped mode', () => {
		assert.strictEqual(threadMatchesWorkspace({}, WS, false), true);
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: undefined }, WS, false), true);
	});

	test('empty-string workspaceId is treated as legacy (visible)', () => {
		// Falsy id must not accidentally hide the thread in every project.
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: '' }, WS, false), true);
	});

	test('folder-less window (empty current id): own untagged thread visible, foreign hidden (CH.11)', () => {
		// In a folder-less window the current id is '' — threads created there are
		// untagged (visible everywhere); threads owned by a real project stay hidden.
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: '' }, '', false), true);
		assert.strictEqual(threadMatchesWorkspace({}, '', false), true);
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: 'workspace-bbb' }, '', false), false);
		assert.strictEqual(threadMatchesWorkspace({ workspaceId: 'workspace-bbb' }, '', true), true);
	});

	test('threadOwnedBy: strict ownership for export/clear (CH.13)', () => {
		assert.strictEqual(threadOwnedBy({ workspaceId: WS }, WS), true);
		assert.strictEqual(threadOwnedBy({ workspaceId: 'workspace-bbb' }, WS), false);
		// Legacy/untagged is NOT owned — export/clear must not touch shared history.
		assert.strictEqual(threadOwnedBy({}, WS), false);
		assert.strictEqual(threadOwnedBy({ workspaceId: '' }, WS), false);
		// Folder-less window (empty current id) owns nothing → bulk ops are no-ops.
		assert.strictEqual(threadOwnedBy({ workspaceId: '' }, ''), false);
		assert.strictEqual(threadOwnedBy({ workspaceId: WS }, ''), false);
	});

	test('storage keys are stable and distinct', () => {
		assert.strictEqual(HISTORY_SHOW_ALL_PROJECTS_KEY, 'vibeide.history.showAllProjects');
		assert.strictEqual(HISTORY_DEFAULT_SHOW_ALL_KEY, 'vibeide.history.defaultShowAllProjects');
		assert.notStrictEqual(HISTORY_SHOW_ALL_PROJECTS_KEY, HISTORY_DEFAULT_SHOW_ALL_KEY);
	});
});
