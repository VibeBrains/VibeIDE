/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideProjectCommandLaunch,
	decodeReusePolicy,
	buildExternalLaunchSpec,
	detectLaunchOS,
	PROJECT_COMMAND_REUSE_POLICIES,
	PROJECT_COMMAND_REUSE_DEFAULT,
	PROJECT_COMMANDS_OUTPUT_CHANNEL,
} from '../../common/projectCommandsTerminalPolicy.js';
import { ProjectCommand } from '../../common/projectCommandsTypes.js';

function cmd(overrides: Partial<ProjectCommand> = {}): ProjectCommand {
	return { id: 'b', name: 'Build', command: 'npm', ...overrides };
}

suite('Project Commands — terminal-mode launch policy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeReusePolicy', () => {
		test('canonical values pass through', () => {
			for (const p of PROJECT_COMMAND_REUSE_POLICIES) {
				assert.strictEqual(decodeReusePolicy(p), p);
			}
		});
		test('unknown / non-string → reuse (default)', () => {
			assert.strictEqual(decodeReusePolicy('always'), 'reuse');
			assert.strictEqual(decodeReusePolicy(undefined), 'reuse');
			assert.strictEqual(decodeReusePolicy(null), 'reuse');
			assert.strictEqual(decodeReusePolicy(0), 'reuse');
		});
		test('default constant matches', () => {
			assert.strictEqual(PROJECT_COMMAND_REUSE_DEFAULT, 'reuse');
		});
		test('case-sensitive — `Reuse` is unknown', () => {
			assert.strictEqual(decodeReusePolicy('Reuse'), 'reuse');
		});
	});

	suite('detectLaunchOS', () => {
		test('canonical platforms', () => {
			assert.strictEqual(detectLaunchOS('win32'), 'win32');
			assert.strictEqual(detectLaunchOS('darwin'), 'darwin');
			assert.strictEqual(detectLaunchOS('linux'), 'linux');
		});
		test('BSD-family → linux bucket', () => {
			assert.strictEqual(detectLaunchOS('freebsd'), 'linux');
			assert.strictEqual(detectLaunchOS('openbsd'), 'linux');
		});
		test('totally unknown → unknown', () => {
			assert.strictEqual(detectLaunchOS('haiku'), 'unknown');
			assert.strictEqual(detectLaunchOS(''), 'unknown');
		});
	});

	suite('buildExternalLaunchSpec', () => {
		test('Windows uses cmd /c start ""', () => {
			const r = buildExternalLaunchSpec('win32');
			assert.deepStrictEqual(r, { command: 'cmd', args: ['/c', 'start', ''] });
		});
		test('macOS uses open -a Terminal', () => {
			const r = buildExternalLaunchSpec('darwin');
			assert.deepStrictEqual(r, { command: 'open', args: ['-a', 'Terminal'] });
		});
		test('Linux uses x-terminal-emulator -e', () => {
			const r = buildExternalLaunchSpec('linux');
			assert.deepStrictEqual(r, { command: 'x-terminal-emulator', args: ['-e'] });
		});
		test('unknown OS → null (caller refuses)', () => {
			assert.strictEqual(buildExternalLaunchSpec('unknown'), null);
		});
	});

	suite('decideProjectCommandLaunch', () => {
		test('default terminal = integrated; reuse = reuse', () => {
			const r = decideProjectCommandLaunch({ command: cmd(), os: 'linux', isRunning: false });
			assert.strictEqual(r.kind, 'open-integrated');
			if (r.kind === 'open-integrated') {
				assert.strictEqual(r.terminalName, 'VibeIDE: Build');
				assert.strictEqual(r.reuse, 'reuse');
			}
		});

		test('explicit reusePolicy overrides default', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ terminal: 'integrated' }),
				os: 'linux',
				reusePolicy: 'alwaysNew',
				isRunning: false,
			});
			if (r.kind === 'open-integrated') {
				assert.strictEqual(r.reuse, 'alwaysNew');
			} else {
				assert.fail('expected integrated');
			}
		});

		test('background terminal → spawn-background with VibeIDE Commands channel', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ terminal: 'background' }),
				os: 'linux',
				isRunning: false,
			});
			assert.strictEqual(r.kind, 'spawn-background');
			if (r.kind === 'spawn-background') {
				assert.strictEqual(r.outputChannel, PROJECT_COMMANDS_OUTPUT_CHANNEL);
			}
		});

		test('external on Windows', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ terminal: 'external' }),
				os: 'win32',
				isRunning: false,
			});
			assert.strictEqual(r.kind, 'spawn-external');
			if (r.kind === 'spawn-external') {
				assert.strictEqual(r.os, 'win32');
				assert.strictEqual(r.externalCommand, 'cmd');
				assert.deepStrictEqual(r.externalArgs, ['/c', 'start', '']);
			}
		});

		test('external on unknown OS → refused', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ terminal: 'external' }),
				os: 'unknown',
				isRunning: false,
			});
			assert.strictEqual(r.kind, 'refused');
			if (r.kind === 'refused') {
				assert.strictEqual(r.reason, 'unknown-os-for-external');
			}
		});

		test('singleton + isRunning → refused', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ singleton: true }),
				os: 'linux',
				isRunning: true,
			});
			assert.strictEqual(r.kind, 'refused');
			if (r.kind === 'refused') {
				assert.strictEqual(r.reason, 'singleton-already-running');
			}
		});

		test('singleton + not running → integrated launch (no refusal)', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ singleton: true }),
				os: 'linux',
				isRunning: false,
			});
			assert.strictEqual(r.kind, 'open-integrated');
		});

		test('non-singleton + isRunning → still launches a new instance', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ singleton: false }),
				os: 'linux',
				isRunning: true,
			});
			assert.strictEqual(r.kind, 'open-integrated');
		});

		test('terminal name uses raw `name` (no slugification)', () => {
			const r = decideProjectCommandLaunch({
				command: cmd({ name: 'Сборка React' }),
				os: 'linux',
				isRunning: false,
			});
			if (r.kind === 'open-integrated') {
				assert.strictEqual(r.terminalName, 'VibeIDE: Сборка React');
			} else {
				assert.fail('expected integrated');
			}
		});
	});
});
