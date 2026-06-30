/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeProjectCommandsToolbarPosition,
	isToolbarVisible,
	PROJECT_COMMANDS_TOOLBAR_POSITIONS,
	PROJECT_COMMANDS_TOOLBAR_DEFAULT,
	visibleContextMenuActions,
	decodeContextMenuAction,
	PROJECT_COMMANDS_CONTEXT_MENU_ORDER,
} from '../../common/projectCommandsToolbar.js';

suite('Project Commands — toolbar position decoder + context-menu actions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeProjectCommandsToolbarPosition', () => {
		test('canonical values pass through', () => {
			for (const pos of PROJECT_COMMANDS_TOOLBAR_POSITIONS) {
				assert.strictEqual(decodeProjectCommandsToolbarPosition(pos), pos);
			}
		});

		test('case-insensitive + trim', () => {
			assert.strictEqual(decodeProjectCommandsToolbarPosition('  TITLEBAR  '), 'titlebar');
			assert.strictEqual(decodeProjectCommandsToolbarPosition('StatusBar'), 'statusbar');
		});

		test('unknown / malformed → default titlebar', () => {
			assert.strictEqual(decodeProjectCommandsToolbarPosition('toolbar'), PROJECT_COMMANDS_TOOLBAR_DEFAULT);
			assert.strictEqual(decodeProjectCommandsToolbarPosition(''), PROJECT_COMMANDS_TOOLBAR_DEFAULT);
			assert.strictEqual(decodeProjectCommandsToolbarPosition(null), PROJECT_COMMANDS_TOOLBAR_DEFAULT);
			assert.strictEqual(decodeProjectCommandsToolbarPosition(42), PROJECT_COMMANDS_TOOLBAR_DEFAULT);
			assert.strictEqual(decodeProjectCommandsToolbarPosition({ position: 'titlebar' }), PROJECT_COMMANDS_TOOLBAR_DEFAULT);
		});

		test('default is titlebar', () => {
			assert.strictEqual(PROJECT_COMMANDS_TOOLBAR_DEFAULT, 'titlebar');
		});
	});

	suite('isToolbarVisible', () => {
		test('hidden → not visible', () => {
			assert.strictEqual(isToolbarVisible('hidden'), false);
		});
		test('titlebar / statusbar → visible', () => {
			assert.strictEqual(isToolbarVisible('titlebar'), true);
			assert.strictEqual(isToolbarVisible('statusbar'), true);
		});
	});

	suite('visibleContextMenuActions', () => {
		test('pinned + non-protected → all 5 actions', () => {
			const r = visibleContextMenuActions({ pinned: true });
			assert.deepStrictEqual(r, ['run', 'edit', 'unpin', 'delete', 'copy-command-line']);
		});

		test('not pinned → unpin hidden', () => {
			const r = visibleContextMenuActions({ pinned: false });
			assert.deepStrictEqual(r, ['run', 'edit', 'delete', 'copy-command-line']);
		});

		test('protected → delete hidden', () => {
			const r = visibleContextMenuActions({ pinned: true, protected: true });
			assert.deepStrictEqual(r, ['run', 'edit', 'unpin', 'copy-command-line']);
		});

		test('not pinned + protected → run/edit/copy only', () => {
			const r = visibleContextMenuActions({ pinned: false, protected: true });
			assert.deepStrictEqual(r, ['run', 'edit', 'copy-command-line']);
		});

		test('canonical order frozen', () => {
			assert.strictEqual(PROJECT_COMMANDS_CONTEXT_MENU_ORDER.length, 5);
			assert.throws(() => {
				(PROJECT_COMMANDS_CONTEXT_MENU_ORDER as ProjectCommandsContextMenuActionMutable)[0] = 'edit';
			});
		});
	});

	suite('decodeContextMenuAction', () => {
		test('canonical values', () => {
			for (const a of PROJECT_COMMANDS_CONTEXT_MENU_ORDER) {
				assert.strictEqual(decodeContextMenuAction(a), a);
			}
		});

		test('unknown / non-string → null', () => {
			assert.strictEqual(decodeContextMenuAction('Run'), null); // case-sensitive on action wire
			assert.strictEqual(decodeContextMenuAction('eject'), null);
			assert.strictEqual(decodeContextMenuAction(42), null);
			assert.strictEqual(decodeContextMenuAction(null), null);
		});
	});
});

// Type alias for the frozen-array mutation guard test above. Not exported.
type ProjectCommandsContextMenuActionMutable = Array<typeof PROJECT_COMMANDS_CONTEXT_MENU_ORDER[number]>;
