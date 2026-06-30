/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyParamAliases } from '../../common/prompt/toolAliases.js';

suite('toolAliases — applyParamAliases', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('browse_url — canonical param is `url`, not the file-tool `uri`', () => {
		test('a correct `url` param passes through unchanged (regression: was remapped to `uri` → undefined)', () => {
			const out = applyParamAliases('browse_url', { url: 'https://example.com', refresh: 'true' });
			assert.strictEqual(out.url, 'https://example.com');
			assert.strictEqual(out.refresh, 'true');
			assert.ok(!Object.hasOwn(out, 'uri'), 'must NOT produce a `uri` key the handler never reads');
		});

		test('foreign location names normalize TO `url`', () => {
			assert.strictEqual(applyParamAliases('browse_url', { uri: 'https://a' }).url, 'https://a');
			assert.strictEqual(applyParamAliases('browse_url', { link: 'https://b' }).url, 'https://b');
			assert.strictEqual(applyParamAliases('browse_url', { href: 'https://c' }).url, 'https://c');
		});
	});

	suite('file tools keep their `uri` canon (the house convention browse_url must NOT copy)', () => {
		test('read_file: path/file_path/file → uri', () => {
			assert.strictEqual(applyParamAliases('read_file', { path: '/a' }).uri, '/a');
			assert.strictEqual(applyParamAliases('read_file', { file_path: '/b' }).uri, '/b');
			assert.strictEqual(applyParamAliases('read_file', { file: '/c' }).uri, '/c');
		});
	});

	test('unknown param keys pass through untouched', () => {
		const out = applyParamAliases('browse_url', { url: 'https://x', somethingElse: 1 });
		assert.strictEqual(out.somethingElse, 1);
	});

	test('first-wins: an already-populated canonical is not overwritten by an alias', () => {
		// `url` (canonical, passthrough) set before `uri` (alias → url) is processed → url wins.
		const out = applyParamAliases('browse_url', { url: 'https://canonical', uri: 'https://alias' });
		assert.strictEqual(out.url, 'https://canonical');
	});

	test('a tool with no alias map returns params unchanged', () => {
		const params = { anything: 'goes' };
		assert.strictEqual(applyParamAliases('no_such_tool', params), params);
	});
});
