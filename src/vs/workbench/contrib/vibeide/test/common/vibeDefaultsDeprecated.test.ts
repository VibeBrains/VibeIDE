/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stale-seed cleanup (`deprecated.json` of the shared VibeBrains set): a workspace copy is
// deleted ONLY when it byte-matches a known historical version; an edited copy is the user's
// work and must survive. Mock-injection follows the narrow-stub pattern of the neighbouring
// integration tests: only the IFileService methods the cleanup actually calls.

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { cleanupDeprecatedVibeDefaults, VIBE_DEFAULTS_LOCK_FILE } from '../../common/vibeDefaults.js';
import { VIBE_DEPRECATED_MANIFEST } from '../../common/vibeDefaultsManifest.generated.js';

function stubFileService(files: Map<string, string>): IFileService {
	return {
		async readFile(uri: URI) {
			const content = files.get(uri.path);
			if (content === undefined) { throw new Error(`ENOENT: ${uri.path}`); }
			return { value: VSBuffer.fromString(content) };
		},
		async del(uri: URI) { files.delete(uri.path); },
		async writeFile(uri: URI, content: VSBuffer) { files.set(uri.path, content.toString()); },
	} as unknown as IFileService;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

suite('vibeDefaults — deprecated seed cleanup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const vibeDir = URI.file('/ws/.vibe');
	const pristine = '// historical seed content\n';

	test('byte-identical stale copy is deleted and leaves the lock', async () => {
		const files = new Map<string, string>([
			['/ws/.vibe/providers/old.jsonc', pristine],
			[`/ws/.vibe/${VIBE_DEFAULTS_LOCK_FILE}`, JSON.stringify({ version: 1, files: { 'providers/old.jsonc': { release: 'r', local: 'l' } } })],
		]);
		const entries = [{ path: 'providers/old.jsonc', replacedBy: 'providers/new.jsonc', sha256: [await sha256Hex(pristine)] }];
		const result = await cleanupDeprecatedVibeDefaults(stubFileService(files), vibeDir, entries);
		assert.deepStrictEqual([...result.removed], ['providers/old.jsonc']);
		assert.strictEqual(files.has('/ws/.vibe/providers/old.jsonc'), false);
		assert.ok(!files.get(`/ws/.vibe/${VIBE_DEFAULTS_LOCK_FILE}`)!.includes('providers/old.jsonc'), 'lock keeps a phantom entry');
	});

	test('edited stale copy is reported and never touched', async () => {
		const files = new Map<string, string>([['/ws/.vibe/providers/old.jsonc', '// the user rewrote this\n']]);
		const entries = [{ path: 'providers/old.jsonc', replacedBy: null, sha256: [await sha256Hex(pristine)] }];
		const result = await cleanupDeprecatedVibeDefaults(stubFileService(files), vibeDir, entries);
		assert.deepStrictEqual([...result.removed], []);
		assert.deepStrictEqual([...result.keptModified], ['providers/old.jsonc']);
		assert.strictEqual(files.get('/ws/.vibe/providers/old.jsonc'), '// the user rewrote this\n');
	});

	test('CRLF checkout of a known version still counts as untouched', async () => {
		const files = new Map<string, string>([['/ws/.vibe/providers/old.jsonc', pristine.replace(/\n/g, '\r\n')]]);
		const entries = [{ path: 'providers/old.jsonc', replacedBy: null, sha256: [await sha256Hex(pristine)] }];
		const result = await cleanupDeprecatedVibeDefaults(stubFileService(files), vibeDir, entries);
		assert.deepStrictEqual([...result.removed], ['providers/old.jsonc']);
	});

	test('absent file is silently skipped', async () => {
		const files = new Map<string, string>();
		const entries = [{ path: 'providers/old.jsonc', replacedBy: null, sha256: [await sha256Hex(pristine)] }];
		const result = await cleanupDeprecatedVibeDefaults(stubFileService(files), vibeDir, entries);
		assert.deepStrictEqual([...result.removed], []);
		assert.deepStrictEqual([...result.keptModified], []);
	});

	test('the real generated deprecated manifest is well-formed', () => {
		assert.ok(VIBE_DEPRECATED_MANIFEST.length >= 3, 'expected the three renamed provider seeds');
		for (const entry of VIBE_DEPRECATED_MANIFEST) {
			assert.ok(entry.path.length > 0);
			assert.ok(entry.sha256.length > 0, `${entry.path}: no historical hashes`);
			for (const h of entry.sha256) { assert.match(h, /^[0-9a-f]{64}$/); }
		}
	});
});
