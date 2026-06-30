/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	auditCssForRtl,
	summariseRtlAudit,
	renderRtlAuditMarkdown,
} from '../../common/rtlCssAuditor.js';

suite('RTL CSS auditor — physical-direction property detector', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('auditCssForRtl', () => {
		test('detects padding-left / padding-right', () => {
			const r = auditCssForRtl('a.css', '.x { padding-left: 4px; padding-right: 8px; }');
			assert.strictEqual(r.length, 2);
			assert.strictEqual(r[0].snippet, 'padding-left');
			assert.strictEqual(r[0].suggestion, 'padding-inline-start');
			assert.strictEqual(r[1].suggestion, 'padding-inline-end');
		});

		test('detects margin-left / margin-right', () => {
			const r = auditCssForRtl('a.css', '.x { margin-left: 4px; margin-right: 8px; }');
			const cats = r.map(f => f.category);
			assert.ok(cats.every(c => c === 'margin-physical'));
		});

		test('detects border-left / border-right', () => {
			const r = auditCssForRtl('a.css', '.x { border-left: 1px solid; border-right: 1px solid; }');
			assert.strictEqual(r.length, 2);
		});

		test('detects text-align: left/right', () => {
			const r = auditCssForRtl('a.css', '.x { text-align: left; } .y { text-align: right; }');
			assert.strictEqual(r.length, 2);
			assert.strictEqual(r[0].suggestion, 'text-align: start');
			assert.strictEqual(r[1].suggestion, 'text-align: end');
		});

		test('detects float: left/right', () => {
			const r = auditCssForRtl('a.css', '.x { float: left; } .y { float: right; }');
			assert.strictEqual(r.length, 2);
		});

		test('detects left:/right: positioning literals at line start', () => {
			const r = auditCssForRtl('a.css', '.x {\n  left: 0;\n  right: 0;\n}');
			const positions = r.filter(f => f.category === 'left-right-position');
			assert.strictEqual(positions.length, 2);
		});

		test('skips left/right inside comments', () => {
			const r = auditCssForRtl('a.css', '/* padding-left used to be here */ .x { color: red; }');
			assert.strictEqual(r.length, 0);
		});

		test('skips line comments', () => {
			const r = auditCssForRtl('a.css', '.x { color: red; }\n// padding-left: 4px;\n');
			assert.strictEqual(r.length, 0);
		});

		test('reports correct file path', () => {
			const r = auditCssForRtl('src/x.css', '.x { padding-left: 4px; }');
			assert.strictEqual(r[0].file, 'src/x.css');
		});

		test('reports line + column', () => {
			const r = auditCssForRtl('a.css', '\n\n.x { padding-left: 4px; }');
			assert.strictEqual(r[0].line, 3);
			assert.ok(r[0].column > 0);
		});

		test('findings sorted by (line, column)', () => {
			const r = auditCssForRtl('a.css',
				'\n.b { float: right; }\n.a { padding-left: 1px; padding-right: 2px; }');
			for (let i = 1; i < r.length; i++) {
				const prev = r[i - 1];
				const cur = r[i];
				const ok = prev.line < cur.line || (prev.line === cur.line && prev.column <= cur.column);
				assert.ok(ok, `findings should be sorted: ${JSON.stringify(prev)} vs ${JSON.stringify(cur)}`);
			}
		});

		test('empty input → empty output', () => {
			assert.deepStrictEqual([...auditCssForRtl('a.css', '')], []);
		});

		test('non-string content → empty', () => {
			assert.deepStrictEqual([...auditCssForRtl('a.css', undefined as unknown as string)], []);
		});

		test('no false positive on padding-inline-start', () => {
			const r = auditCssForRtl('a.css', '.x { padding-inline-start: 4px; }');
			assert.strictEqual(r.length, 0);
		});

		test('no false positive on `linear-gradient(left, ...)` (left as gradient direction)', () => {
			// Note: this is a known edge case — our `^left:|^right:` rule
			// doesn't trigger because there's no leading line+colon.
			const r = auditCssForRtl('a.css', '.x { background: linear-gradient(to left, red, blue); }');
			const positions = r.filter(f => f.category === 'left-right-position');
			assert.strictEqual(positions.length, 0);
		});
	});

	suite('summariseRtlAudit', () => {
		test('counts by category', () => {
			const r = auditCssForRtl('a.css', '.x { padding-left: 4px; float: right; }');
			const s = summariseRtlAudit(r);
			assert.strictEqual(s.total, 2);
			assert.strictEqual(s.byCategory['padding-physical'], 1);
			assert.strictEqual(s.byCategory['float-physical'], 1);
		});

		test('byFile counts', () => {
			const a = auditCssForRtl('a.css', '.x { padding-left: 1px; padding-right: 2px; }');
			const b = auditCssForRtl('b.css', '.y { padding-left: 1px; }');
			const s = summariseRtlAudit([...a, ...b]);
			assert.strictEqual(s.byFile['a.css'], 2);
			assert.strictEqual(s.byFile['b.css'], 1);
			assert.strictEqual(s.worstFile, 'a.css');
		});

		test('empty findings → null worstFile', () => {
			const s = summariseRtlAudit([]);
			assert.strictEqual(s.total, 0);
			assert.strictEqual(s.worstFile, null);
		});
	});

	suite('renderRtlAuditMarkdown', () => {
		test('happy path with findings', () => {
			const r = auditCssForRtl('a.css', '.x { padding-left: 4px; }');
			const md = renderRtlAuditMarkdown(r);
			assert.ok(md.includes('# RTL CSS audit'));
			assert.ok(md.includes('Total findings:** 1'));
			assert.ok(md.includes('a.css'));
		});

		test('renders ✅ when no findings', () => {
			const md = renderRtlAuditMarkdown([]);
			assert.ok(md.includes('No physical-direction properties found'));
		});

		test('truncates large lists with «and N more»', () => {
			const findings: ReturnType<typeof auditCssForRtl> = Array.from({ length: 60 }, (_, i) => ({
				file: `f${i}.css`,
				line: 1,
				column: 1,
				category: 'padding-physical' as const,
				snippet: 'padding-left',
				suggestion: 'padding-inline-start',
			}));
			const md = renderRtlAuditMarkdown(findings, 50);
			assert.ok(md.includes('and 10 more'));
		});

		test('omits empty categories', () => {
			const r = auditCssForRtl('a.css', '.x { padding-left: 4px; }');
			const md = renderRtlAuditMarkdown(r);
			assert.ok(md.includes('padding-physical: 1'));
			assert.ok(!md.includes('float-physical: 0'));
		});
	});
});
