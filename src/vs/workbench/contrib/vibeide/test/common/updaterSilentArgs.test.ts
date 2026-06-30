/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodeUpdaterArgs,
	buildSilentInstallerSpec,
	transitionUpdater,
	UpdaterArgs,
	UpdaterState,
} from '../../common/updaterSilentArgs.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const baseArgs: UpdaterArgs = {
	waitPid: 1234,
	installerPath: 'C:/install.exe',
	silent: false,
	autoLaunch: true,
	os: 'win32',
};

suite('Updater silent-installer args + lifecycle FSM', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeUpdaterArgs', () => {
		test('happy path — pid + installer', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1234', '--installer', 'C:/x.exe'], 'win32');
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.waitPid, 1234);
				assert.strictEqual(r.value.installerPath, 'C:/x.exe');
				assert.strictEqual(r.value.silent, false);
				assert.strictEqual(r.value.autoLaunch, true);
			}
		});

		test('--silent flag', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1', '--installer', 'x', '--silent'], 'win32');
			if (r.ok) { assert.strictEqual(r.value.silent, true); }
		});

		test('--no-auto-launch overrides default', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1', '--installer', 'x', '--no-auto-launch'], 'win32');
			if (r.ok) { assert.strictEqual(r.value.autoLaunch, false); }
		});

		test('--log path', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1', '--installer', 'x', '--log', '/tmp/u.log'], 'linux');
			if (r.ok) { assert.strictEqual(r.value.logPath, '/tmp/u.log'); }
		});

		test('--timeout-seconds in range', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1', '--installer', 'x', '--timeout-seconds', '300'], 'win32');
			if (r.ok) { assert.strictEqual(r.value.timeoutSeconds, 300); }
		});

		test('rejects timeout out of range', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1', '--installer', 'x', '--timeout-seconds', '7200'], 'win32');
			assert.strictEqual(r.ok, false);
		});

		test('rejects negative pid', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '-5', '--installer', 'x'], 'win32');
			assert.strictEqual(r.ok, false);
		});

		test('rejects non-int pid', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '12.5', '--installer', 'x'], 'win32');
			assert.strictEqual(r.ok, false);
		});

		test('rejects missing pid value', () => {
			const r = decodeUpdaterArgs(['--wait-pid'], 'win32');
			assert.strictEqual(r.ok, false);
		});

		test('rejects required-flag absent', () => {
			const r = decodeUpdaterArgs(['--silent'], 'win32');
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('required')); }
		});

		test('rejects unknown flag', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1', '--installer', 'x', '--evil'], 'win32');
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('unknown-flag')); }
		});

		test('rejects too-long log path', () => {
			const r = decodeUpdaterArgs(
				['--wait-pid', '1', '--installer', 'x', '--log', 'a'.repeat(5000)],
				'linux',
			);
			assert.strictEqual(r.ok, false);
		});

		test('os passed through', () => {
			const r = decodeUpdaterArgs(['--wait-pid', '1', '--installer', 'x'], 'darwin');
			if (r.ok) { assert.strictEqual(r.value.os, 'darwin'); }
		});
	});

	suite('buildSilentInstallerSpec', () => {
		test('Windows silent → /S flag', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, silent: true });
			assert.deepStrictEqual(r.args, ['/S']);
			assert.strictEqual(r.suggestsCodeSigningGate, true);
		});

		test('Windows non-silent → no flags', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, silent: false });
			assert.deepStrictEqual(r.args, []);
		});

		test('macOS .pkg uses installer command', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, os: 'darwin', installerPath: '/x.pkg' });
			assert.strictEqual(r.command, 'installer');
			assert.deepStrictEqual(r.args, ['-pkg', '/x.pkg', '-target', '/']);
			assert.strictEqual(r.suggestsCodeSigningGate, true);
		});

		test('macOS .dmg uses open -W -a', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, os: 'darwin', installerPath: '/x.dmg' });
			assert.strictEqual(r.command, 'open');
		});

		test('Linux .deb uses dpkg', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, os: 'linux', installerPath: '/x.deb' });
			assert.strictEqual(r.command, 'dpkg');
		});

		test('Linux .rpm uses rpm', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, os: 'linux', installerPath: '/x.rpm' });
			assert.strictEqual(r.command, 'rpm');
		});

		test('Linux .AppImage spawns directly', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, os: 'linux', installerPath: '/x.AppImage' });
			assert.strictEqual(r.command, '/x.AppImage');
			assert.strictEqual(r.suggestsCodeSigningGate, false);
		});

		test('Linux non-package suggests no code-signing gate', () => {
			const r = buildSilentInstallerSpec({ ...baseArgs, os: 'linux', installerPath: '/x.AppImage' });
			assert.strictEqual(r.suggestsCodeSigningGate, false);
		});

		test('Windows always suggests code-signing gate', () => {
			const r = buildSilentInstallerSpec(baseArgs);
			assert.strictEqual(r.suggestsCodeSigningGate, true);
		});
	});

	suite('transitionUpdater', () => {
		const idle: UpdaterState = { kind: 'idle' };

		test('idle + start → waiting-pid', () => {
			const r = transitionUpdater(idle, { kind: 'start', nowMs: 1 }, baseArgs);
			if (r.ok && r.next.kind === 'waiting-pid') {
				assert.strictEqual(r.next.pid, 1234);
			}
		});

		test('waiting-pid + pid-released → installing', () => {
			const r = transitionUpdater(
				{ kind: 'waiting-pid', pid: 1234, waitStartedAtMs: 1 },
				{ kind: 'pid-released', nowMs: 2 },
			);
			if (r.ok) { assert.strictEqual(r.next.kind, 'installing'); }
		});

		test('installing + install-completed (autoLaunch=true) → launching', () => {
			const r = transitionUpdater(
				{ kind: 'installing', startedAtMs: 1 },
				{ kind: 'install-completed', nowMs: 5 },
				{ ...baseArgs, autoLaunch: true },
			);
			if (r.ok) { assert.strictEqual(r.next.kind, 'launching'); }
		});

		test('installing + install-completed (autoLaunch=false) → done:success', () => {
			const r = transitionUpdater(
				{ kind: 'installing', startedAtMs: 1 },
				{ kind: 'install-completed', nowMs: 5 },
				{ ...baseArgs, autoLaunch: false },
			);
			if (r.ok && r.next.kind === 'done') { assert.strictEqual(r.next.outcome, 'success'); }
		});

		test('installing + install-failed → done:install-failed', () => {
			const r = transitionUpdater(
				{ kind: 'installing', startedAtMs: 1 },
				{ kind: 'install-failed', nowMs: 5 },
			);
			if (r.ok && r.next.kind === 'done') { assert.strictEqual(r.next.outcome, 'install-failed'); }
		});

		test('launching + launch-completed → done:success', () => {
			const r = transitionUpdater(
				{ kind: 'launching', installEndedAtMs: 1 },
				{ kind: 'launch-completed', nowMs: 5 },
			);
			if (r.ok && r.next.kind === 'done') { assert.strictEqual(r.next.outcome, 'success'); }
		});

		test('launching + launch-failed → done:launch-failed', () => {
			const r = transitionUpdater(
				{ kind: 'launching', installEndedAtMs: 1 },
				{ kind: 'launch-failed', nowMs: 5 },
			);
			if (r.ok && r.next.kind === 'done') { assert.strictEqual(r.next.outcome, 'launch-failed'); }
		});

		test('timeout from running → done:timeout', () => {
			const r = transitionUpdater(
				{ kind: 'installing', startedAtMs: 1 },
				{ kind: 'timeout', nowMs: 5 },
			);
			if (r.ok && r.next.kind === 'done') { assert.strictEqual(r.next.outcome, 'timeout'); }
		});

		test('timeout from idle → refused', () => {
			const r = transitionUpdater(idle, { kind: 'timeout', nowMs: 5 });
			assert.strictEqual(r.ok, false);
		});

		test('abort from any non-terminal → done:aborted', () => {
			const r = transitionUpdater(
				{ kind: 'launching', installEndedAtMs: 1 },
				{ kind: 'abort', nowMs: 5 },
			);
			if (r.ok && r.next.kind === 'done') { assert.strictEqual(r.next.outcome, 'aborted'); }
		});

		test('done is terminal', () => {
			const r = transitionUpdater(
				{ kind: 'done', endedAtMs: 1, outcome: 'success' },
				{ kind: 'start', nowMs: 2 },
			);
			assert.strictEqual(r.ok, false);
		});

		test('idle + non-start → refused', () => {
			const r = transitionUpdater(idle, { kind: 'pid-released', nowMs: 1 });
			assert.strictEqual(r.ok, false);
		});
	});
});
