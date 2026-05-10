#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Self-contained smoke test for scripts/append-fork-change.mjs.
// Run: `node scripts/append-fork-change.test.mjs`. No deps, plain `assert`.

import assert from 'node:assert/strict';
import {
	extractServiceAndSummary,
	formatForkChangeLine,
	decideForkChangeAppend,
	buildEntryFromEnv,
} from './append-fork-change.mjs';

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (e) {
		console.error(`FAIL - ${name}\n  ${e.message}`);
		process.exitCode = 1;
	}
}

test('extractServiceAndSummary: conventional commit with kebab scope', () => {
	const r = extractServiceAndSummary('feat(remote-catalog): add foo');
	assert.equal(r.service, 'RemoteCatalog');
	assert.equal(r.summary, 'add foo');
});

test('extractServiceAndSummary: conventional commit without scope → Misc', () => {
	const r = extractServiceAndSummary('fix: handle null path');
	assert.equal(r.service, 'Misc');
	assert.equal(r.summary, 'handle null path');
});

test('extractServiceAndSummary: PascalCase prefix retained verbatim', () => {
	const r = extractServiceAndSummary('VibeIDESettings: tweak label');
	assert.equal(r.service, 'VibeIDESettings');
	assert.equal(r.summary, 'tweak label');
});

test('extractServiceAndSummary: bare title falls back to Misc', () => {
	const r = extractServiceAndSummary('quick patch');
	assert.equal(r.service, 'Misc');
	assert.equal(r.summary, 'quick patch');
});

test('extractServiceAndSummary: breaking-change exclamation tolerated', () => {
	const r = extractServiceAndSummary('feat(api)!: drop legacy field');
	assert.equal(r.service, 'Api');
	assert.equal(r.summary, 'drop legacy field');
});

test('formatForkChangeLine: pipe-separated with PR ref tail', () => {
	const line = formatForkChangeLine({
		date: '2026-05-10',
		service: 'Catalog',
		summary: 'add foo',
		prRef: '42',
	});
	assert.equal(line, '- date: 2026-05-10 | service: Catalog | summary: add foo (#42)');
});

test('decideForkChangeAppend: dedup by PR number', () => {
	const candidate = { date: '2026-05-10', service: 'Catalog', summary: 'add foo', prRef: '42' };
	const existing = '- date: 2025-01-01 | service: Catalog | summary: old (#42)\n';
	const r = decideForkChangeAppend(candidate, existing);
	assert.equal(r.action, 'skip');
	assert.equal(r.reason, 'duplicate-pr');
});

test('decideForkChangeAppend: dedup by composite key', () => {
	const candidate = { date: '2026-05-10', service: 'Catalog', summary: 'add foo' };
	const existing = '- date: 2026-05-10 | service: Catalog | summary: add foo\n';
	const r = decideForkChangeAppend(candidate, existing);
	assert.equal(r.action, 'skip');
	assert.equal(r.reason, 'duplicate-key');
});

test('decideForkChangeAppend: empty summary rejected', () => {
	const r = decideForkChangeAppend({ date: '2026-05-10', service: 'Catalog', summary: '   ' }, '');
	assert.equal(r.action, 'reject');
	assert.equal(r.reason, 'empty-summary');
});

test('decideForkChangeAppend: novel entry appends', () => {
	const candidate = { date: '2026-05-10', service: 'Catalog', summary: 'add foo', prRef: '42' };
	const r = decideForkChangeAppend(candidate, '# FORK_CHANGES.md\n');
	assert.equal(r.action, 'append');
	assert.equal(r.line, '- date: 2026-05-10 | service: Catalog | summary: add foo (#42)');
});

test('buildEntryFromEnv: stitches env into ForkChangeEntry shape', () => {
	const e = buildEntryFromEnv(
		{ PR_NUMBER: '7', PR_TITLE: 'feat(ui): tweak' },
		new Date('2026-05-10T00:00:00Z'),
	);
	assert.deepEqual(e, { date: '2026-05-10', service: 'Ui', summary: 'tweak', prRef: '7' });
});

test('buildEntryFromEnv: missing env throws', () => {
	assert.throws(() => buildEntryFromEnv({}), /PR_NUMBER and PR_TITLE/);
});

console.log(`\n${passed} passed`);
