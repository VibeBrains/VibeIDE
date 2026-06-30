/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	expandUserPrompt,
	listPlaceholders,
	parseUserPromptFile,
} from '../../common/userPromptLibrary.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('userPromptLibrary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseUserPromptFile', () => {

		test('frontmatter + template — minimal', () => {
			const raw = `---
name: hello
mode: chat
---
Say hello to {{selection}}.`;
			const out = parseUserPromptFile(raw, 'fallback');
			assert.ok(out);
			assert.strictEqual(out.name, 'hello');
			assert.strictEqual(out.mode, 'chat');
			assert.strictEqual(out.template, 'Say hello to {{selection}}.');
			assert.deepStrictEqual(out.params, []);
		});

		test('no frontmatter → template is the whole file, mode defaults to chat', () => {
			const raw = 'Just a plain prompt.';
			const out = parseUserPromptFile(raw, 'plain');
			assert.ok(out);
			assert.strictEqual(out.name, 'plain');
			assert.strictEqual(out.mode, 'chat');
			assert.strictEqual(out.template, 'Just a plain prompt.');
		});

		test('mode validation — unknown mode is null', () => {
			const raw = `---
name: bad
mode: invalid
---
template`;
			assert.strictEqual(parseUserPromptFile(raw, 'fb'), null);
		});

		test('model field is captured', () => {
			const raw = `---
name: x
mode: ctrl-k
model: claude-opus-4-7
---
T`;
			const out = parseUserPromptFile(raw, 'x');
			assert.strictEqual(out?.model, 'claude-opus-4-7');
		});

		test('params block', () => {
			const raw = `---
name: rename
mode: ctrl-k
params:
  - name: target
    ask: "What to rename to?"
  - name: scope
    ask: 'Where? (file/repo)'
---
Rename {{selection}} → {{ask:target}}`;
			const out = parseUserPromptFile(raw, 'rename');
			assert.ok(out);
			assert.strictEqual(out.params.length, 2);
			assert.deepStrictEqual(out.params[0], { name: 'target', ask: 'What to rename to?' });
			assert.deepStrictEqual(out.params[1], { name: 'scope', ask: 'Where? (file/repo)' });
		});

		test('fallback name used when frontmatter omits name', () => {
			const raw = `---
mode: chat
---
T`;
			const out = parseUserPromptFile(raw, 'fallback-name');
			assert.strictEqual(out?.name, 'fallback-name');
		});

		test('incomplete params entry → null (malformed file)', () => {
			const raw = `---
name: x
mode: chat
params:
  - name: target
---
T`;
			assert.strictEqual(parseUserPromptFile(raw, 'x'), null);
		});

		test('non-string input is null', () => {
			// @ts-expect-error — intentional type bypass
			assert.strictEqual(parseUserPromptFile(123, 'x'), null);
		});
	});

	suite('listPlaceholders', () => {

		test('selection + file', () => {
			const out = listPlaceholders('Edit {{selection}} in {{file}}');
			assert.deepStrictEqual([...out], [
				{ kind: 'selection' },
				{ kind: 'file' },
			]);
		});

		test('ask placeholders extracted with names', () => {
			const out = listPlaceholders('Rename to {{ask:target}} scope {{ask:where}}');
			assert.strictEqual(out.length, 2);
			assert.deepStrictEqual(out[0], { kind: 'ask', arg: 'target' });
			assert.deepStrictEqual(out[1], { kind: 'ask', arg: 'where' });
		});

		test('duplicates are deduplicated', () => {
			const out = listPlaceholders('{{selection}} {{selection}} {{ask:x}} {{ask:x}}');
			assert.strictEqual(out.length, 2);
		});

		test('empty template → empty array', () => {
			assert.deepStrictEqual([...listPlaceholders('')], []);
		});

		test('non-string → empty array', () => {
			// @ts-expect-error — runtime defense
			assert.deepStrictEqual([...listPlaceholders(123)], []);
		});
	});

	suite('expandUserPrompt', () => {

		test('substitutes selection + file + ask values', () => {
			const out = expandUserPrompt(
				'Edit {{selection}} in {{file}} to {{ask:target}}',
				{ selection: 'foo()', file: '/x.ts', 'ask:target': 'bar()' },
			);
			assert.strictEqual(out, 'Edit foo() in /x.ts to bar()');
		});

		test('missing value substitutes empty string', () => {
			const out = expandUserPrompt('Hello {{selection}}', {});
			assert.strictEqual(out, 'Hello ');
		});

		test('no placeholders → template returned unchanged', () => {
			assert.strictEqual(expandUserPrompt('plain text', {}), 'plain text');
		});

		test('non-string template → empty string', () => {
			// @ts-expect-error
			assert.strictEqual(expandUserPrompt(123, {}), '');
		});
	});

	suite('round-trip', () => {
		test('parse → listPlaceholders → expand', () => {
			const raw = `---
name: x
mode: ctrl-k
params:
  - name: target
    ask: "Rename to?"
---
Rename {{selection}} to {{ask:target}} in {{file}}`;
			const parsed = parseUserPromptFile(raw, 'x');
			assert.ok(parsed);
			const placeholders = listPlaceholders(parsed.template);
			assert.strictEqual(placeholders.length, 3);
			const expanded = expandUserPrompt(parsed.template, {
				selection: 'oldName',
				file: '/foo.ts',
				'ask:target': 'newName',
			});
			assert.strictEqual(expanded, 'Rename oldName to newName in /foo.ts');
		});
	});
});
