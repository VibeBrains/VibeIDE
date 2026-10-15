/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	commandFingerprint,
	commandShapeString,
	commandTrustStorageKey,
	FingerprintedCommand,
} from '../../common/projectCommandsFingerprint.js';

const BASE: FingerprintedCommand = {
	id: 'build',
	command: 'npm',
	args: ['run', 'build'],
	cwd: 'packages/app',
	env: { NODE_ENV: 'production', CI: '1' },
	shell: false,
};

suite('Project Commands — fingerprint of an approved command', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('is a 32-char lowercase hex SHA-256 prefix', async () => {
		assert.match(await commandFingerprint(BASE), /^[0-9a-f]{32}$/);
	});

	test('the shape string pins the field order and the separators', () => {
		assert.strictEqual(
			commandShapeString(BASE),
			['build', 'npm', 'run\x1fbuild', 'packages/app', 'CI=1\x1fNODE_ENV=production', '0'].join('\x1e'),
		);
	});

	test('known vector: first 32 hex chars of a SHA-256 computed outside the code under test', async () => {
		// python3: hashlib.sha256("build\x1enpm\x1erun\x1fbuild\x1epackages/app\x1eCI=1\x1fNODE_ENV=production\x1e0")
		assert.strictEqual(await commandFingerprint(BASE), 'b836ccd8d8c2c82106694e1e2182496d');
	});

	test('does not depend on the order of env keys', async () => {
		const reordered: FingerprintedCommand = { ...BASE, env: { CI: '1', NODE_ENV: 'production' } };
		assert.strictEqual(await commandFingerprint(reordered), await commandFingerprint(BASE));
	});

	test('every field that decides what runs changes the fingerprint', async () => {
		const variants: Record<string, FingerprintedCommand> = {
			id: { ...BASE, id: 'build2' },
			command: { ...BASE, command: 'pnpm' },
			args: { ...BASE, args: ['run', 'build', '--watch'] },
			cwd: { ...BASE, cwd: 'packages/other' },
			env: { ...BASE, env: { ...BASE.env, EXTRA: '1' } },
			shell: { ...BASE, shell: true },
		};
		const base = await commandFingerprint(BASE);
		const seen = new Set<string>([base]);
		for (const [field, variant] of Object.entries(variants)) {
			const fp = await commandFingerprint(variant);
			assert.ok(!seen.has(fp), `field "${field}" did not change the fingerprint`);
			seen.add(fp);
		}
	});

	test('args that differ only by where the boundary is do not collide', async () => {
		const a = await commandFingerprint({ ...BASE, args: ['a b', 'c'] });
		const b = await commandFingerprint({ ...BASE, args: ['a', 'b c'] });
		assert.notStrictEqual(a, b);
	});

	test('absent optional fields equal their empty forms', async () => {
		const bare = { id: 'x', command: 'ls' };
		assert.strictEqual(
			await commandFingerprint(bare),
			await commandFingerprint({ ...bare, args: [], cwd: '', env: {}, shell: false }),
		);
	});

	test('storage key is per project folder and names the profile slot', () => {
		assert.deepStrictEqual(
			[commandTrustStorageKey('file:///work/a'), commandTrustStorageKey('file:///work/b')],
			['vibeide.commands.trust:file:///work/a', 'vibeide.commands.trust:file:///work/b'],
		);
	});
});
