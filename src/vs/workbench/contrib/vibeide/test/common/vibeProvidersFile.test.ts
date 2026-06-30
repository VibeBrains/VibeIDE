/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tests for the `.vibe/providers.json` format layer (vibeProvidersFile.ts): JSONC parsing,
 * resilient per-entry validation, auth-shorthand normalization, and the `extends`/override merge
 * (top-level override-wins + models-merged-by-id).
 */

import * as assert from 'assert';
import {
	parseProvidersFile,
	normalizeAuth,
	mergeProviderEntry,
	VibeProviderEntry,
} from '../../common/vibeProvidersFile.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('vibeProvidersFile — .vibe/providers.json format', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseProvidersFile', () => {
		test('parses JSONC with // comments and trailing fields', () => {
			const raw = `{
				// my providers
				"version": 1,
				"providers": [
					{ "id": "minimax", "baseURL": "https://api.minimax.io/v1" } // direct cloud
				]
			}`;
			const r = parseProvidersFile(raw);
			assert.strictEqual(r.ok, true);
			assert.strictEqual(r.providers.length, 1);
			assert.strictEqual(r.providers[0].id, 'minimax');
		});

		test('empty / non-JSON returns ok:false without throwing', () => {
			assert.strictEqual(parseProvidersFile('').ok, false);
			assert.strictEqual(parseProvidersFile('not json').ok, false);
			assert.strictEqual(parseProvidersFile('{"providers": "nope"}').ok, false);
		});

		test('skips malformed entries (no id / not object) with warnings, keeps the rest', () => {
			const raw = `{"providers": [
				{ "id": "ok" },
				{ "noId": true },
				"garbage"
			]}`;
			const r = parseProvidersFile(raw);
			assert.strictEqual(r.ok, true);
			assert.strictEqual(r.providers.length, 1);
			assert.strictEqual(r.providers[0].id, 'ok');
			assert.strictEqual(r.warnings.length, 2);
		});

		test('drops duplicate ids (first wins)', () => {
			const r = parseProvidersFile(`{"providers": [
				{ "id": "dup", "name": "A" },
				{ "id": "dup", "name": "B" }
			]}`);
			assert.strictEqual(r.providers.length, 1);
			assert.strictEqual(r.providers[0].name, 'A');
			assert.strictEqual(r.warnings.length, 1);
		});
	});

	suite('normalizeAuth', () => {
		test('defaults to bearer (undefined / shorthand)', () => {
			assert.deepStrictEqual(normalizeAuth(undefined), { type: 'bearer' });
			assert.deepStrictEqual(normalizeAuth('bearer'), { type: 'bearer' });
		});
		test('passes through explicit header/query forms', () => {
			assert.deepStrictEqual(normalizeAuth({ type: 'header', name: 'x-api-key' }), { type: 'header', name: 'x-api-key' });
			assert.deepStrictEqual(normalizeAuth({ type: 'query', name: 'key' }), { type: 'query', name: 'key' });
		});
	});

	suite('mergeProviderEntry (extends / same-id override)', () => {
		const base: VibeProviderEntry = {
			id: 'openRouter',
			baseURL: 'https://openrouter.ai/api/v1',
			timeoutMs: 180000,
			models: {
				fetch: true, static: [
					{ id: 'a/x', active: true },
					{ id: 'b/y', active: true },
				]
			},
		};

		test('top-level fields: override wins, others inherited', () => {
			const merged = mergeProviderEntry(base, { id: 'openRouter', timeoutMs: 240000 });
			assert.strictEqual(merged.baseURL, 'https://openrouter.ai/api/v1'); // inherited
			assert.strictEqual(merged.timeoutMs, 240000); // overridden
		});

		test('models merge BY ID — patch matching, append new, base ids kept', () => {
			const merged = mergeProviderEntry(base, {
				id: 'openRouter', models: {
					static: [
						{ id: 'a/x', active: false },        // patch existing
						{ id: 'c/z', active: true },         // new
					]
				}
			});
			const m = merged.models!.static!;
			const byId = Object.fromEntries(m.map(e => [e.id, e]));
			assert.strictEqual(m.length, 3);
			assert.strictEqual(byId['a/x'].active, false); // patched
			assert.strictEqual(byId['b/y'].active, true);  // inherited
			assert.strictEqual(byId['c/z'].active, true);  // appended
		});

		test('fetch is overridable; extends directive is dropped from result', () => {
			const merged = mergeProviderEntry(base, { id: 'fav', extends: 'openRouter', models: { fetch: false } });
			assert.strictEqual(merged.models!.fetch, false);
			assert.strictEqual((merged as { extends?: string }).extends, undefined);
		});
	});
});
