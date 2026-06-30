/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	diffSpecHeuristic,
	diffOpenApi,
	diffGraphql,
	describeSeverity,
} from '../../common/specDrivenContextSkeleton.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('VibeSpecDrivenContextService — heuristic + sentinels', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('diffSpecHeuristic', () => {
		test('identical inputs → no entries', () => {
			const r = diffSpecHeuristic({ kind: 'openapi', oldText: 'paths: {}', newText: 'paths: {}' });
			assert.deepStrictEqual(r.entries, []);
			assert.strictEqual(r.hasBreaking, false);
		});

		test('shrink >20% → major', () => {
			const r = diffSpecHeuristic({
				kind: 'openapi',
				oldText: 'a'.repeat(1000),
				newText: 'a'.repeat(500),
			});
			assert.strictEqual(r.entries.length, 1);
			assert.strictEqual(r.entries[0].severity, 'major');
			assert.strictEqual(r.hasBreaking, true);
		});

		test('grow >3x → minor', () => {
			const r = diffSpecHeuristic({
				kind: 'graphql',
				oldText: 'a'.repeat(100),
				newText: 'a'.repeat(500),
			});
			assert.strictEqual(r.entries[0].severity, 'minor');
			assert.strictEqual(r.hasBreaking, false);
		});

		test('small change → patch', () => {
			const r = diffSpecHeuristic({
				kind: 'openapi',
				oldText: 'a'.repeat(100),
				newText: 'b'.repeat(100),
			});
			assert.strictEqual(r.entries[0].severity, 'patch');
		});

		test('empty old text → unknown, not breaking', () => {
			const r = diffSpecHeuristic({ kind: 'openapi', oldText: '', newText: 'x' });
			assert.strictEqual(r.entries[0].severity, 'unknown');
			assert.strictEqual(r.hasBreaking, false);
		});

		test('empty new text → unknown, breaking (full removal)', () => {
			const r = diffSpecHeuristic({ kind: 'openapi', oldText: 'x', newText: '' });
			assert.strictEqual(r.entries[0].severity, 'unknown');
			assert.strictEqual(r.hasBreaking, true);
		});

		test('kind forwarded to entry', () => {
			const r = diffSpecHeuristic({
				kind: 'graphql',
				oldText: 'a'.repeat(100),
				newText: 'b'.repeat(100),
			});
			assert.strictEqual(r.entries[0].kind, 'graphql');
		});

		test('boundary 20% shrink not yet major', () => {
			const r = diffSpecHeuristic({
				kind: 'openapi',
				oldText: 'a'.repeat(100),
				newText: 'a'.repeat(85),
			});
			assert.strictEqual(r.entries[0].severity, 'patch');
		});

		test('exactly 80% size = boundary → not major', () => {
			const r = diffSpecHeuristic({
				kind: 'openapi',
				oldText: 'a'.repeat(100),
				newText: 'a'.repeat(80),
			});
			assert.notStrictEqual(r.entries[0].severity, 'major');
		});
	});

	suite('parser-aware diffs', () => {
		test('diffOpenApi: removed path → major breaking', () => {
			const oldSpec = JSON.stringify({ paths: { '/a': {}, '/b': {} } });
			const newSpec = JSON.stringify({ paths: { '/a': {} } });
			const r = diffOpenApi({ oldSpec, newSpec });
			assert.strictEqual(r.hasBreaking, true);
			assert.ok(r.entries.some(e => e.severity === 'major' && /path removed/.test(e.summary)));
		});

		test('diffOpenApi: removed schema → major breaking', () => {
			const oldSpec = JSON.stringify({ components: { schemas: { User: {}, Post: {} } } });
			const newSpec = JSON.stringify({ components: { schemas: { User: {} } } });
			const r = diffOpenApi({ oldSpec, newSpec });
			assert.ok(r.entries.some(e => e.severity === 'major' && /schema removed/.test(e.summary)));
		});

		test('diffOpenApi: non-JSON input falls back to heuristic (no throw)', () => {
			const r = diffOpenApi({ oldSpec: 'a', newSpec: 'b' });
			assert.strictEqual(r.entries[0].severity, 'patch');
		});

		test('diffGraphql: unparseable old schema falls back to heuristic (no throw)', () => {
			// Empty old spec → heuristic regardless of whether `graphql` is installed.
			const r = diffGraphql({ oldSpec: '', newSpec: 'type Query { a: Int }' });
			assert.strictEqual(r.entries[0].severity, 'unknown');
			assert.strictEqual(r.hasBreaking, false);
		});
	});

	suite('describeSeverity', () => {
		test('all four severities have RU labels', () => {
			assert.ok(describeSeverity('major').length > 0);
			assert.ok(describeSeverity('minor').length > 0);
			assert.ok(describeSeverity('patch').length > 0);
			assert.ok(describeSeverity('unknown').length > 0);
		});

		test('major label mentions критич', () => {
			assert.ok(describeSeverity('major').toLowerCase().includes('критич'));
		});
	});
});
