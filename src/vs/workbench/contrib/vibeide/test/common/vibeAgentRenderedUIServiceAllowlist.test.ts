/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	A2UI_ALLOWED_COMMANDS,
	isA2UICommandAllowed,
} from '../../common/vibeAgentRenderedUIService.js';

suite('VibeAgentRenderedUIService — A2UI allowlist', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every entry in A2UI_ALLOWED_COMMANDS is a vibeide.* string', () => {
		for (const id of A2UI_ALLOWED_COMMANDS) {
			assert.strictEqual(typeof id, 'string');
			assert.ok(id.startsWith('vibeide.'), `${id} must start with vibeide.`);
		}
	});

	test('A2UI_ALLOWED_COMMANDS has no duplicates', () => {
		assert.strictEqual(new Set(A2UI_ALLOWED_COMMANDS).size, A2UI_ALLOWED_COMMANDS.length);
	});

	test('A2UI_ALLOWED_COMMANDS is frozen', () => {
		assert.ok(Object.isFrozen(A2UI_ALLOWED_COMMANDS));
	});

	test('isA2UICommandAllowed accepts every listed command', () => {
		for (const id of A2UI_ALLOWED_COMMANDS) {
			assert.strictEqual(isA2UICommandAllowed(id), true, `should allow '${id}'`);
		}
	});

	test('isA2UICommandAllowed rejects Project Commands shell exec', () => {
		assert.strictEqual(isA2UICommandAllowed('vibeide.commands.run.deploy-prod'), false);
		assert.strictEqual(isA2UICommandAllowed('vibeide.commands.run.evil'), false);
	});

	test('isA2UICommandAllowed rejects destructive commands', () => {
		assert.strictEqual(isA2UICommandAllowed('vibeide.emergencyStopAllAgents'), false);
		assert.strictEqual(isA2UICommandAllowed('vibeide.skills.importCommunityUrl'), false);
		assert.strictEqual(isA2UICommandAllowed('vibeide.skills.saveAsFromChat'), false);
	});

	test('isA2UICommandAllowed rejects upstream / vscode commands', () => {
		assert.strictEqual(isA2UICommandAllowed('workbench.action.openSettings'), false);
		assert.strictEqual(isA2UICommandAllowed('vscode.executeFormatDocumentProvider'), false);
	});

	test('isA2UICommandAllowed rejects non-string and empty', () => {
		assert.strictEqual(isA2UICommandAllowed(undefined), false);
		assert.strictEqual(isA2UICommandAllowed(null), false);
		assert.strictEqual(isA2UICommandAllowed(''), false);
		assert.strictEqual(isA2UICommandAllowed(42), false);
		assert.strictEqual(isA2UICommandAllowed({}), false);
	});

	test('isA2UICommandAllowed rejects malformed prefixes that the old filter would have passed', () => {
		// The old filter accepted anything starting with 'vibeide.' — these are the
		// concrete cases that motivated the migration to a positive allowlist.
		assert.strictEqual(isA2UICommandAllowed('vibeide.something.completely.new'), false);
		assert.strictEqual(isA2UICommandAllowed('vibeide.'), false);
		assert.strictEqual(isA2UICommandAllowed('vibeide.commands'), false);
	});
});
