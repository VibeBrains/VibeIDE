/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	formatProvenanceMarker,
	isKnownProvenanceLanguage,
	shouldMarkProvenance,
} from '../../common/vibeAiProvenanceConfiguration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('AI provenance — formatProvenanceMarker / shouldMarkProvenance', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Regression: the only runtime caller passed a FILE EXTENSION (`py`, `sh`, `yml`) where the
	 * table is keyed by LANGUAGE ID (`python`, `shellscript`, `yaml`). Every lookup missed and
	 * fell through to `//`, so the opt-in marker wrote a syntax error into Python, shell, YAML,
	 * PowerShell and Markdown files. The old suite passed because it only ever fed language ids.
	 */
	test('file extensions are not language ids — the gate refuses them', () => {
		const extensions = ['py', 'rb', 'sh', 'yml', 'ps1', 'md', 'ts'];
		assert.deepStrictEqual(
			extensions.map(ext => ({ ext, known: isKnownProvenanceLanguage(ext) })),
			extensions.map(ext => ({ ext, known: false })),
		);
	});

	test('language ids the caller can resolve are accepted', () => {
		const ids = ['python', 'ruby', 'shellscript', 'yaml', 'powershell', 'markdown', 'typescript'];
		assert.deepStrictEqual(
			ids.map(id => ({ id, known: isKnownProvenanceLanguage(id) })),
			ids.map(id => ({ id, known: true })),
		);
	});

	test('comment syntax matches the language, not the default', () => {
		assert.deepStrictEqual(
			['python', 'yaml', 'shellscript', 'sql', 'markdown', 'css'].map(
				id => formatProvenanceMarker(id, 'm', 't').split(' ')[0]),
			['#', '#', '#', '--', '<!--', '/*'],
		);
	});

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
