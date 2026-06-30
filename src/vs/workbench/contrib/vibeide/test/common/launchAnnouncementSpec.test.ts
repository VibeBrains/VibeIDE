/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	validateAnnouncement,
	describeChannelValidation,
	renderChannelPreview,
	LaunchAnnouncement,
} from '../../common/launchAnnouncementSpec.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const BASE: LaunchAnnouncement = {
	title: 'VibeIDE 0.4 — privacy-first AI IDE forked from VS Code',
	summary: 'VibeIDE is an AI-pair programming IDE with no telemetry, local Ollama support, and a typed plan/skill API. Today we are shipping signed builds for Windows, macOS Universal, and ARM Linux.',
	url: 'https://github.com/borodatych/VibeIDE',
	downloadUrl: 'https://github.com/borodatych/VibeIDE/releases/tag/v0.4.0',
	screenshots: ['https://example.com/sshot1.png'],
	version: '0.4.0',
};

suite('launchAnnouncementSpec — channel validation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('all channels happy path', () => {
		const r = validateAnnouncement(BASE, ['hn', 'reddit-rprogramming', 'reddit-rvscode', 'twitter', 'discord', 'mastodon', 'lobsters']);
		assert.strictEqual(r.ok, true);
	});

	test('HN forbids URL in title', () => {
		const a = { ...BASE, title: 'Show HN https://github.com/borodatych/VibeIDE my new IDE' };
		const r = validateAnnouncement(a, ['hn']);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.channel === 'hn' && /forbids URLs/.test(i.message)));
	});

	test('Twitter caps title at 280', () => {
		const a = { ...BASE, title: 'A'.repeat(300) };
		const r = validateAnnouncement(a, ['twitter']);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.channel === 'twitter' && /280/.test(i.message)));
	});

	test('Mastodon caps body at 500', () => {
		const a = { ...BASE, summary: 'A'.repeat(600) };
		const r = validateAnnouncement(a, ['mastodon']);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.channel === 'mastodon' && /500/.test(i.message)));
	});

	test('r/vscode requires screenshots', () => {
		const a = { ...BASE, screenshots: [] };
		const r = validateAnnouncement(a, ['reddit-rvscode']);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.channel === 'reddit-rvscode' && /screenshot/.test(i.message)));
	});

	test('r/programming does not require screenshots', () => {
		const a = { ...BASE, screenshots: [] };
		const r = validateAnnouncement(a, ['reddit-rprogramming']);
		assert.strictEqual(r.ok, true);
	});

	test('Lobsters forbids URL in title', () => {
		const a = { ...BASE, title: 'Check this out www.example.com new tool' };
		const r = validateAnnouncement(a, ['lobsters']);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.channel === 'lobsters'));
	});

	test('multi-channel returns ALL violations', () => {
		const a = { ...BASE, title: 'A'.repeat(300), screenshots: [] };
		const r = validateAnnouncement(a, ['twitter', 'reddit-rvscode']);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.channel === 'twitter'));
		assert.ok(r.issues.some(i => i.channel === 'reddit-rvscode'));
	});
});

suite('launchAnnouncementSpec — render preview', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('HN preview prefixes "Show HN:" and surfaces URL field separately', () => {
		const text = renderChannelPreview(BASE, 'hn');
		assert.match(text, /Title: Show HN: VibeIDE/);
		assert.match(text, /URL:\s+https:\/\/github\.com/);
	});

	test('Discord preview embeds emoji + version', () => {
		const text = renderChannelPreview(BASE, 'discord');
		assert.match(text, /📢 \*\*VibeIDE/);
		assert.match(text, /v0\.4\.0/);
	});

	test('Twitter preview includes hashtags', () => {
		const text = renderChannelPreview(BASE, 'twitter');
		assert.match(text, /#vscode/);
		assert.match(text, /#vibeide/);
		assert.match(text, /#v0\.4\.0/);
	});

	test('Mastodon preview keeps under 500 chars', () => {
		const text = renderChannelPreview(BASE, 'mastodon');
		assert.ok(text.length <= 500, `expected <=500 chars, got ${text.length}`);
	});
});

suite('launchAnnouncementSpec — describe', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('describe lists pass + counts when ok', () => {
		const r = validateAnnouncement(BASE, ['hn']);
		const text = describeChannelValidation(r);
		assert.match(text, /Launch announcement: OK/);
	});

	test('describe lists per-channel ERROR lines on failure', () => {
		const a = { ...BASE, screenshots: [] };
		const r = validateAnnouncement(a, ['reddit-rvscode']);
		const text = describeChannelValidation(r);
		assert.match(text, /\[ERROR\] reddit-rvscode/);
	});
});
