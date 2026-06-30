/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tests for `alignReplacementIndentation` — the SEARCH/REPLACE indentation aligner that fixes the
 * "edit_file ate my first line's indent" spiral. Two real shapes are covered distinctly:
 *
 *   | Shape                       | searchIndent | fileIndent | final body indent | expected fix       |
 *   |-----------------------------|--------------|------------|-------------------|--------------------|
 *   | exact (no-op)               | 8            | 8          | —                 | unchanged          |
 *   | consistent dedent           | 0            | 8          | 0                 | shift ALL +8       |
 *   | first-line omission         | 0            | 8          | 8 (absolute)      | fix FIRST line only|
 *   | over-indent (remove)        | 8            | 4          | 8                 | shift ALL -4       |
 *   | single-line final           | 0            | 8          | —                 | add 8              |
 *   | incompatible ws (tabs/space)| \t           | 4 spaces   | tabs              | fix first line     |
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { alignReplacementIndentation, firstNonBlankLine, getLeadingWhitespace, isAtLineStart } from '../../common/helpers/reindentSearchReplace.js';

suite('reindentSearchReplace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('getLeadingWhitespace', () => {
		assert.strictEqual(getLeadingWhitespace('        code'), '        ');
		assert.strictEqual(getLeadingWhitespace('\t\tcode'), '\t\t');
		assert.strictEqual(getLeadingWhitespace('code'), '');
		assert.strictEqual(getLeadingWhitespace(''), '');
	});

	test('firstNonBlankLine skips blank lines', () => {
		assert.strictEqual(firstNonBlankLine('\n\n   \n        x\ny'), '        x');
		assert.strictEqual(firstNonBlankLine('first'), 'first');
		assert.strictEqual(firstNonBlankLine('\n  \n'), '');
	});

	test('exact indent → unchanged', () => {
		const final = '        a\n        b';
		assert.strictEqual(alignReplacementIndentation('        ', '        ', final), final);
	});

	test('consistent dedent → shift every line by the delta', () => {
		// model wrote the whole block at column 0, file lives at 8 spaces
		const final = '// c\nconst x = 1;\nif (x) {\n    y();\n}';
		const out = alignReplacementIndentation('', '        ', final);
		assert.strictEqual(out,
			'        // c\n        const x = 1;\n        if (x) {\n            y();\n        }');
	});

	test('first-line omission → fix only the first line (body already absolute)', () => {
		// The observed Promed bug: first line lost its indent, the rest sit at the file's 8 spaces.
		const final = [
			'// Содержимое грида живёт в собственном store панели,',
			'        // а не в formStore.',
			'        const p = ctrl.getView();',
			'        if (p) { vm.set(\'x\', p.getGridData()); }',
		].join('\n');
		const out = alignReplacementIndentation('', '        ', final);
		assert.strictEqual(out, [
			'        // Содержимое грида живёт в собственном store панели,',
			'        // а не в formStore.',
			'        const p = ctrl.getView();',
			'        if (p) { vm.set(\'x\', p.getGridData()); }',
		].join('\n'), 'first line snapped to 8 spaces, body untouched');
	});

	test('over-indent → remove the extra prefix from every line', () => {
		const final = '        a\n        b';
		const out = alignReplacementIndentation('        ', '    ', final);
		assert.strictEqual(out, '    a\n    b');
	});

	test('dedent branch + replacement first line flush-left → snap first line to file indent', () => {
		// Observed bug: model indented its search anchor (2 tabs) but the file anchor is 1 tab, AND
		// the replacement comment was written flush-left. The dedent map left it at column 0; the
		// first-line snap must lift it to the file's 1-tab indent instead of eating all the spaces.
		assert.strictEqual(
			alignReplacementIndentation('\t\t', '\t', '// Оставлю как пример'),
			'\t// Оставлю как пример',
		);
		// Same shape with spaces: search 8, file 4, replacement first line at column 0.
		assert.strictEqual(
			alignReplacementIndentation('        ', '    ', 'const x = 1;'),
			'    const x = 1;',
		);
	});

	test('single-line final, model dropped indent → add file indent', () => {
		assert.strictEqual(alignReplacementIndentation('', '        ', 'ctrl.mask();'), '        ctrl.mask();');
	});

	test('blank lines inside the block keep their blankness (no spaces injected)', () => {
		const final = '// c\n\nconst x = 1;';
		const out = alignReplacementIndentation('', '    ', final);
		assert.strictEqual(out, '    // c\n\n    const x = 1;');
	});

	test('incompatible whitespace (tabs vs spaces) → at least align the first line', () => {
		// searchIndent is a tab, fileIndent is 4 spaces → no prefix relation either way.
		const final = 'first\n\tbody';
		const out = alignReplacementIndentation('\t', '    ', final);
		assert.strictEqual(out, '    first\n\tbody');
	});

	test('empty final → unchanged', () => {
		assert.strictEqual(alignReplacementIndentation('', '        ', ''), '');
	});

	test('isAtLineStart distinguishes line-aligned vs mid-line indexOf hits', () => {
		const file = '        log(x);\n        next();';
		assert.strictEqual(isAtLineStart(file, 0), true, 'start of text');
		// indexOf of the un-indented text lands AFTER the 8 leading spaces → mid-line, not line-aligned.
		const mid = file.indexOf('log(x);');
		assert.ok(mid > 0);
		assert.strictEqual(isAtLineStart(file, mid), false, 'mid-line hit');
		// The same text WITH its indent matches at the line boundary.
		assert.strictEqual(isAtLineStart(file, file.indexOf('        log(x);')), true, 'line-aligned hit');
	});

	test('regression: mid-line indexOf must NOT count as exact → reindent restores the first line', () => {
		// The Promed spiral. The file's anchor is indented; the model's old_string dropped the FIRST
		// line's 8 spaces, so a raw `indexOf` matches from the middle of the indented line. That hit is
		// NOT line-aligned, so findTextInCode marks the match inexact and the reindent path realigns the
		// replacement — restoring the indent instead of snapping the first line to column 0 (which sent
		// weaker models into an endless "fix the whitespace" retry loop).
		const file = [
			"        log('>> onSprLoad', params);",
			'        ctrl.resetStates();',
			'',
			'        if (!view.patoSprLoaded) {',
		].join('\n');
		const oldStr = "log('>> onSprLoad', params);\n        ctrl.resetStates();\n\n        if (!view.patoSprLoaded) {";
		const newStr = "log('>> onSprLoad', params);\n        // reset moved to onHide\n\n        if (!view.patoSprLoaded) {";

		const idx = file.indexOf(oldStr);
		assert.ok(idx > 0, 'old_string matches the file mid-line (after the dropped indent)');
		assert.strictEqual(isAtLineStart(file, idx), false, 'mid-line hit → treated as inexact → reindent path runs');

		// The realignment the inexact path applies (mirrors editCodeService.findTextInCode call site):
		const fileIndent = getLeadingWhitespace("        log('>> onSprLoad', params);");
		const searchIndent = getLeadingWhitespace(firstNonBlankLine(oldStr));
		const aligned = alignReplacementIndentation(searchIndent, fileIndent, newStr);
		assert.strictEqual(aligned, [
			"        log('>> onSprLoad', params);",
			'        // reset moved to onHide',
			'',
			'        if (!view.patoSprLoaded) {',
		].join('\n'), 'first line restored to 8 spaces, body untouched');
	});
});
