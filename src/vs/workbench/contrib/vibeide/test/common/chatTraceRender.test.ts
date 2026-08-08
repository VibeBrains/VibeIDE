/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatTraceEvent, renderChatTraceMarkdown, STALE_TURN_MARKER } from '../../common/chatTraceRender.js';

function event(kind: string, atMs: number, detail: Record<string, unknown>): ChatTraceEvent {
	return { atMs, ts: '03.08.2026 14:59:03', kind, detail };
}

suite('Chat trace — whose timer fired', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a stall from a superseded attempt is marked, the current one is not', () => {
		// The real shape from the 03.08.2026 stall report: a retry starts, and a second later the
		// PREVIOUS attempt's 120s timer fires.
		const md = renderChatTraceMarkdown([
			event('llmTurn:start', 0, { turn: 7, model: 'MiniMax-M3' }),
			event('llmTurn:start', 120_000, { turn: 8, model: 'MiniMax-M3' }),
			event('llmTurn:hard-stall', 121_000, { turn: 7, sec: 120, anyToken: false }),
			event('llmTurn:done', 125_000, { turn: 8, afterMs: 5000 }),
		]);
		const lines = md.split('\n').filter(l => l.startsWith('- '));
		assert.deepStrictEqual(
			lines.map(l => l.includes(STALE_TURN_MARKER)),
			[false, false, true, false],
		);
	});

	test('events without a turn are left alone, and gaps are still shown', () => {
		const md = renderChatTraceMarkdown([
			event('llmTurn:start', 0, { turn: 3 }),
			// Older builds and tool traces carry no turn — guessing about them would invent a fact.
			event('toolExec:start', 2_000, { tool: 'grep' }),
		]);
		assert.deepStrictEqual(
			{ marked: md.includes(STALE_TURN_MARKER), gap: md.includes('+2.0s') },
			{ marked: false, gap: true },
		);
	});

	test('an empty trace says so instead of rendering a bare heading', () => {
		assert.ok(renderChatTraceMarkdown([]).includes('Трейс пуст'));
	});
});
