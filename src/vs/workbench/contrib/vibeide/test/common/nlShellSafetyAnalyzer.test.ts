/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	analyzeNLShellSafety,
	describeShellSafetyResult,
} from '../../common/nlShellSafetyAnalyzer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('NL shell safety analyzer (1056)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('analyzeNLShellSafety', () => {
		test('benign ls → safe', () => {
			const r = analyzeNLShellSafety('ls', ['-la']);
			assert.strictEqual(r.safety, 'safe');
		});

		test('rm -rf / → destructive', () => {
			const r = analyzeNLShellSafety('rm', ['-rf', '/']);
			assert.strictEqual(r.safety, 'destructive');
			assert.ok(r.reasons.includes('rm-binary'));
			assert.ok(r.reasons.includes('rf-flag'));
			assert.ok(r.reasons.includes('root-path'));
		});

		test('rm -fr ~ → destructive', () => {
			const r = analyzeNLShellSafety('rm', ['-fr', '~']);
			assert.strictEqual(r.safety, 'destructive');
			assert.ok(r.reasons.includes('fr-flag'));
			assert.ok(r.reasons.includes('home-path'));
		});

		test('dd binary → destructive', () => {
			const r = analyzeNLShellSafety('dd', ['if=/dev/zero', 'of=/dev/sda']);
			assert.strictEqual(r.safety, 'destructive');
		});

		test('mkfs.ext4 → destructive', () => {
			const r = analyzeNLShellSafety('mkfs.ext4', ['/dev/sdb1']);
			assert.strictEqual(r.safety, 'destructive');
		});

		test('chmod 777 → destructive', () => {
			const r = analyzeNLShellSafety('chmod', ['-R', '777', '/var/www']);
			assert.strictEqual(r.safety, 'destructive');
			assert.ok(r.reasons.includes('chmod-777'));
		});

		test('git push --force → destructive', () => {
			const r = analyzeNLShellSafety('git', ['push', '--force']);
			assert.strictEqual(r.safety, 'destructive');
			assert.ok(r.reasons.includes('git-push-force'));
		});

		test('git reset --hard → destructive', () => {
			const r = analyzeNLShellSafety('git', ['reset', '--hard', 'HEAD~5']);
			assert.strictEqual(r.safety, 'destructive');
			assert.ok(r.reasons.includes('git-reset-hard'));
		});

		test('git clean -fd → destructive', () => {
			const r = analyzeNLShellSafety('git', ['clean', '-fd']);
			assert.strictEqual(r.safety, 'destructive');
			assert.ok(r.reasons.includes('git-clean-force'));
		});

		test('git status → safe (not ambiguous when args present)', () => {
			const r = analyzeNLShellSafety('git', ['status']);
			assert.strictEqual(r.safety, 'safe');
		});

		test('bare git → ambiguous', () => {
			const r = analyzeNLShellSafety('git', []);
			assert.strictEqual(r.safety, 'ambiguous');
			assert.ok(r.reasons.includes('git-command-needs-context'));
		});

		test('bare npm → ambiguous', () => {
			const r = analyzeNLShellSafety('npm', []);
			assert.strictEqual(r.safety, 'ambiguous');
		});

		test('npm install → safe', () => {
			const r = analyzeNLShellSafety('npm', ['install']);
			assert.strictEqual(r.safety, 'safe');
		});

		test('Remove-Item → destructive (PowerShell)', () => {
			const r = analyzeNLShellSafety('Remove-Item', ['-Recurse', '-Force', 'C:\\Temp']);
			assert.strictEqual(r.safety, 'destructive');
			assert.ok(r.reasons.includes('powershell-remove-item'));
			assert.ok(r.reasons.includes('force-flag'));
		});

		test('Format-Volume → destructive (PowerShell)', () => {
			const r = analyzeNLShellSafety('Format-Volume', ['-DriveLetter', 'D']);
			assert.strictEqual(r.safety, 'destructive');
		});

		test('empty args list filtered (whitespace stripped)', () => {
			const r = analyzeNLShellSafety('ls', ['', '   ']);
			assert.strictEqual(r.safety, 'safe');
			assert.deepStrictEqual(r.args, []);
		});

		test('non-string args filtered', () => {
			const r = analyzeNLShellSafety('ls', [undefined as unknown as string]);
			assert.strictEqual(r.safety, 'safe');
			assert.deepStrictEqual(r.args, []);
		});
	});

	suite('describeShellSafetyResult', () => {
		test('safe → "Will run" line', () => {
			const r = describeShellSafetyResult(analyzeNLShellSafety('ls', ['-la']));
			assert.match(r, /Will run/);
		});

		test('ambiguous → "Ambiguous" line', () => {
			const r = describeShellSafetyResult(analyzeNLShellSafety('git', []));
			assert.match(r, /Ambiguous/);
		});

		test('destructive → "DESTRUCTIVE" + reasons', () => {
			const r = describeShellSafetyResult(analyzeNLShellSafety('rm', ['-rf', '/']));
			assert.match(r, /DESTRUCTIVE/);
			assert.match(r, /rm-binary/);
		});
	});
});
