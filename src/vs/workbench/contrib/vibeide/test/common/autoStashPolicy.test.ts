/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideAutoStash,
	decodeAutoStashSetting,
	AutoStashSetting,
} from '../../common/autoStashPolicy.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const decide = (
	setting: AutoStashSetting,
	editTargets: string[],
	dirtyFiles: string[] = [],
	perFilePermissions?: { path: string; policy: 'unrestricted' | 'agent-protected' | 'read-only' }[],
) => decideAutoStash({ setting, editTargets, dirtyFiles, perFilePermissions });

suite('Auto-stash policy (1058)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideAutoStash', () => {
		test('"always" stashes regardless of dirty state', () => {
			assert.deepStrictEqual(decide('always', ['a.ts']), { kind: 'stash', reason: 'always' });
			assert.deepStrictEqual(decide('always', ['a.ts'], ['a.ts']), { kind: 'stash', reason: 'always' });
		});

		test('"never" skips even with dirty files', () => {
			assert.deepStrictEqual(decide('never', ['a.ts'], ['a.ts']), { kind: 'skip', reason: 'never' });
		});

		test('"dirty-only" stashes when target is dirty', () => {
			assert.deepStrictEqual(decide('dirty-only', ['a.ts'], ['a.ts']), { kind: 'stash', reason: 'dirty-files' });
		});

		test('"dirty-only" skips when target is clean', () => {
			assert.deepStrictEqual(decide('dirty-only', ['a.ts'], ['b.ts']), { kind: 'skip', reason: 'no-dirty-no-protected' });
		});

		test('agent-protected target forces stash even with "never"', () => {
			const r = decide('never', ['a.ts'], [], [{ path: 'a.ts', policy: 'agent-protected' }]);
			assert.deepStrictEqual(r, { kind: 'stash', reason: 'protected-target' });
		});

		test('unrestricted permission does not force stash', () => {
			const r = decide('never', ['a.ts'], [], [{ path: 'a.ts', policy: 'unrestricted' }]);
			assert.deepStrictEqual(r, { kind: 'skip', reason: 'never' });
		});

		test('agent-protected file outside edit targets does NOT force stash', () => {
			const r = decide('never', ['a.ts'], [], [{ path: 'protected.ts', policy: 'agent-protected' }]);
			assert.deepStrictEqual(r, { kind: 'skip', reason: 'never' });
		});

		test('protected-target precedence over "always"', () => {
			const r = decide('always', ['a.ts'], [], [{ path: 'a.ts', policy: 'agent-protected' }]);
			assert.deepStrictEqual(r, { kind: 'stash', reason: 'protected-target' });
		});

		test('multiple edit targets — any dirty is enough for "dirty-only"', () => {
			const r = decide('dirty-only', ['a.ts', 'b.ts', 'c.ts'], ['c.ts']);
			assert.deepStrictEqual(r, { kind: 'stash', reason: 'dirty-files' });
		});
	});

	suite('decodeAutoStashSetting', () => {
		test('accepts known strings', () => {
			assert.strictEqual(decodeAutoStashSetting('always'), 'always');
			assert.strictEqual(decodeAutoStashSetting('dirty-only'), 'dirty-only');
			assert.strictEqual(decodeAutoStashSetting('never'), 'never');
		});

		test('falls back to dirty-only for unknown / non-string', () => {
			assert.strictEqual(decodeAutoStashSetting('Always'), 'dirty-only');
			assert.strictEqual(decodeAutoStashSetting(undefined), 'dirty-only');
			assert.strictEqual(decodeAutoStashSetting(null), 'dirty-only');
			assert.strictEqual(decodeAutoStashSetting(42), 'dirty-only');
		});
	});
});
