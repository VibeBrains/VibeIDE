/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { trimThreadMessages, capToolResultSizes } from '../../common/chatThreadTrim.js';
import type { ChatMessage } from '../../common/chatThreadServiceTypes.js';

// Minimal builders — the trim only reads `m.role`; identity is tagged via content.
const user = (tag: string) => ({ role: 'user', content: tag } as unknown as ChatMessage);
const asst = (tag: string) => ({ role: 'assistant', displayContent: tag } as unknown as ChatMessage);
const tool = (tag: string) => ({ role: 'tool', content: tag } as unknown as ChatMessage);
const isMarker = (m: ChatMessage) => m.role === 'assistant' && typeof (m as { displayContent?: string }).displayContent === 'string' && (m as { displayContent: string }).displayContent.includes('trimmed from thread');
const assts = (n: number, prefix = 'a') => Array.from({ length: n }, (_, i) => asst(`${prefix}${i}`));

// `cap`/`target` are floored at 100 (matches the `maxMessagesPerThread` setting minimum),
// so tests use cap=200, headroom=100 -> target=100, with ~210-message threads.
const CAP = 200, HEADROOM = 100;

suite('trimThreadMessages — bound thread memory, pin original task (model-stalls #012)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns null when length <= cap', () => {
		assert.strictEqual(trimThreadMessages([user('task'), ...assts(150)], CAP, HEADROOM), null);
	});

	test('trims oldest down to target with a marker at the head', () => {
		const msgs = [user('task'), ...assts(209)]; // 210 -> dropCount = 210 - 100 = 110
		const r = trimThreadMessages(msgs, CAP, HEADROOM)!;
		assert.ok(r, 'should trim');
		assert.strictEqual(r.target, 100);
		assert.strictEqual(r.dropCount, 110);
		assert.strictEqual(r.trimmed.length, 102); // [anchor, marker, ...tail(100)]
		assert.ok(isMarker(r.trimmed[1]), 'marker is second (after the pinned anchor)');
	});

	test('pins the FIRST user message at the head when it would be dropped', () => {
		const anchor = user('THE TASK');
		const r = trimThreadMessages([anchor, ...assts(209)], CAP, HEADROOM)!;
		assert.strictEqual(r.pinnedAnchor, true);
		assert.strictEqual(r.trimmed[0], anchor, 'anchor object re-pinned at head (same reference)');
		assert.strictEqual(r.trimmed.filter(m => m === anchor).length, 1, 'anchor appears exactly once');
	});

	test('does NOT duplicate the first user message when it already survives in the tail', () => {
		const anchor = user('late task'); // index 150 >= dropCount(110) -> already in tail
		const msgs = [...assts(150), anchor, ...assts(59, 'b')]; // 210
		const r = trimThreadMessages(msgs, CAP, HEADROOM)!;
		assert.strictEqual(r.pinnedAnchor, false);
		assert.strictEqual(r.trimmed.filter(m => m === anchor).length, 1, 'anchor present once (in tail)');
		assert.ok(isMarker(r.trimmed[0]), 'marker is the head when nothing pinned');
	});

	test('no user message at all -> just marker + tail, no pin', () => {
		const r = trimThreadMessages(assts(210), CAP, HEADROOM)!;
		assert.strictEqual(r.pinnedAnchor, false);
		assert.ok(isMarker(r.trimmed[0]));
		assert.strictEqual(r.trimmed.length, 101); // marker + tail(100)
	});

	test('orphan tool result in the dropped region is tolerated (pin still works)', () => {
		const anchor = user('task');
		const mixed = assts(209).map((m, i) => (i === 50 ? tool('t50') : m));
		const r = trimThreadMessages([anchor, ...mixed], CAP, HEADROOM)!;
		assert.strictEqual(r.trimmed[0], anchor);
		assert.ok(isMarker(r.trimmed[1]));
	});

	test('repeated trims stay bounded and keep pinning the same anchor', () => {
		const anchor = user('original');
		let msgs: ChatMessage[] = [anchor, ...assts(209)];
		for (let round = 0; round < 5; round++) {
			const r = trimThreadMessages(msgs, CAP, HEADROOM);
			if (r) { msgs = r.trimmed; }
			msgs = [...msgs, ...assts(50, `r${round}_`)]; // session keeps appending
		}
		assert.ok(msgs.length <= CAP + 50, `bounded, got ${msgs.length}`);
		assert.strictEqual(msgs.filter(m => m === anchor).length, 1, 'original task survived all trims, once');
		assert.strictEqual(msgs[0], anchor, 'original task stays at head');
	});

	test('clamps absurd cap/headroom (cap floored at 100)', () => {
		const r = trimThreadMessages(assts(250), 5, 1)!; // cap 5 -> 100, so 250 > 100 trims
		assert.ok(r, 'clamped cap still trims a 250-message thread');
		assert.ok(r.target >= 100);
	});
});

// capToolResultSizes clamps maxResultChars to a floor of 2000, so tests use threshold 2000
// and oversized strings of ~5000 chars to trip it.
const MAXCH = 2000;
const bigContentTool = (id: string, len: number) => ({ role: 'tool', type: 'success', name: 'read_file', id, content: 'X'.repeat(len), result: null } as unknown as ChatMessage);
const resultObjTool = (id: string, fileLen: number) => ({ role: 'tool', type: 'success', name: 'read_file', id, content: 'short', result: { fileContents: 'F'.repeat(fileLen), totalNumLines: 42, hasNextPage: false } } as unknown as ChatMessage);
const errTool = (id: string, len: number) => ({ role: 'tool', type: 'tool_error', name: 'run_command', id, content: 'short', result: 'E'.repeat(len) } as unknown as ChatMessage);
const NOTE = 'усечён';

suite('capToolResultSizes — bound per-result size (renderer/disk memory)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns null when nothing exceeds the threshold', () => {
		assert.strictEqual(capToolResultSizes([user('q'), bigContentTool('t', 500), asst('a')], MAXCH, 0), null);
	});

	test('caps an oversized `content` of an old tool message, with a marker', () => {
		const r = capToolResultSizes([bigContentTool('t', 5000)], MAXCH, 0)!;
		assert.ok(r, 'should cap');
		assert.strictEqual(r.cappedCount, 1);
		assert.ok(r.charsCut > 2000, 'cut roughly the overflow');
		const m = r.messages[0] as { content: string };
		assert.ok(m.content.length < 5000 && m.content.length <= MAXCH + 200, 'content shrunk near the cap');
		assert.ok(m.content.includes(NOTE), 'marker present');
	});

	test('keepRecentFull protects the freshest results', () => {
		const r = capToolResultSizes([bigContentTool('old', 5000), bigContentTool('new', 5000)], MAXCH, 1)!;
		assert.strictEqual(r.cappedCount, 1, 'only the older tool is capped');
		assert.ok((r.messages[0] as { content: string }).content.includes(NOTE), 'old capped');
		assert.strictEqual((r.messages[1] as { content: string }).content.length, 5000, 'recent kept full');
	});

	test('caps oversized STRING field inside a `result` object, preserving other fields + shape', () => {
		const r = capToolResultSizes([resultObjTool('t', 5000)], MAXCH, 0)!;
		const res = (r.messages[0] as { result: { fileContents: string; totalNumLines: number; hasNextPage: boolean } }).result;
		assert.ok(res.fileContents.length < 5000 && res.fileContents.includes(NOTE), 'fileContents truncated');
		assert.strictEqual(res.totalNumLines, 42, 'non-string field preserved');
		assert.strictEqual(res.hasNextPage, false, 'object shape preserved');
	});

	test('caps a string `result` (tool_error)', () => {
		const r = capToolResultSizes([errTool('t', 5000)], MAXCH, 0)!;
		assert.ok(typeof (r.messages[0] as { result: string }).result === 'string');
		assert.ok((r.messages[0] as { result: string }).result.includes(NOTE));
	});

	test('never touches non-tool messages', () => {
		const longAsst = { role: 'assistant', displayContent: 'Z'.repeat(5000) } as unknown as ChatMessage;
		assert.strictEqual(capToolResultSizes([user('q'.repeat(5000)), longAsst], MAXCH, 0), null);
	});
});
