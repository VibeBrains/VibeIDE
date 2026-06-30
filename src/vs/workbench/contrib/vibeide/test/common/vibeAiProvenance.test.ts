/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	formatProvenanceMarker,
	shouldMarkProvenance,
} from '../../common/vibeAiProvenanceConfiguration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('AI provenance — formatProvenanceMarker / shouldMarkProvenance', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('typescript uses //', () => {
		const out = formatProvenanceMarker('typescript', 'claude-sonnet-4-6', '2026-05-08T12:34:56Z');
		assert.strictEqual(out, '// @ai-generated claude-sonnet-4-6 2026-05-08T12:34:56Z');
	});

	test('python uses #', () => {
		const out = formatProvenanceMarker('python', 'claude-sonnet-4-6', '2026-05-08');
		assert.strictEqual(out, '# @ai-generated claude-sonnet-4-6 2026-05-08');
	});

	test('html uses block comment', () => {
		const out = formatProvenanceMarker('html', 'claude-sonnet-4-6', '2026-05-08');
		assert.strictEqual(out, '<!-- @ai-generated claude-sonnet-4-6 2026-05-08 -->');
	});

	test('css uses /* */', () => {
		const out = formatProvenanceMarker('css', 'claude-sonnet-4-6', '2026-05-08');
		assert.strictEqual(out, '/* @ai-generated claude-sonnet-4-6 2026-05-08 */');
	});

	test('sql uses --', () => {
		const out = formatProvenanceMarker('sql', 'claude-sonnet-4-6', '2026-05-08');
		assert.strictEqual(out, '-- @ai-generated claude-sonnet-4-6 2026-05-08');
	});

	test('unknown language defaults to //', () => {
		const out = formatProvenanceMarker('brainfuck', 'claude-sonnet-4-6', '2026-05-08');
		assert.strictEqual(out, '// @ai-generated claude-sonnet-4-6 2026-05-08');
	});

	test('language id is case-insensitive', () => {
		const a = formatProvenanceMarker('TypeScript', 'm', 't');
		const b = formatProvenanceMarker('typescript', 'm', 't');
		assert.strictEqual(a, b);
	});

	test('shouldMarkProvenance only true for boolean true', () => {
		assert.strictEqual(shouldMarkProvenance(true), true);
		assert.strictEqual(shouldMarkProvenance(false), false);
		assert.strictEqual(shouldMarkProvenance(undefined), false);
		assert.strictEqual(shouldMarkProvenance(null), false);
		assert.strictEqual(shouldMarkProvenance('true'), false);
		assert.strictEqual(shouldMarkProvenance(1), false);
	});
});
