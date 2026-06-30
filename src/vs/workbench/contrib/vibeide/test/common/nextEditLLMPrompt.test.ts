/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildNextEditPrompt,
	parseNextEditCompletion,
	EditWindowContext,
} from '../../common/nextEditLLMPrompt.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function window(overrides: Partial<EditWindowContext> = {}): EditWindowContext {
	return {
		fileUri: 'file:///x.ts',
		languageId: 'typescript',
		contextLines: ['line0', 'line1', 'cursorLine', 'line3', 'line4'],
		cursorLine0: 2,
		cursorColumn0: 5,
		...overrides,
	};
}

suite('Next-edit LLM prompt builder + completion parser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildNextEditPrompt — chat style', () => {
		test('default style is chat', () => {
			const r = buildNextEditPrompt({ currentWindow: window() });
			assert.strictEqual(r.promptStyle, 'chat');
		});

		test('chat system prompt mentions JSON shape', () => {
			const r = buildNextEditPrompt({ currentWindow: window(), modelHint: 'chat' });
			assert.ok(r.systemPrompt.includes('JSON'));
			assert.ok(r.systemPrompt.includes('lineDelta'));
			assert.ok(r.systemPrompt.includes('columnDelta'));
			assert.ok(r.systemPrompt.includes('insertion'));
		});

		test('chat user prompt embeds file uri and language', () => {
			const r = buildNextEditPrompt({ currentWindow: window(), modelHint: 'chat' });
			assert.ok(r.userPrompt.includes('file:///x.ts'));
			assert.ok(r.userPrompt.includes('typescript'));
		});

		test('chat user prompt embeds last edit when provided', () => {
			const r = buildNextEditPrompt({
				currentWindow: window(),
				lastEdit: {
					fileUri: 'file:///x.ts',
					oldText: 'foo',
					newText: 'bar',
					atOffsetMs: 1500,
				},
				modelHint: 'chat',
			});
			assert.ok(r.userPrompt.includes('--- old ---'));
			assert.ok(r.userPrompt.includes('foo'));
			assert.ok(r.userPrompt.includes('bar'));
		});

		test('chat without last edit says "no recent edit"', () => {
			const r = buildNextEditPrompt({ currentWindow: window(), modelHint: 'chat' });
			assert.ok(r.userPrompt.toLowerCase().includes('no recent edit'));
		});

		test('chat stop sequences include triple newline', () => {
			const r = buildNextEditPrompt({ currentWindow: window(), modelHint: 'chat' });
			assert.ok(r.stopSequences.includes('\n\n\n'));
		});
	});

	suite('buildNextEditPrompt — fim style', () => {
		test('fim style emits FIM tokens', () => {
			const r = buildNextEditPrompt({ currentWindow: window(), modelHint: 'fim' });
			assert.strictEqual(r.promptStyle, 'fim');
			assert.ok(r.userPrompt.includes('<|fim_prefix|>'));
			assert.ok(r.userPrompt.includes('<|fim_suffix|>'));
			assert.ok(r.userPrompt.includes('<|fim_middle|>'));
		});

		test('fim system prompt empty', () => {
			const r = buildNextEditPrompt({ currentWindow: window(), modelHint: 'fim' });
			assert.strictEqual(r.systemPrompt, '');
		});

		test('fim splits at cursor column on cursor line', () => {
			const r = buildNextEditPrompt({
				currentWindow: window({
					contextLines: ['hello world'],
					cursorLine0: 0,
					cursorColumn0: 5,
				}),
				modelHint: 'fim',
			});
			assert.ok(r.userPrompt.includes('<|fim_prefix|>hello<|fim_suffix|>'));
			assert.ok(r.userPrompt.includes('<|fim_suffix|> world'));
		});

		test('fim stop sequences include FIM tokens', () => {
			const r = buildNextEditPrompt({ currentWindow: window(), modelHint: 'fim' });
			assert.ok(r.stopSequences.includes('<|fim_suffix|>'));
		});
	});

	suite('buildNextEditPrompt — context budget', () => {
		test('default budget 4000 chars', () => {
			const longLines = Array(100).fill('a'.repeat(50));
			const r = buildNextEditPrompt({
				currentWindow: window({ contextLines: longLines, cursorLine0: 50, cursorColumn0: 25 }),
			});
			assert.ok(r.userPrompt.length < 6000);
		});

		test('custom budget respected', () => {
			const longLines = Array(100).fill('b'.repeat(50));
			const r = buildNextEditPrompt({
				currentWindow: window({ contextLines: longLines, cursorLine0: 50, cursorColumn0: 25 }),
				maxContextChars: 1000,
			});
			assert.ok(r.userPrompt.length < 2000);
		});

		test('budget clamped: too small → default', () => {
			const r = buildNextEditPrompt({
				currentWindow: window(),
				maxContextChars: 10,
			});
			assert.ok(r.userPrompt.length > 100);
		});

		test('budget clamped: too large → 32k cap', () => {
			const longLines = Array(100).fill('c'.repeat(500));
			const r = buildNextEditPrompt({
				currentWindow: window({ contextLines: longLines, cursorLine0: 50, cursorColumn0: 250 }),
				maxContextChars: 1_000_000,
			});
			assert.ok(r.userPrompt.length < 40_000);
		});
	});

	suite('parseNextEditCompletion', () => {
		test('happy path JSON', () => {
			const r = parseNextEditCompletion('{"file":"file:///x.ts","lineDelta":1,"columnDelta":0,"insertion":"foo"}');
			assert.strictEqual(r.kind, 'ok');
			if (r.kind === 'ok') {
				assert.strictEqual(r.candidate.fileUri, 'file:///x.ts');
				assert.strictEqual(r.candidate.lineDelta, 1);
			}
		});

		test('extracts JSON from prose-wrapped response', () => {
			const r = parseNextEditCompletion(
				`Here's the prediction:\n{"file":"f","lineDelta":0,"columnDelta":3,"insertion":"x"}\nLet me know.`,
			);
			assert.strictEqual(r.kind, 'ok');
		});

		test('uses defaultFileUri when file omitted', () => {
			const r = parseNextEditCompletion(
				'{"lineDelta":0,"columnDelta":0,"insertion":""}',
				'file:///fallback.ts',
			);
			assert.strictEqual(r.kind, 'ok');
			if (r.kind === 'ok') { assert.strictEqual(r.candidate.fileUri, 'file:///fallback.ts'); }
		});

		test('refuses non-int lineDelta', () => {
			const r = parseNextEditCompletion('{"file":"f","lineDelta":1.5,"columnDelta":0,"insertion":""}');
			assert.strictEqual(r.kind, 'shape-mismatch');
		});

		test('refuses NaN deltas', () => {
			const r = parseNextEditCompletion('{"file":"f","lineDelta":null,"columnDelta":0,"insertion":""}');
			assert.strictEqual(r.kind, 'shape-mismatch');
		});

		test('refuses missing insertion field', () => {
			const r = parseNextEditCompletion('{"file":"f","lineDelta":0,"columnDelta":0}');
			assert.strictEqual(r.kind, 'shape-mismatch');
		});

		test('refuses non-string insertion', () => {
			const r = parseNextEditCompletion('{"file":"f","lineDelta":0,"columnDelta":0,"insertion":42}');
			assert.strictEqual(r.kind, 'shape-mismatch');
		});

		test('no-json result when no { found', () => {
			const r = parseNextEditCompletion('I cannot complete this.');
			assert.strictEqual(r.kind, 'no-json');
		});

		test('balanced-brace extraction handles nested objects', () => {
			const r = parseNextEditCompletion(
				'{"file":"f","lineDelta":0,"columnDelta":0,"insertion":"{nested:1}"}',
			);
			assert.strictEqual(r.kind, 'ok');
			if (r.kind === 'ok') { assert.strictEqual(r.candidate.insertion, '{nested:1}'); }
		});

		test('rejects file missing without default', () => {
			const r = parseNextEditCompletion('{"lineDelta":0,"columnDelta":0,"insertion":""}');
			assert.strictEqual(r.kind, 'shape-mismatch');
		});

		test('empty insertion accepted (jump-only candidate)', () => {
			const r = parseNextEditCompletion('{"file":"f","lineDelta":3,"columnDelta":0,"insertion":""}');
			assert.strictEqual(r.kind, 'ok');
		});
	});
});
