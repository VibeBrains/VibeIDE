/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	scanUnwrappedLiterals,
	summarize,
	renderScanMarkdown,
} from '../../common/i18nUnwrappedScanner.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('i18nUnwrappedScanner', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects unwrapped notify message', () => {
		const src = `
			notificationService.notify({ severity: Severity.Info, message: 'Hello world from VibeIDE' });
		`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 1);
		assert.strictEqual(r.findings[0].callsite, 'notify');
		assert.match(r.findings[0].snippet, /Hello world/);
	});

	test('skips wrapped localize() call', () => {
		const src = `
			notificationService.notify({ message: localize('vibe.k', 'Hello world from VibeIDE') });
		`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 0);
	});

	test('skips short / pure-id literals', () => {
		const src = `
			showInformationMessage('id.dot.key');
			showInformationMessage('OK');
			showInformationMessage('vs');
		`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 0);
	});

	test('detects multiple call sites and sorts by line/col', () => {
		const src = `
			showWarningMessage('Be careful with this');
			showErrorMessage('Something went wrong here');
		`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 2);
		assert.ok(r.findings[0].line < r.findings[1].line);
	});

	test('cyrillic literal counts as user-facing without whitespace', () => {
		const src = `placeHolder: 'Введите'`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 1);
		assert.strictEqual(r.findings[0].callsite, 'placeholder');
	});

	test('summarize aggregates by callsite', () => {
		const perFile = [
			{ filePath: 'a.ts', result: scanUnwrappedLiterals(`showWarningMessage('Foo bar')`) },
			{ filePath: 'b.ts', result: scanUnwrappedLiterals(`title: 'My title text'`) },
			{ filePath: 'c.ts', result: scanUnwrappedLiterals(`tooltip: 'Hover hint here'`) },
		];
		const s = summarize(perFile);
		assert.strictEqual(s.totalFiles, 3);
		assert.strictEqual(s.totalFindings, 3);
		assert.strictEqual(s.byCallsite.showWarningMessage, 1);
		assert.strictEqual(s.byCallsite.title, 1);
		assert.strictEqual(s.byCallsite.tooltip, 1);
	});

	test('renderScanMarkdown returns clean message when no findings', () => {
		const md = renderScanMarkdown({ totalFiles: 1, totalFindings: 0, byCallsite: { notify: 0, showInformationMessage: 0, showWarningMessage: 0, showErrorMessage: 0, placeholder: 0, title: 0, tooltip: 0, unknown: 0 } }, []);
		assert.match(md, /No unwrapped user-facing literals/);
	});

	test('renderScanMarkdown lists findings sorted by file count desc', () => {
		const perFile = [
			{ filePath: 'few.ts', result: scanUnwrappedLiterals(`showWarningMessage('First finding')`) },
			{ filePath: 'many.ts', result: scanUnwrappedLiterals(`showWarningMessage('A')\nshowErrorMessage('Two messages')\nshowInformationMessage('Three messages')`) },
		];
		const md = renderScanMarkdown(summarize(perFile), perFile);
		assert.ok(md.indexOf('many.ts') < md.indexOf('few.ts'), 'higher-count file should appear first');
	});

	test('handles empty source', () => {
		const r = scanUnwrappedLiterals('');
		assert.strictEqual(r.findings.length, 0);
		assert.strictEqual(r.visitedSites, 0);
	});

	test('skips URLs and paths', () => {
		const src = `
			title: 'https://example.com/foo'
			placeHolder: './relative/path'
		`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 0);
	});

	test('skips brand-allowlist entries (proper nouns / product names)', () => {
		// All of these are in BRAND_ALLOWLIST and must NOT be flagged.
		const src = `
			title: 'LM Studio'
			title: 'LM Router'
			title: 'Grok (xAI)'
			title: 'Google Vertex AI'
			title: 'Microsoft Azure OpenAI'
			title: 'AWS Bedrock'
			title: 'OpenCode Zen'
			title: 'OpenCode Go'
			title: 'Pollinations'
		`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 0, 'brand allowlist must filter all 9 entries');
	});

	test('still flags non-brand RU labels even alongside brands', () => {
		const src = `
			title: 'LM Studio'
			title: 'Ключ API'
		`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 1);
		assert.match(r.findings[0].snippet, /Ключ API/);
	});

	test('@i18n-scan-skip-file directive in header skips the whole file', () => {
		const src = `/**
 * Pure helper — CLI labels only.
 *
 * @i18n-scan-skip-file — output is terminal-only English text.
 */

const checks = [
    { title: 'Node.js version', severity: 'ok' },
    { title: 'git on PATH', severity: 'warn' },
];
`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 0, 'skip-file directive must short-circuit the scan');
	});

	test('@i18n-scan-skip-file mentioned outside header (line 100+) still triggers normal scan', () => {
		const padding = Array.from({ length: 60 }, () => '// filler line for byte budget budget budget budget').join('\n');
		const src = `${padding}\n${padding}\n// @i18n-scan-skip-file (too late — outside header window)\ntitle: 'Ключ API'`;
		const r = scanUnwrappedLiterals(src);
		assert.strictEqual(r.findings.length, 1, 'directive past 2000-byte header window must NOT skip');
	});
});
