/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createIgnoreMatcher, parseIgnore } from '../../common/vibeIgnore.js';

const matcher = (content: string) => createIgnoreMatcher(content);

suite('vibeIgnore — gitignore-subset matcher', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('blank lines and # comments are skipped', () => {
		assert.strictEqual(parseIgnore('\n# a comment\n\n   # indented comment\n').length, 0);
	});

	test('basename glob matches at any depth, but not a different extension', () => {
		const m = matcher('*.min.js');
		assert.ok(m.isIgnored('a/b/c.min.js'));
		assert.ok(m.isIgnored('c.min.js'));
		assert.ok(!m.isIgnored('a/b/c.js'));
	});

	test('directory pattern ignores everything underneath', () => {
		const m = matcher('node_modules/');
		assert.ok(m.isIgnored('node_modules/pkg/index.js'));
		assert.ok(m.isIgnored('sub/node_modules/pkg/index.js'));
		assert.ok(!m.isIgnored('src/app.js'));
	});

	test('leading slash anchors to root', () => {
		const m = matcher('/dist');
		assert.ok(m.isIgnored('dist/bundle.js'));
		assert.ok(!m.isIgnored('packages/x/dist/bundle.js'));
	});

	test('internal slash anchors to root too', () => {
		const m = matcher('extjs6/ext-all.js');
		assert.ok(m.isIgnored('extjs6/ext-all.js'));
		assert.ok(!m.isIgnored('vendor/extjs6/ext-all.js'));
	});

	test('the ExtJS "only -debug" rule: bundles ignored, -debug re-included (last match wins)', () => {
		const m = matcher([
			'**/ext-all.js',
			'**/ext-all-*.js',
			'!**/ext-all*-debug.js',
		].join('\n'));
		assert.ok(m.isIgnored('extjs6/ext-all.js'), 'minified main bundle ignored');
		assert.ok(m.isIgnored('extjs6/ext-all-rtl.js'), 'minified rtl bundle ignored');
		assert.ok(!m.isIgnored('extjs6/ext-all-debug.js'), 'debug build re-included');
		assert.ok(!m.isIgnored('extjs6/ext-all-rtl-debug.js'), 'rtl debug build re-included');
	});

	test('negation order matters — a later non-negated rule re-excludes', () => {
		const reExcluded = matcher(['*.js', '!keep.js', 'keep.js'].join('\n'));
		assert.ok(reExcluded.isIgnored('keep.js'), 'last matching rule (re-exclude) wins');
		const reIncluded = matcher(['*.js', 'keep.js', '!keep.js'].join('\n'));
		assert.ok(!reIncluded.isIgnored('keep.js'), 'last matching rule (negate) wins');
	});

	test('** crosses path segments', () => {
		const m = matcher('src/**/secret.txt');
		assert.ok(m.isIgnored('src/secret.txt'));
		assert.ok(m.isIgnored('src/a/b/secret.txt'));
		assert.ok(!m.isIgnored('lib/secret.txt'));
	});

	test('? matches exactly one char within a segment', () => {
		const m = matcher('file?.log');
		assert.ok(m.isIgnored('file1.log'));
		assert.ok(!m.isIgnored('file.log'));
		assert.ok(!m.isIgnored('file12.log'));
	});

	test('backslash paths are normalized and leading slashes stripped', () => {
		const m = matcher('node_modules/');
		assert.ok(m.isIgnored('node_modules\\pkg\\x.js'));
		assert.ok(m.isIgnored('/node_modules/pkg/x.js'));
	});

	test('empty content / empty path → nothing ignored', () => {
		assert.ok(!matcher('').isIgnored('anything.js'));
		assert.ok(!matcher('*.js').isIgnored(''));
	});
});
