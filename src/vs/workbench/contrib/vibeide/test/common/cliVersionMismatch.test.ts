/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	parseSemver,
	compareSemver,
	detectVersionMismatch,
} from '../../common/cliVersionMismatch.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('CLI/IDE version mismatch (1136)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseSemver', () => {
		test('parses bare semver', () => {
			assert.deepStrictEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
		});

		test('strips leading v', () => {
			assert.deepStrictEqual(parseSemver('v0.1.0'), { major: 0, minor: 1, patch: 0, prerelease: '' });
		});

		test('captures prerelease', () => {
			assert.deepStrictEqual(parseSemver('1.0.0-rc.1'), { major: 1, minor: 0, patch: 0, prerelease: 'rc.1' });
		});

		test('rejects bare empty prerelease (1.0.0-)', () => {
			assert.strictEqual(parseSemver('1.0.0-'), null);
		});

		test('rejects malformed input', () => {
			assert.strictEqual(parseSemver('not a version'), null);
			assert.strictEqual(parseSemver(undefined), null);
			assert.strictEqual(parseSemver(null), null);
			assert.strictEqual(parseSemver(123), null);
			assert.strictEqual(parseSemver('1.2'), null);
		});
	});

	suite('compareSemver', () => {
		const v = (s: string) => parseSemver(s)!;

		test('major / minor / patch ordering', () => {
			assert.strictEqual(compareSemver(v('1.0.0'), v('2.0.0')), -1);
			assert.strictEqual(compareSemver(v('2.0.0'), v('1.9.9')), 1);
			assert.strictEqual(compareSemver(v('1.0.0'), v('1.1.0')), -1);
			assert.strictEqual(compareSemver(v('1.1.0'), v('1.0.99')), 1);
			assert.strictEqual(compareSemver(v('1.0.0'), v('1.0.0')), 0);
		});

		test('release > prerelease (SemVer 2.0)', () => {
			assert.strictEqual(compareSemver(v('1.0.0'), v('1.0.0-rc')), 1);
			assert.strictEqual(compareSemver(v('1.0.0-rc'), v('1.0.0')), -1);
		});

		test('two prereleases lexicographic', () => {
			assert.strictEqual(compareSemver(v('1.0.0-alpha'), v('1.0.0-beta')), -1);
			assert.strictEqual(compareSemver(v('1.0.0-rc.2'), v('1.0.0-rc.1')), 1);
		});
	});

	suite('detectVersionMismatch', () => {
		test('matching versions → none + same', () => {
			const r = detectVersionMismatch({ cliVersion: '0.2.0', ideVersion: '0.2.0' });
			assert.strictEqual(r.delta, 'same');
			assert.strictEqual(r.severity, 'none');
		});

		test('patch mismatch detected', () => {
			const r = detectVersionMismatch({ cliVersion: '0.2.0', ideVersion: '0.2.1' });
			assert.strictEqual(r.severity, 'patch');
			assert.strictEqual(r.delta, 'cli-older');
		});

		test('minor mismatch detected', () => {
			const r = detectVersionMismatch({ cliVersion: '0.2.0', ideVersion: '0.3.0' });
			assert.strictEqual(r.severity, 'minor');
		});

		test('major mismatch detected', () => {
			const r = detectVersionMismatch({ cliVersion: '0.5.0', ideVersion: '1.0.0' });
			assert.strictEqual(r.severity, 'major');
			assert.strictEqual(r.delta, 'cli-older');
		});

		test('cli-newer when CLI ahead', () => {
			const r = detectVersionMismatch({ cliVersion: '0.3.0', ideVersion: '0.2.0' });
			assert.strictEqual(r.delta, 'cli-newer');
		});

		test('unparseable → unparseable + headline mentions which side', () => {
			const r = detectVersionMismatch({ cliVersion: 'oops', ideVersion: '0.2.0' });
			assert.strictEqual(r.delta, 'unparseable');
			assert.match(r.suggestion, /CLI/);
		});

		test('both unparseable → suggestion mentions both', () => {
			const r = detectVersionMismatch({ cliVersion: '', ideVersion: '' });
			assert.strictEqual(r.delta, 'unparseable');
			assert.match(r.suggestion, /both/);
		});

		test('cli-older suggestion mentions npm reinstall command', () => {
			const r = detectVersionMismatch({ cliVersion: '0.2.0', ideVersion: '0.3.0' });
			assert.match(r.suggestion, /npm i -g/);
		});

		test('cli-newer suggestion mentions IDE upgrade', () => {
			const r = detectVersionMismatch({ cliVersion: '0.3.0', ideVersion: '0.2.0' });
			assert.match(r.suggestion, /Upgrade the IDE/);
		});
	});
});
