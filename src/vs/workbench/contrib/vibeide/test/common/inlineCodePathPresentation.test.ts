/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { presentInlineCodePath } from '../../common/inlineCodePathPresentation.js';

/**
 * Regression: the chat used to show only the basename of inline-code paths,
 * and a folder path ending in `/` (whose basename is empty) vanished.
 */
(isWindows ? suite.skip : suite)('inline code path presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The four cases from the bug report.
	for (const written of [
		'/tmp/a/b/file.txt',
		'/tmp/a/b/',
		'/tmp/a/b',
		'~/a/b/file.txt',
	]) {
		test(`keeps the written path visible: ${written}`, () => {
			const { displayText } = presentInlineCodePath(written);
			assert.strictEqual(displayText, written);
			assert.notStrictEqual(displayText, '');
		});
	}

	test('folder path with a trailing slash does not collapse to an empty label', () => {
		const { displayText } = presentInlineCodePath('/Volumes/ExVint/Caches/standard-ul-3.0/DRULSD-250-export/');
		assert.strictEqual(displayText, '/Volumes/ExVint/Caches/standard-ul-3.0/DRULSD-250-export/');
	});

	test('absolute path still resolves a tooltip without changing the label', () => {
		const { displayText, tooltip } = presentInlineCodePath('/tmp/a/b/file.txt', () => '/a/b/file.txt');
		assert.strictEqual(displayText, '/tmp/a/b/file.txt');
		assert.strictEqual(tooltip, '/a/b/file.txt');
	});

	test('home-relative path keeps its text and has no absolute tooltip', () => {
		const { displayText, tooltip } = presentInlineCodePath('~/a/b/file.txt', () => 'should not be used');
		assert.strictEqual(displayText, '~/a/b/file.txt');
		assert.strictEqual(tooltip, undefined);
	});
});
