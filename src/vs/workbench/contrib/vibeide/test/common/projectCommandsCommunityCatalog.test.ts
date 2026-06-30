/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodeCommunityCatalogUrl,
	prepareCommandsPackImport,
} from '../../common/projectCommandsCommunityCatalog.js';
import { ProjectCommandLite } from '../../common/commandsImportDiff.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const sha = (c: string) => c.repeat(64);

function envelope(overrides: Record<string, unknown> = {}): unknown {
	return {
		formatVersion: 'vibe-community-commands-pack-v1',
		publishedAt: 1_750_000_000_000,
		entries: [{ id: 'a', name: 'A', content: 'irrelevant for orchestrator' }],
		manifestSha256: { a: sha('1') },
		...overrides,
	};
}

suite('Project Commands — community catalog URL + import orchestrator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeCommunityCatalogUrl', () => {
		test('undefined / null / empty / whitespace → unset', () => {
			assert.strictEqual(decodeCommunityCatalogUrl(undefined).kind, 'unset');
			assert.strictEqual(decodeCommunityCatalogUrl(null).kind, 'unset');
			assert.strictEqual(decodeCommunityCatalogUrl('').kind, 'unset');
			assert.strictEqual(decodeCommunityCatalogUrl('   ').kind, 'unset');
		});

		test('valid HTTPS → ok', () => {
			const r = decodeCommunityCatalogUrl('https://catalog.vibeide.io/commands.json');
			assert.strictEqual(r.kind, 'ok');
			if (r.kind === 'ok') { assert.ok(r.url.startsWith('https://catalog.vibeide.io/')); }
		});

		test('http (not https) → invalid', () => {
			const r = decodeCommunityCatalogUrl('http://catalog.vibeide.io/');
			assert.strictEqual(r.kind, 'invalid');
			if (r.kind === 'invalid') { assert.strictEqual(r.reason, 'not-https'); }
		});

		test('non-string → invalid', () => {
			const r = decodeCommunityCatalogUrl(42);
			assert.strictEqual(r.kind, 'invalid');
			if (r.kind === 'invalid') { assert.strictEqual(r.reason, 'not-string'); }
		});

		test('malformed URL → invalid', () => {
			const r = decodeCommunityCatalogUrl('https:// not a url');
			assert.strictEqual(r.kind, 'invalid');
		});

		test('over-length URL → invalid', () => {
			const long = 'https://example.com/' + 'a'.repeat(5000);
			const r = decodeCommunityCatalogUrl(long);
			assert.strictEqual(r.kind, 'invalid');
		});

		test('https case-insensitive scheme prefix', () => {
			const r = decodeCommunityCatalogUrl('HTTPS://catalog.vibeide.io/');
			assert.strictEqual(r.kind, 'ok');
		});

		test('javascript: rejected (not-https)', () => {
			const r = decodeCommunityCatalogUrl('javascript:alert(1)');
			assert.strictEqual(r.kind, 'invalid');
			if (r.kind === 'invalid') { assert.strictEqual(r.reason, 'not-https'); }
		});
	});

	suite('prepareCommandsPackImport', () => {
		test('happy path → kind=ready with diff', () => {
			const incoming = new Map<string, ProjectCommandLite>([
				['a', { id: 'a', command: 'echo' }],
			]);
			const r = prepareCommandsPackImport({
				raw: envelope(),
				computedHashes: [{ id: 'a', sha256: sha('1') }],
				currentCommands: [],
				incomingCommandsByPackId: incoming,
			});
			assert.strictEqual(r.kind, 'ready');
			if (r.kind === 'ready') {
				assert.strictEqual(r.envelope.formatVersion, 'vibe-community-commands-pack-v1');
				assert.strictEqual(r.diff.stats.added, 1);
			}
		});

		test('wrong format (skill catalog passed) → wrong-format with actual reported', () => {
			const r = prepareCommandsPackImport({
				raw: envelope({ formatVersion: 'vibe-community-skills-catalog-v1', manifestSha256: { a: sha('1') } }),
				computedHashes: [{ id: 'a', sha256: sha('1') }],
				currentCommands: [],
				incomingCommandsByPackId: new Map([['a', { id: 'a', command: 'echo' }]]),
			});
			assert.strictEqual(r.kind, 'wrong-format');
			if (r.kind === 'wrong-format') { assert.strictEqual(r.actual, 'vibe-community-skills-catalog-v1'); }
		});

		test('envelope decode fails → envelope-invalid', () => {
			const r = prepareCommandsPackImport({
				raw: 'not an object',
				computedHashes: [],
				currentCommands: [],
				incomingCommandsByPackId: new Map(),
			});
			assert.strictEqual(r.kind, 'envelope-invalid');
		});

		test('SHA mismatch → verify-failed', () => {
			const r = prepareCommandsPackImport({
				raw: envelope(),
				computedHashes: [{ id: 'a', sha256: sha('2') }], // wrong hash
				currentCommands: [],
				incomingCommandsByPackId: new Map([['a', { id: 'a', command: 'echo' }]]),
			});
			assert.strictEqual(r.kind, 'verify-failed');
			if (r.kind === 'verify-failed') { assert.strictEqual(r.reason, 'sha-mismatch'); }
		});

		test('caller did not provide incoming command for envelope id → missing-incoming-command', () => {
			const r = prepareCommandsPackImport({
				raw: envelope(),
				computedHashes: [{ id: 'a', sha256: sha('1') }],
				currentCommands: [],
				incomingCommandsByPackId: new Map(),
			});
			assert.strictEqual(r.kind, 'missing-incoming-command');
			if (r.kind === 'missing-incoming-command') { assert.strictEqual(r.id, 'a'); }
		});

		test('diff reports modifications when current has same id with different command', () => {
			const incoming = new Map<string, ProjectCommandLite>([
				['a', { id: 'a', command: 'rm -rf /' }],
			]);
			const r = prepareCommandsPackImport({
				raw: envelope(),
				computedHashes: [{ id: 'a', sha256: sha('1') }],
				currentCommands: [{ id: 'a', command: 'echo safe' }],
				incomingCommandsByPackId: incoming,
			});
			assert.strictEqual(r.kind, 'ready');
			if (r.kind === 'ready') {
				assert.strictEqual(r.diff.stats.modified, 1);
				assert.strictEqual(r.diff.stats.added, 0);
				assert.strictEqual(r.diff.touchesSensitiveFields, true);
			}
		});
	});
});
