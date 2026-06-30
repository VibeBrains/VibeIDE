/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { injectReloadScript, VIBE_RELOAD_WS_PATH } from '../../common/vibeServer/injectReloadScript.js';

const MARKER = 'data-vibe-server-reload';

suite('Vibe Server — reload script injection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('injects before </body> and carries the ws path', () => {
		const out = injectReloadScript('<html><body><h1>Hi</h1></body></html>');
		const scriptIndex = out.indexOf(MARKER);
		assert.ok(scriptIndex >= 0, 'marker present');
		assert.ok(scriptIndex < out.indexOf('</body>'), 'script sits before </body>');
		assert.ok(out.includes(VIBE_RELOAD_WS_PATH), 'ws path embedded');
	});

	test('falls back to </head> when there is no body', () => {
		const out = injectReloadScript('<html><head><title>x</title></head></html>');
		assert.ok(out.indexOf(MARKER) < out.indexOf('</head>'), 'script sits before </head>');
	});

	test('appends when the document has no closing tags', () => {
		const out = injectReloadScript('<h1>fragment</h1>');
		assert.ok(out.startsWith('<h1>fragment</h1>'), 'original content preserved at start');
		assert.ok(out.includes(MARKER), 'script appended');
	});

	test('is idempotent — an already-injected document is returned unchanged', () => {
		const once = injectReloadScript('<body></body>');
		const twice = injectReloadScript(once);
		assert.strictEqual(twice, once);
	});
});
