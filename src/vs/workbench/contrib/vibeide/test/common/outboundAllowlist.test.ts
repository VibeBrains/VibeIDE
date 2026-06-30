/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	evaluateOutbound,
	buildDefaultAllowlist,
	OutboundAllowlistEntry,
} from '../../common/outboundAllowlist.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const allowEntry = (pattern: string, kind: OutboundAllowlistEntry['kind']): OutboundAllowlistEntry => ({ pattern, kind });

suite('Outbound allowlist (1047)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('evaluateOutbound — privacy off', () => {
		test('every URL allowed when privacyStrict=false', () => {
			const r = evaluateOutbound({ url: 'https://anywhere.com/', privacyStrict: false, allowlist: [] });
			assert.deepStrictEqual(r, { kind: 'allow', reason: 'always-allow' });
		});
	});

	suite('evaluateOutbound — privacy strict', () => {
		test('exact-host match → allow', () => {
			const r = evaluateOutbound({
				url: 'https://api.anthropic.com/v1/messages',
				privacyStrict: true,
				allowlist: [allowEntry('api.anthropic.com', 'host')],
			});
			assert.strictEqual(r.kind, 'allow');
		});

		test('exact-host case-insensitive', () => {
			const r = evaluateOutbound({
				url: 'https://API.Anthropic.COM/',
				privacyStrict: true,
				allowlist: [allowEntry('api.anthropic.com', 'host')],
			});
			assert.strictEqual(r.kind, 'allow');
		});

		test('host-wildcard matches subdomain', () => {
			const r = evaluateOutbound({
				url: 'https://cdn.anthropic.com/',
				privacyStrict: true,
				allowlist: [allowEntry('*.anthropic.com', 'host-wildcard')],
			});
			assert.strictEqual(r.kind, 'allow');
		});

		test('host-wildcard does NOT match bare base domain', () => {
			const r = evaluateOutbound({
				url: 'https://anthropic.com/',
				privacyStrict: true,
				allowlist: [allowEntry('*.anthropic.com', 'host-wildcard')],
			});
			assert.strictEqual(r.kind, 'block');
		});

		test('localhost-port requires both host AND port match', () => {
			const list = [allowEntry('localhost:11434', 'localhost-port')];
			assert.strictEqual(evaluateOutbound({
				url: 'http://localhost:11434/api/generate',
				privacyStrict: true,
				allowlist: list,
			}).kind, 'allow');
			assert.strictEqual(evaluateOutbound({
				url: 'http://localhost:8080/',
				privacyStrict: true,
				allowlist: list,
			}).kind, 'block');
		});

		test('prefix match', () => {
			const list = [allowEntry('https://github.com/borodatych/', 'prefix')];
			assert.strictEqual(evaluateOutbound({
				url: 'https://github.com/borodatych/VibeIDE/releases',
				privacyStrict: true,
				allowlist: list,
			}).kind, 'allow');
			assert.strictEqual(evaluateOutbound({
				url: 'https://github.com/other/repo',
				privacyStrict: true,
				allowlist: list,
			}).kind, 'block');
		});

		test('malformed URL → block', () => {
			const r = evaluateOutbound({
				url: 'not a url',
				privacyStrict: true,
				allowlist: [],
			});
			assert.deepStrictEqual(r, { kind: 'block', reason: 'malformed-url' });
		});

		test('non-http scheme → block', () => {
			const r = evaluateOutbound({
				url: 'ftp://example.com/',
				privacyStrict: true,
				allowlist: [allowEntry('example.com', 'host')],
			});
			assert.deepStrictEqual(r, { kind: 'block', reason: 'non-http-scheme' });
		});

		test('empty allowlist → block', () => {
			const r = evaluateOutbound({
				url: 'https://api.anthropic.com/',
				privacyStrict: true,
				allowlist: [],
			});
			assert.deepStrictEqual(r, { kind: 'block', reason: 'no-allowlist-match' });
		});

		test('matched entry attached to decision', () => {
			const entry = { pattern: 'api.anthropic.com', kind: 'host' as const, note: 'Anthropic API' };
			const r = evaluateOutbound({
				url: 'https://api.anthropic.com/',
				privacyStrict: true,
				allowlist: [entry],
			});
			if (r.kind === 'allow') {
				assert.strictEqual(r.matchedEntry?.note, 'Anthropic API');
			} else {
				assert.fail('Expected allow');
			}
		});
	});

	suite('buildDefaultAllowlist', () => {
		test('contains Ollama / lmstudio / GitHub defaults', () => {
			const list = buildDefaultAllowlist();
			assert.ok(list.some(e => e.pattern === 'localhost:11434'));
			assert.ok(list.some(e => e.pattern === 'localhost:1234'));
			assert.ok(list.some(e => e.pattern.startsWith('https://api.github.com')));
		});

		test('adds MCP server hostnames', () => {
			const list = buildDefaultAllowlist(['https://mcp-server.example.com/api']);
			assert.ok(list.some(e => e.pattern === 'mcp-server.example.com' && e.kind === 'host'));
		});

		test('skips malformed MCP URLs silently', () => {
			const list = buildDefaultAllowlist(['not-a-url', 'https://valid.com/']);
			assert.ok(list.some(e => e.pattern === 'valid.com'));
			assert.ok(!list.some(e => e.pattern === 'not-a-url'));
		});
	});
});
