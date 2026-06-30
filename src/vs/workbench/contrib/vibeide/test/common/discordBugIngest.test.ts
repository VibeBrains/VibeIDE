/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ingestDiscordMessages,
	canonicaliseTitle,
	summariseIngest,
	DiscordMessage,
	GithubIssue,
	RoadmapItem,
} from '../../common/discordBugIngest.js';

function msg(overrides: Partial<DiscordMessage>): DiscordMessage {
	return {
		id: 'm1',
		author: { id: 'u1', username: 'alice' },
		content: 'Plan dashboard freezes when switching modes',
		timestamp: '2026-05-09T12:00:00Z',
		channelId: 'c1',
		...overrides,
	};
}

suite('discordBugIngest — verdict classification', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('new message yields a "new" verdict with markdown', () => {
		const verdicts = ingestDiscordMessages([msg({})], [], []);
		assert.strictEqual(verdicts[0].kind, 'new');
		if (verdicts[0].kind === 'new') {
			assert.match(verdicts[0].markdown, /^- \[ \]/);
			assert.match(verdicts[0].markdown, /alice/);
			assert.match(verdicts[0].markdown, /2026-05-09/);
		}
	});

	test('duplicate vs existing GitHub issue is detected', () => {
		const issue: GithubIssue = {
			number: 42,
			title: 'Plan dashboard freezes when switching modes',
			state: 'open',
			url: 'https://github.com/x/y/issues/42',
		};
		const verdicts = ingestDiscordMessages([msg({})], [issue], []);
		assert.strictEqual(verdicts[0].kind, 'duplicate');
		if (verdicts[0].kind === 'duplicate') {
			assert.strictEqual(verdicts[0].matchedIssue?.number, 42);
		}
	});

	test('duplicate vs existing roadmap item is detected', () => {
		const item: RoadmapItem = {
			title: 'plan dashboard freezes when switching modes',
			source: 'manual',
		};
		const verdicts = ingestDiscordMessages([msg({})], [], [item]);
		assert.strictEqual(verdicts[0].kind, 'duplicate');
		if (verdicts[0].kind === 'duplicate') {
			assert.strictEqual(verdicts[0].matchedRoadmapItem?.source, 'manual');
		}
	});

	test('too-short message is malformed', () => {
		const v = ingestDiscordMessages([msg({ content: 'bug' })], [], []);
		assert.strictEqual(v[0].kind, 'malformed');
		if (v[0].kind === 'malformed') { assert.strictEqual(v[0].reason, 'too-short'); }
	});

	test('attachment-only is malformed', () => {
		const v = ingestDiscordMessages([msg({ content: '   ', attachments: [{ url: 'x', filename: 'crash.png' }] })], [], []);
		assert.strictEqual(v[0].kind, 'malformed');
		if (v[0].kind === 'malformed') { assert.strictEqual(v[0].reason, 'attachment-only'); }
	});

	test('PII patterns trip pii-suspected', () => {
		const cases = [
			'Email me at john.doe@example.com if this happens',
			'My IP is 192.168.1.42 and the bug occurs there always',
			'SSN-shape leak 123-45-6789 in the audit log!!!',
		];
		for (const content of cases) {
			const v = ingestDiscordMessages([msg({ content })], [], []);
			assert.strictEqual(v[0].kind, 'malformed', `expected malformed for "${content}"`);
			if (v[0].kind === 'malformed') { assert.strictEqual(v[0].reason, 'pii-suspected'); }
		}
	});
});

suite('discordBugIngest — canonicaliseTitle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lowercases, strips punctuation, collapses whitespace', () => {
		assert.strictEqual(
			canonicaliseTitle('Plan Dashboard FREEZES — when switching modes!!'),
			'plan dashboard freezes   when switching modes'.replace(/\s+/g, ' '),
		);
	});

	test('truncates to 80 chars', () => {
		const long = 'a'.repeat(200);
		assert.strictEqual(canonicaliseTitle(long).length, 80);
	});
});

suite('discordBugIngest — summary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts each verdict kind correctly', () => {
		const issue: GithubIssue = { number: 1, title: 'Plan dashboard freezes when switching modes', state: 'open', url: '' };
		const verdicts = ingestDiscordMessages(
			[
				msg({ id: '1' }),
				msg({ id: '2', content: 'bug' }),
				msg({ id: '3' }),
				msg({ id: '4', content: 'A new bug that nobody has reported before' }),
			],
			[issue],
			[],
		);
		const s = summariseIngest(verdicts);
		assert.strictEqual(s.newCount, 1, 'one truly new');
		assert.strictEqual(s.duplicateCount, 2, 'two duplicates of the issue');
		assert.strictEqual(s.malformedCount, 1, 'one too-short');
		assert.strictEqual(s.malformedByReason['too-short'], 1);
	});
});
