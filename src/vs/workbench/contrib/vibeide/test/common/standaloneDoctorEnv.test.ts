/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	runStandaloneChecks,
	renderChecks,
	aggregateSeverity,
	EnvProbes,
} from '../../common/standaloneDoctorEnv.js';

function env(overrides: Partial<EnvProbes>): EnvProbes {
	return {
		nodeVersion: '20.11.1',
		npmAvailable: true,
		gitAvailable: true,
		insideVibeideRepo: false,
		vibeideAppInstalled: true,
		platform: 'win32',
		arch: 'x64',
		...overrides,
	};
}

suite('standaloneDoctorEnv', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('clean env produces all-ok with stable order', () => {
		const checks = runStandaloneChecks(env({}));
		assert.strictEqual(checks.length, 5);
		assert.deepStrictEqual(checks.map(c => c.id), [
			'node.version',
			'npm.available',
			'git.available',
			'repo.context',
			'platform',
		]);
		assert.strictEqual(aggregateSeverity(checks), 'ok');
	});

	test('old node version is an error with remediation', () => {
		const checks = runStandaloneChecks(env({ nodeVersion: '18.20.0' }));
		const node = checks.find(c => c.id === 'node.version')!;
		assert.strictEqual(node.severity, 'error');
		assert.match(node.remediation!, /Upgrade Node.js/);
	});

	test('unparseable node version is also an error', () => {
		const checks = runStandaloneChecks(env({ nodeVersion: 'unknown' }));
		const node = checks.find(c => c.id === 'node.version')!;
		assert.strictEqual(node.severity, 'error');
	});

	test('missing npm and git are warnings, not errors', () => {
		const checks = runStandaloneChecks(env({ npmAvailable: false, gitAvailable: false }));
		assert.strictEqual(checks.find(c => c.id === 'npm.available')!.severity, 'warn');
		assert.strictEqual(checks.find(c => c.id === 'git.available')!.severity, 'warn');
		assert.strictEqual(aggregateSeverity(checks), 'warn');
	});

	test('repo context: inside-repo wins over app-installed', () => {
		const checks = runStandaloneChecks(env({ insideVibeideRepo: true, vibeideAppInstalled: false }));
		const ctx = checks.find(c => c.id === 'repo.context')!;
		assert.strictEqual(ctx.severity, 'ok');
		assert.match(ctx.message, /inside the VibeIDE repository/);
	});

	test('repo context: nothing detected → warn with remediation', () => {
		const checks = runStandaloneChecks(env({ insideVibeideRepo: false, vibeideAppInstalled: false }));
		const ctx = checks.find(c => c.id === 'repo.context')!;
		assert.strictEqual(ctx.severity, 'warn');
		assert.match(ctx.remediation!, /Install VibeIDE/);
	});

	test('untested platform is a warn, not an error', () => {
		const checks = runStandaloneChecks(env({ platform: 'freebsd' }));
		const p = checks.find(c => c.id === 'platform')!;
		assert.strictEqual(p.severity, 'warn');
	});

	test('aggregate severity: error overrides warn', () => {
		const checks = runStandaloneChecks(env({ nodeVersion: '14.0.0', gitAvailable: false }));
		assert.strictEqual(aggregateSeverity(checks), 'error');
	});

	test('renderChecks emits one line per check, plus remediation for non-ok', () => {
		const checks = runStandaloneChecks(env({ npmAvailable: false }));
		const text = renderChecks(checks);
		const lines = text.split('\n');
		// 5 checks with 1 remediation line for the npm warn
		assert.strictEqual(lines.length, 6);
		assert.ok(lines.some(l => l.startsWith('[WARN]') && l.includes('npm on PATH')));
		assert.ok(lines.some(l => l.includes('→ Reinstall Node.js')));
	});

	test('renderChecks colorize=true emits ANSI codes', () => {
		const checks = runStandaloneChecks(env({}));
		const text = renderChecks(checks, { colorize: true });
		assert.match(text, /\x1b\[32m\[OK\]\x1b\[0m/);
	});
});
