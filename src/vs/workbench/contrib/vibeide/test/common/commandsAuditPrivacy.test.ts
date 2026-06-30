/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	redactCommandForAudit,
	redactCommandForCloudIndex,
	redactStreamForAudit,
	decodeAuditFlags,
	ProjectCommandRunRecord,
} from '../../common/commandsAuditPrivacy.js';

const rec = (overrides: Partial<ProjectCommandRunRecord> = {}): ProjectCommandRunRecord => ({
	id: 'build',
	name: 'Build',
	command: 'npm',
	args: ['run', 'build'],
	env: { TOKEN: 'ghp_secret123', NODE_ENV: 'production' },
	exitCode: 0,
	durationMs: 1234,
	stdout: 'compiled OK\nfinished',
	stderr: '',
	...overrides,
});

suite('commandsAuditPrivacy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('redactCommandForAudit', () => {
		test('disabled flag → null (privacy by default)', () => {
			assert.strictEqual(
				redactCommandForAudit(rec(), { enabled: false, includeStdout: false }),
				null,
			);
		});

		test('enabled without includeStdout → no stdout/stderr fields', () => {
			const r = redactCommandForAudit(rec(), { enabled: true, includeStdout: false });
			assert.ok(r);
			assert.strictEqual(r!.stdout, undefined);
			assert.strictEqual(r!.stderr, undefined);
		});

		test('env values stripped, env keys sorted and present', () => {
			const r = redactCommandForAudit(rec({
				env: { ZEBRA: 'last', ALPHA: 'first', MIDDLE: 'mid' },
			}), { enabled: true, includeStdout: false });
			assert.deepStrictEqual(r!.envKeys, ['ALPHA', 'MIDDLE', 'ZEBRA']);
		});

		test('TOKEN value never appears anywhere in serialised audit shape', () => {
			const r = redactCommandForAudit(rec(), { enabled: true, includeStdout: true });
			const serialised = JSON.stringify(r);
			assert.ok(!serialised.includes('ghp_secret123'),
				`env value leaked into audit shape: ${serialised}`);
		});

		test('empty env → empty envKeys array', () => {
			const r = redactCommandForAudit(rec({ env: {} }), { enabled: true, includeStdout: false });
			assert.deepStrictEqual(r!.envKeys, []);
		});

		test('absent env (undefined) → empty envKeys array', () => {
			const r = redactCommandForAudit(rec({ env: undefined }), { enabled: true, includeStdout: false });
			assert.deepStrictEqual(r!.envKeys, []);
		});

		test('includeStdout=true → stdout/stderr present and stream-redacted', () => {
			const r = redactCommandForAudit(rec({
				stdout: 'normal log\nghp_AbCd1234567890efghijklmnop\nfinished',
			}), { enabled: true, includeStdout: true });
			assert.ok(r!.stdout);
			assert.match(r!.stdout!, /\[REDACTED LINE\]/);
			assert.ok(!r!.stdout!.includes('ghp_AbCd'));
		});

		test('cwd preserved (path is not a secret in this contract)', () => {
			const r = redactCommandForAudit(rec({ cwd: '/work/proj' }), { enabled: true, includeStdout: false });
			assert.strictEqual(r!.cwd, '/work/proj');
		});

		test('exitCode + durationMs preserved when present', () => {
			const r = redactCommandForAudit(rec(), { enabled: true, includeStdout: false });
			assert.strictEqual(r!.exitCode, 0);
			assert.strictEqual(r!.durationMs, 1234);
		});
	});

	suite('redactCommandForCloudIndex', () => {
		test('returns id + name only by default', () => {
			const r = redactCommandForCloudIndex(rec());
			assert.deepStrictEqual(Object.keys(r).sort(), ['id', 'name']);
		});

		test('description included when present', () => {
			const r = redactCommandForCloudIndex(rec({ description: 'compile the project' }));
			assert.strictEqual(r.description, 'compile the project');
		});

		test('command body NEVER included', () => {
			const r = redactCommandForCloudIndex(rec({ command: 'curl https://api.example.com/?token=secret' }));
			assert.ok(!Object.hasOwn(r, 'command'));
		});

		test('env NEVER included', () => {
			const r = redactCommandForCloudIndex(rec());
			assert.ok(!Object.hasOwn(r, 'env'));
			assert.ok(!Object.hasOwn(r, 'envKeys'));
		});
	});

	suite('redactStreamForAudit', () => {
		test('plain text passes through', () => {
			const r = redactStreamForAudit('hello world\nthis is fine');
			assert.strictEqual(r, 'hello world\nthis is fine');
		});

		test('ghp_ token line redacted', () => {
			const r = redactStreamForAudit('Authorization: Bearer ghp_AbCdEfGhIjKlMnOpQrStUv');
			assert.match(r, /\[REDACTED LINE\]/);
		});

		test('Authorization header line redacted (case-insensitive)', () => {
			const r = redactStreamForAudit('AUTHORIZATION: Bearer abc');
			assert.match(r, /\[REDACTED LINE\]/);
		});

		test('AKIA AWS key line redacted', () => {
			const r = redactStreamForAudit('aws key=AKIAIOSFODNN7EXAMPLE');
			assert.match(r, /\[REDACTED LINE\]/);
		});

		test('JWT-shaped line redacted', () => {
			const r = redactStreamForAudit('token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig');
			assert.match(r, /\[REDACTED LINE\]/);
		});

		test('long high-variety token (no prefix) redacted by length-variety heuristic', () => {
			const r = redactStreamForAudit('xKj7-Hd5+Mn92Pq6Rt8Vw3Yz1Bd4Eg7Lp0');
			assert.match(r, /\[REDACTED LINE\]/);
		});

		test('long whitespace-bearing line not redacted (likely log noise)', () => {
			const r = redactStreamForAudit('this is a long sentence with mixed-Case and 1234 numbers');
			assert.ok(!r.includes('[REDACTED LINE]'));
		});

		test('empty input → empty output', () => {
			assert.strictEqual(redactStreamForAudit(''), '');
		});

		test('multiline mix preserves clean lines, drops dirty', () => {
			const r = redactStreamForAudit('line one\nghp_AbCd1234567890EfGhIjKlMnOp\nline three');
			const lines = r.split('\n');
			assert.strictEqual(lines.length, 3);
			assert.strictEqual(lines[0], 'line one');
			assert.strictEqual(lines[1], '[REDACTED LINE]');
			assert.strictEqual(lines[2], 'line three');
		});
	});

	suite('decodeAuditFlags', () => {
		test('valid enabled+includeStdout', () => {
			const r = decodeAuditFlags({ enabled: true, includeStdout: true });
			assert.strictEqual(r.enabled, true);
			assert.strictEqual(r.includeStdout, true);
		});

		test('null/non-object → safe defaults (both false)', () => {
			assert.deepStrictEqual(decodeAuditFlags(null), { enabled: false, includeStdout: false });
			assert.deepStrictEqual(decodeAuditFlags('foo'), { enabled: false, includeStdout: false });
		});

		test('non-boolean enabled treated as false (privacy by default)', () => {
			assert.strictEqual(decodeAuditFlags({ enabled: 1, includeStdout: 1 }).enabled, false);
		});

		test('missing fields treated as false', () => {
			const r = decodeAuditFlags({});
			assert.strictEqual(r.enabled, false);
			assert.strictEqual(r.includeStdout, false);
		});
	});
});
