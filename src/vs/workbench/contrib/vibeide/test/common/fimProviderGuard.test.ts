/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	guardFIMRequest,
	isNoisePath,
	pickFirstLocalProvider,
	FIMRequestContext,
} from '../../common/fimProviderGuard.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const ctx = (overrides: Partial<FIMRequestContext> = {}): FIMRequestContext => ({
	defaultProviderId: 'ollama-local',
	providerKinds: { 'ollama-local': 'local', 'anthropic': 'cloud' },
	privacyStrict: false,
	filePath: 'src/foo.ts',
	...overrides,
});

suite('FIM provider guard (1021, 1022)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('isNoisePath', () => {
		test('flags node_modules', () => {
			assert.strictEqual(isNoisePath('node_modules/foo/index.js'), true);
			assert.strictEqual(isNoisePath('packages/x/node_modules/y.js'), true);
		});

		test('flags build / dist / out', () => {
			assert.strictEqual(isNoisePath('build/main.js'), true);
			assert.strictEqual(isNoisePath('dist/index.js'), true);
			assert.strictEqual(isNoisePath('out/foo.js'), true);
			assert.strictEqual(isNoisePath('.next/static/x.js'), true);
		});

		test('flags .min files and source maps', () => {
			assert.strictEqual(isNoisePath('public/app.min.js'), true);
			assert.strictEqual(isNoisePath('public/style.min.css'), true);
			assert.strictEqual(isNoisePath('public/app.js.map'), true);
		});

		test('does not flag normal source paths', () => {
			assert.strictEqual(isNoisePath('src/index.ts'), false);
			assert.strictEqual(isNoisePath('test/foo.test.ts'), false);
		});

		test('Windows separators normalised', () => {
			assert.strictEqual(isNoisePath('packages\\x\\node_modules\\y.js'), true);
		});

		test('empty / non-string → false', () => {
			assert.strictEqual(isNoisePath(''), false);
			assert.strictEqual(isNoisePath(null as unknown as string), false);
		});
	});

	suite('guardFIMRequest', () => {
		test('allows when not strict and provider is local', () => {
			const r = guardFIMRequest(ctx());
			assert.deepStrictEqual(r, { kind: 'allow', providerId: 'ollama-local' });
		});

		test('strict mode blocks cloud provider', () => {
			const r = guardFIMRequest(ctx({ defaultProviderId: 'anthropic', privacyStrict: true }));
			assert.deepStrictEqual(r, { kind: 'block', reason: 'privacy-strict-cloud' });
		});

		test('strict mode allows local provider', () => {
			const r = guardFIMRequest(ctx({ privacyStrict: true }));
			assert.deepStrictEqual(r, { kind: 'allow', providerId: 'ollama-local' });
		});

		test('non-strict cloud also allowed (FIM defaults to cloud only when local unavailable)', () => {
			const r = guardFIMRequest(ctx({ defaultProviderId: 'anthropic' }));
			assert.deepStrictEqual(r, { kind: 'allow', providerId: 'anthropic' });
		});

		test('unknown provider rejected', () => {
			const r = guardFIMRequest(ctx({ defaultProviderId: 'mystery' }));
			assert.deepStrictEqual(r, { kind: 'block', reason: 'unknown-provider' });
		});

		test('noise path blocks regardless of provider', () => {
			const r = guardFIMRequest(ctx({ filePath: 'node_modules/x/y.js' }));
			assert.deepStrictEqual(r, { kind: 'block', reason: 'noise-path' });
		});

		test('minified file blocks', () => {
			const r = guardFIMRequest(ctx({ isMinified: true }));
			assert.deepStrictEqual(r, { kind: 'block', reason: 'minified' });
		});

		test('minified takes precedence over noise (single reason returned)', () => {
			const r = guardFIMRequest(ctx({ filePath: 'node_modules/x.js', isMinified: true }));
			assert.deepStrictEqual(r, { kind: 'block', reason: 'minified' });
		});
	});

	suite('pickFirstLocalProvider', () => {
		test('returns first local in list', () => {
			const r = pickFirstLocalProvider(['anthropic', 'ollama-local', 'lmstudio'], {
				'anthropic': 'cloud', 'ollama-local': 'local', 'lmstudio': 'local',
			});
			assert.strictEqual(r, 'ollama-local');
		});

		test('returns undefined when no local in list', () => {
			const r = pickFirstLocalProvider(['anthropic', 'openai'], {
				'anthropic': 'cloud', 'openai': 'cloud',
			});
			assert.strictEqual(r, undefined);
		});

		test('skips unknown-kind providers', () => {
			const r = pickFirstLocalProvider(['mystery', 'ollama-local'], {
				'ollama-local': 'local',
			});
			assert.strictEqual(r, 'ollama-local');
		});
	});
});
