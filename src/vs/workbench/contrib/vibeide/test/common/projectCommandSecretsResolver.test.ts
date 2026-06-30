/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	resolveProjectCommandSecrets,
	resolveStringPlaceholders,
	describeUnresolvedPlaceholders,
	findSuspiciousLiteralSecrets,
	SecretLookups,
	UnresolvedPlaceholder,
} from '../../common/projectCommandSecretsResolver.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const lookups = (env: Record<string, string> = {}, secret: Record<string, string> = {}): SecretLookups => ({
	env: name => env[name],
	secret: key => secret[key],
});

suite('projectCommandSecretsResolver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveStringPlaceholders', () => {
		test('all resolved → no collector entries, redacted form has [REDACTED]', () => {
			const collector: UnresolvedPlaceholder[] = [];
			const r = resolveStringPlaceholders(
				'token=${env:GITHUB_TOKEN}',
				'command', undefined,
				lookups({ GITHUB_TOKEN: 'ghp_x' }), collector,
			);
			assert.strictEqual(r.resolved, 'token=ghp_x');
			assert.strictEqual(r.redacted, 'token=[REDACTED]');
			assert.strictEqual(collector.length, 0);
			assert.strictEqual(r.resolvedCount, 1);
		});

		test('one unresolved → collector entry, original placeholder kept in redacted form', () => {
			const collector: UnresolvedPlaceholder[] = [];
			const r = resolveStringPlaceholders(
				'pass=${secret:DB_PASS}',
				'env', 'DB_URL',
				lookups({}, {}), collector,
			);
			assert.strictEqual(collector.length, 1);
			assert.strictEqual(collector[0].kind, 'secret');
			assert.strictEqual(collector[0].name, 'DB_PASS');
			assert.strictEqual(collector[0].field, 'env');
			assert.strictEqual(collector[0].index, 'DB_URL');
			assert.strictEqual(r.resolved, 'pass=${secret:DB_PASS}');  // unchanged on unresolved
			assert.strictEqual(r.redacted, 'pass=${secret:DB_PASS}');
		});

		test('mix resolved + unresolved in one string', () => {
			const collector: UnresolvedPlaceholder[] = [];
			const r = resolveStringPlaceholders(
				'a=${env:A}-b=${env:B}',
				'command', undefined,
				lookups({ A: '1' }), collector,
			);
			assert.strictEqual(r.resolved, 'a=1-b=${env:B}');
			assert.strictEqual(r.redacted, 'a=[REDACTED]-b=${env:B}');
			assert.strictEqual(collector.length, 1);
			assert.strictEqual(r.resolvedCount, 1);
		});

		test('no placeholders → identity', () => {
			const collector: UnresolvedPlaceholder[] = [];
			const r = resolveStringPlaceholders('plain text', 'command', undefined, lookups(), collector);
			assert.strictEqual(r.resolved, 'plain text');
			assert.strictEqual(r.redacted, 'plain text');
			assert.strictEqual(r.resolvedCount, 0);
		});

		test('placeholder at start / end / both sides', () => {
			const collector: UnresolvedPlaceholder[] = [];
			const r = resolveStringPlaceholders(
				'${env:A}-mid-${env:B}',
				'command', undefined,
				lookups({ A: '1', B: '2' }), collector,
			);
			assert.strictEqual(r.resolved, '1-mid-2');
			assert.strictEqual(r.redacted, '[REDACTED]-mid-[REDACTED]');
		});

		test('dot/dash/underscore allowed in placeholder name', () => {
			const collector: UnresolvedPlaceholder[] = [];
			const r = resolveStringPlaceholders(
				'${env:MY_VAR.dot-dash}',
				'command', undefined,
				lookups({ 'MY_VAR.dot-dash': '✓' }), collector,
			);
			assert.strictEqual(r.resolved, '✓');
		});
	});

	suite('resolveProjectCommandSecrets', () => {
		test('end-to-end: command + args + cwd + env all resolve', () => {
			const r = resolveProjectCommandSecrets({
				command: 'curl ${env:URL}',
				args: ['-H', 'Authorization: Bearer ${secret:TOKEN}'],
				cwd: '/tmp/${env:USER}',
				env: { CI_TOKEN: '${secret:CI}' },
			}, lookups({ URL: 'https://api', USER: 'me' }, { TOKEN: 'abc', CI: 'xyz' }));
			assert.strictEqual(r.unresolved.length, 0);
			assert.strictEqual(r.resolutionsCount, 4);
			assert.strictEqual(r.resolved.command, 'curl https://api');
			assert.deepStrictEqual(r.resolved.args, ['-H', 'Authorization: Bearer abc']);
			assert.strictEqual(r.resolved.cwd, '/tmp/me');
			assert.deepStrictEqual(r.resolved.env, { CI_TOKEN: 'xyz' });
		});

		test('redactedForAudit replaces every resolved value with [REDACTED]', () => {
			const r = resolveProjectCommandSecrets({
				command: 'curl ${env:URL}',
				args: ['-H', 'Authorization: Bearer ${secret:TOKEN}'],
			}, lookups({ URL: 'https://api' }, { TOKEN: 'abc' }));
			assert.strictEqual(r.redactedForAudit.command, 'curl [REDACTED]');
			assert.deepStrictEqual(r.redactedForAudit.args, ['-H', 'Authorization: Bearer [REDACTED]']);
		});

		test('unresolved aggregated across all fields', () => {
			const r = resolveProjectCommandSecrets({
				command: '${env:X}',
				args: ['${secret:Y}'],
				env: { Z: '${env:Z_VAL}' },
			}, lookups());
			assert.strictEqual(r.unresolved.length, 3);
			const names = r.unresolved.map(u => `${u.field}:${u.kind}:${u.name}`).sort();
			assert.deepStrictEqual(names, ['args:secret:Y', 'command:env:X', 'env:env:Z_VAL']);
		});

		test('unresolved with index for args carries numeric index', () => {
			const r = resolveProjectCommandSecrets({
				command: 'foo',
				args: ['ok', '${secret:MISSING}', 'ok2'],
			}, lookups());
			assert.strictEqual(r.unresolved[0].field, 'args');
			assert.strictEqual(r.unresolved[0].index, 1);
		});

		test('no env / args / cwd → fields default sanely', () => {
			const r = resolveProjectCommandSecrets({ command: 'echo' }, lookups());
			assert.deepStrictEqual(r.resolved.args, []);
			assert.strictEqual(r.resolved.cwd, undefined);
			assert.deepStrictEqual(r.resolved.env, {});
		});
	});

	suite('describeUnresolvedPlaceholders', () => {
		test('empty → empty string', () => {
			assert.strictEqual(describeUnresolvedPlaceholders([]), '');
		});

		test('lists each placeholder with field path', () => {
			const text = describeUnresolvedPlaceholders([
				{ kind: 'env', name: 'A', field: 'command' },
				{ kind: 'secret', name: 'B', field: 'args', index: 2 },
				{ kind: 'env', name: 'C', field: 'env', index: 'DB_URL' },
			]);
			assert.match(text, /\$\{env:A\} в command/);
			assert.match(text, /\$\{secret:B\} в args\[2\]/);
			assert.match(text, /\$\{env:C\} в env\[DB_URL\]/);
		});

		test('mentions Settings → Secrets path', () => {
			const text = describeUnresolvedPlaceholders([{ kind: 'secret', name: 'A', field: 'command' }]);
			assert.match(text, /Settings.*Secrets/);
		});
	});

	suite('findSuspiciousLiteralSecrets', () => {
		test('flags long mixed-case-digit string in command', () => {
			const out = findSuspiciousLiteralSecrets({
				command: 'curl https://api/?token=ghp_AbCdEfGhIjKlMnOp01234567890',
			});
			assert.strictEqual(out.length, 1);
		});

		test('does NOT flag plain text', () => {
			const out = findSuspiciousLiteralSecrets({ command: 'echo Hello World' });
			assert.strictEqual(out.length, 0);
		});

		test('does NOT flag strings that are placeholders', () => {
			const out = findSuspiciousLiteralSecrets({
				command: 'curl https://api/?token=${secret:TOKEN}AbCdEfGh1234567890123456789',
			});
			// Has placeholder → skip even though tail looks key-shaped
			assert.strictEqual(out.length, 0);
		});

		test('walks args + env as well', () => {
			const out = findSuspiciousLiteralSecrets({
				command: 'echo',
				args: ['xKj7-Hd5+Mn92Pq6Rt8Vw3Yz1Bd4Eg7Lp0'],
				env: { TOKEN: 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' },
			});
			assert.strictEqual(out.length, 2);
			const fields = out.map(o => o.field).sort();
			assert.deepStrictEqual(fields, ['args', 'env']);
		});

		test('strings with whitespace not flagged', () => {
			const out = findSuspiciousLiteralSecrets({
				command: 'this is a long sentence with mixed-Case and 1234 numbers',
			});
			assert.strictEqual(out.length, 0);
		});
	});
});
