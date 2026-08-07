/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseTelegramCommand, resolveProjectChoice } from '../../common/telegram/telegramCommandParse.js';
import { decidePairing, extractPairingCode, generatePairingCode, PAIRING_PROMPT_COOLDOWN_MS } from '../../common/telegram/telegramPairing.js';
import { markdownToTelegramHtml, splitForTelegram, escapeTelegramHtml, formatProgressLine, TELEGRAM_MESSAGE_LIMIT } from '../../common/telegram/telegramFormat.js';

suite('Telegram bridge — command parsing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('commands, plain text and group mentions', () => {
		assert.deepStrictEqual(
			[
				parseTelegramCommand('/start'),
				parseTelegramCommand('/status@my_vibe_bot'),
				parseTelegramCommand('  /projects  '),
				parseTelegramCommand('/use BuzzBang'),
				parseTelegramCommand('/run почини тесты'),
				parseTelegramCommand('почини тесты'),
				parseTelegramCommand('/run'),
				parseTelegramCommand('   '),
				// An unknown slash-word is a task, not an error — people write paths.
				parseTelegramCommand('/etc/hosts не читается'),
			],
			[
				{ kind: 'start' },
				{ kind: 'status' },
				{ kind: 'projects' },
				{ kind: 'use', project: 'BuzzBang' },
				{ kind: 'run', prompt: 'почини тесты' },
				{ kind: 'run', prompt: 'почини тесты' },
				{ kind: 'empty' },
				{ kind: 'empty' },
				{ kind: 'run', prompt: '/etc/hosts не читается' },
			],
		);
	});

	test('project choice: exact, prefix, ambiguous, missing', () => {
		const windows = [
			{ projectName: 'BuzzBang' },
			{ projectName: 'BuzzAdmin' },
			{ projectName: 'VibeIDE' },
			{ projectName: undefined },
		];
		assert.deepStrictEqual(
			[
				resolveProjectChoice(windows, 'vibeide'),
				resolveProjectChoice(windows, 'buzzb'),
				resolveProjectChoice(windows, 'buzz'),
				resolveProjectChoice(windows, 'нет-такого'),
				resolveProjectChoice(windows, '  '),
			],
			[
				{ match: { projectName: 'VibeIDE' } },
				{ match: { projectName: 'BuzzBang' } },
				{ ambiguous: [{ projectName: 'BuzzBang' }, { projectName: 'BuzzAdmin' }] },
				undefined,
				undefined,
			],
		);
	});
});

suite('Telegram bridge — formatting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('markdown becomes safe Telegram HTML', () => {
		assert.deepStrictEqual(
			[
				escapeTelegramHtml('a < b & c > d'),
				markdownToTelegramHtml('**жирный** и `код`'),
				markdownToTelegramHtml('см. [доки](https://example.com/a?b=1)'),
				// Content inside a fence must survive untouched, including markup characters.
				markdownToTelegramHtml('До\n```ts\nconst a = **не жирный** && b < c;\n```\nПосле'),
				// A tag typed by the model is escaped, never emitted as markup.
				markdownToTelegramHtml('<script>alert(1)</script>'),
			],
			[
				'a &lt; b &amp; c &gt; d',
				'<b>жирный</b> и <code>код</code>',
				'см. <a href="https://example.com/a?b=1">доки</a>',
				'До\n<pre><code>const a = **не жирный** &amp;&amp; b &lt; c;</code></pre>\nПосле',
				'&lt;script&gt;alert(1)&lt;/script&gt;',
			],
		);
	});

	test('splitting respects the message limit and prefers line breaks', () => {
		const line = 'x'.repeat(100);
		const many = Array.from({ length: 60 }, () => line).join('\n');
		const chunks = splitForTelegram(many);
		const oneLongLine = splitForTelegram('y'.repeat(TELEGRAM_MESSAGE_LIMIT + 10));

		assert.deepStrictEqual(
			{
				short: splitForTelegram('коротко'),
				everyChunkFits: chunks.every(c => c.length <= TELEGRAM_MESSAGE_LIMIT),
				nothingLost: chunks.join('\n') === many,
				hardCutCount: oneLongLine.length,
			},
			{
				short: ['коротко'],
				everyChunkFits: true,
				nothingLost: true,
				hardCutCount: 2,
			},
		);
	});

	test('progress line reads as time plus activity', () => {
		assert.deepStrictEqual(
			[
				formatProgressLine(5000, undefined),
				formatProgressLine(95000, 'читаю vibeServerViewPane.ts'),
			],
			[
				'⏳ Работаю 5 с',
				'⏳ Работаю 1 мин 35 с: читаю vibeServerViewPane.ts',
			],
		);
	});
});

suite('Telegram bridge — who may ask for access', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const base = { chatType: 'private', expectedCode: 'abcd-2345', lastPromptAtMs: undefined, nowMs: 1_000_000 };

	test('a stranger without the code is ignored silently', () => {
		assert.deepStrictEqual(
			[
				decidePairing({ ...base, text: 'привет' }),
				decidePairing({ ...base, text: '/start' }),
				// Wrong code and no code must be indistinguishable, or the bot becomes a code oracle.
				decidePairing({ ...base, text: '/start wxyz-9999' }),
			],
			[
				{ kind: 'ignore' },
				{ kind: 'ignore' },
				{ kind: 'ignore' },
			],
		);
	});

	test('the right code asks the owner; bare code counts too', () => {
		assert.deepStrictEqual(
			[
				decidePairing({ ...base, text: '/start abcd-2345' }),
				decidePairing({ ...base, text: 'abcd-2345' }),
				decidePairing({ ...base, text: '/start@my_bot abcd-2345' }),
			],
			[{ kind: 'ask' }, { kind: 'ask' }, { kind: 'ask' }],
		);
	});

	test('groups are refused even with a valid code, and repeats are throttled', () => {
		const group = decidePairing({ ...base, chatType: 'supergroup', text: '/start abcd-2345' });
		const tooSoon = decidePairing({ ...base, text: '/start abcd-2345', lastPromptAtMs: base.nowMs - 1000 });
		const afterCooldown = decidePairing({ ...base, text: '/start abcd-2345', lastPromptAtMs: base.nowMs - PAIRING_PROMPT_COOLDOWN_MS - 1 });

		assert.deepStrictEqual(
			{ group: group.kind, tooSoon: tooSoon.kind, afterCooldown: afterCooldown.kind },
			{ group: 'reject', tooSoon: 'reject', afterCooldown: 'ask' },
		);
	});

	test('code extraction and generation', () => {
		let counter = 0;
		assert.deepStrictEqual(
			{
				fromCommand: extractPairingCode('/start abcd-2345'),
				fromBare: extractPairingCode('  abcd-2345  '),
				fromEmpty: extractPairingCode('   '),
				// Deterministic generator: the alphabet excludes lookalikes (no o/0, l/1).
				generated: generatePairingCode(() => (counter++) % 32),
			},
			{
				fromCommand: 'abcd-2345',
				fromBare: 'abcd-2345',
				fromEmpty: undefined,
				generated: 'abcd-efgh',
			},
		);
	});
});
