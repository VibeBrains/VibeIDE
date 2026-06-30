/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideFIMProvider,
	describeFIMRouting,
	FIMProvider,
	FIMRoutingInput,
} from '../../common/fimProviderRouter.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const provider = (overrides: Partial<FIMProvider>): FIMProvider => ({
	id: 'p',
	kind: 'cloud',
	available: true,
	...overrides,
});

const input = (overrides: Partial<FIMRoutingInput>): FIMRoutingInput => ({
	pinnedModelId: '',
	privacyStrict: false,
	providers: [],
	chatDefaultProviderId: '',
	...overrides,
});

suite('FIM provider routing (1019)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideFIMProvider', () => {
		test('pinned + available → pinned decision', () => {
			const r = decideFIMProvider(input({
				pinnedModelId: 'qwen2.5-coder:7b',
				providers: [provider({ id: 'qwen2.5-coder:7b', kind: 'local-ollama' })],
			}));
			assert.deepStrictEqual(r, { kind: 'pinned', providerId: 'qwen2.5-coder:7b' });
		});

		test('pinned but unavailable → falls through', () => {
			const r = decideFIMProvider(input({
				pinnedModelId: 'qwen2.5-coder:7b',
				providers: [
					provider({ id: 'qwen2.5-coder:7b', kind: 'local-ollama', available: false }),
					provider({ id: 'deepseek-coder', kind: 'local-ollama', hasCoderModel: true }),
				],
			}));
			assert.strictEqual(r.kind, 'local-coder');
			if (r.kind === 'local-coder') { assert.strictEqual(r.providerId, 'deepseek-coder'); }
		});

		test('Ollama coder preferred over lmstudio coder', () => {
			const r = decideFIMProvider(input({
				providers: [
					provider({ id: 'lm', kind: 'local-lmstudio', hasCoderModel: true }),
					provider({ id: 'oll', kind: 'local-ollama', hasCoderModel: true }),
				],
			}));
			assert.strictEqual(r.kind, 'local-coder');
			if (r.kind === 'local-coder') {
				assert.strictEqual(r.providerId, 'oll');
				assert.strictEqual(r.family, 'ollama');
			}
		});

		test('local without coder tag still wins over cloud', () => {
			const r = decideFIMProvider(input({
				providers: [
					provider({ id: 'cloud-x', kind: 'cloud' }),
					provider({ id: 'local-x', kind: 'local-ollama' /* no hasCoderModel */ }),
				],
				chatDefaultProviderId: 'cloud-x',
			}));
			assert.strictEqual(r.kind, 'local-coder');
		});

		test('no local + privacy strict → no-provider-available', () => {
			const r = decideFIMProvider(input({
				privacyStrict: true,
				providers: [provider({ id: 'cloud-x', kind: 'cloud' })],
				chatDefaultProviderId: 'cloud-x',
			}));
			assert.deepStrictEqual(r, { kind: 'no-provider-available', reason: 'privacy-strict-no-local' });
		});

		test('no local + privacy off → fallback to chat default', () => {
			const r = decideFIMProvider(input({
				providers: [provider({ id: 'cloud-x', kind: 'cloud' })],
				chatDefaultProviderId: 'cloud-x',
			}));
			assert.deepStrictEqual(r, { kind: 'fallback-chat-default', providerId: 'cloud-x' });
		});

		test('nothing configured → no-provider-available(nothing-configured)', () => {
			const r = decideFIMProvider(input({}));
			assert.deepStrictEqual(r, { kind: 'no-provider-available', reason: 'nothing-configured' });
		});

		test('local provider unavailable does not block cloud fallback', () => {
			const r = decideFIMProvider(input({
				providers: [
					provider({ id: 'oll', kind: 'local-ollama', available: false, hasCoderModel: true }),
				],
				chatDefaultProviderId: 'cloud-x',
			}));
			assert.strictEqual(r.kind, 'fallback-chat-default');
		});
	});

	suite('describeFIMRouting', () => {
		test('produces non-empty description for every kind', () => {
			const samples = [
				describeFIMRouting({ kind: 'pinned', providerId: 'foo' }),
				describeFIMRouting({ kind: 'local-coder', providerId: 'oll', family: 'ollama' }),
				describeFIMRouting({ kind: 'fallback-chat-default', providerId: 'cloud' }),
				describeFIMRouting({ kind: 'no-provider-available', reason: 'privacy-strict-no-local' }),
				describeFIMRouting({ kind: 'no-provider-available', reason: 'nothing-configured' }),
			];
			for (const text of samples) { assert.ok(text.length > 0); }
		});

		test('strict-mode message mentions privacy', () => {
			const text = describeFIMRouting({ kind: 'no-provider-available', reason: 'privacy-strict-no-local' });
			assert.match(text, /privacy/i);
		});
	});
});
