/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { stripPrivacyText } from '../../common/vibePrivacyStripperService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('VibePrivacyStripperService — stripPrivacyText', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty input returns empty', () => {
		assert.strictEqual(stripPrivacyText('', { workspacePath: '/x', homePath: '/y', username: 'u' }), '');
	});

	test('no patterns matched leaves text unchanged', () => {
		const out = stripPrivacyText('plain text without paths',
			{ workspacePath: 'D:\\Projects\\Foo', homePath: 'C:\\Users\\alice', username: 'alice' });
		assert.strictEqual(out, 'plain text without paths');
	});

	test('strips workspace path (Windows backslash)', () => {
		const out = stripPrivacyText('error in D:\\Projects\\Foo\\src\\bar.ts on line 5',
			{ workspacePath: 'D:\\Projects\\Foo', homePath: '', username: '' });
		assert.ok(out.includes('<workspace>'), 'expected <workspace> placeholder');
		assert.ok(!out.includes('Foo'), 'workspace folder name should be redacted');
	});

	test('strips workspace path (forward slash)', () => {
		const out = stripPrivacyText('error in /Users/alice/dev/myproj/src/bar.ts',
			{ workspacePath: '/Users/alice/dev/myproj', homePath: '', username: '' });
		assert.ok(out.includes('<workspace>'));
	});

	test('strips home path independently from workspace', () => {
		const out = stripPrivacyText('logfile at C:\\Users\\alice\\AppData\\foo.log',
			{ workspacePath: '', homePath: 'C:\\Users\\alice', username: '' });
		assert.ok(out.includes('<home>'));
	});

	test('strips username in /Users/<name>/ context', () => {
		const out = stripPrivacyText('opened /Users/alice/Documents/foo.txt',
			{ workspacePath: '', homePath: '', username: 'alice' });
		assert.ok(out.includes('Users/<user>'));
		assert.ok(!out.includes('alice'));
	});

	test('does NOT redact username outside path context', () => {
		// "alice" appearing as a code identifier should not be touched
		const out = stripPrivacyText('const alice = 1;',
			{ workspacePath: '', homePath: '', username: 'alice' });
		assert.strictEqual(out, 'const alice = 1;');
	});

	test('skips empty / too-short pattern values', () => {
		const out = stripPrivacyText('text with /a/b path',
			{ workspacePath: '', homePath: '', username: 'a' /* len 1, ignored */ });
		assert.strictEqual(out, 'text with /a/b path');
	});

	test('combined: workspace + home + username all redacted', () => {
		const text = 'wp=C:\\Projects\\demo, home=C:\\Users\\bob, user=/Users/bob/x';
		const out = stripPrivacyText(text, {
			workspacePath: 'C:\\Projects\\demo',
			homePath: 'C:\\Users\\bob',
			username: 'bob',
		});
		assert.ok(out.includes('<workspace>'));
		assert.ok(out.includes('<home>'));
		assert.ok(out.includes('Users/<user>'));
	});
});
