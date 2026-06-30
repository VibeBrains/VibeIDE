/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildBranchName,
	buildPrTitle,
	buildPrBody,
} from '../../common/jobPRCompletionFormat.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('VibeJobPRCompletionService — branch + PR formatter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildBranchName', () => {
		test('happy path', () => {
			const r = buildBranchName({ summary: 'Add login flow', runId: 'r123' });
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.branch, 'vibe/add-login-flow-r123');
				assert.strictEqual(r.slug, 'add-login-flow');
			}
		});

		test('custom prefix', () => {
			const r = buildBranchName({ prefix: 'agent', summary: 'Fix bug', runId: 'r1' });
			if (r.ok) { assert.ok(r.branch.startsWith('agent/')); }
		});

		test('cyrillic / non-ASCII summary slugified to empty → reject', () => {
			const r = buildBranchName({ summary: 'Привет мир', runId: 'r1' });
			assert.strictEqual(r.ok, false);
		});

		test('summary with mixed special chars sanitised', () => {
			const r = buildBranchName({ summary: 'Hello, World! @#$', runId: 'r1' });
			if (r.ok) { assert.strictEqual(r.slug, 'hello-world'); }
		});

		test('multiple consecutive separators collapsed', () => {
			const r = buildBranchName({ summary: 'a   b---c', runId: 'r1' });
			if (r.ok) { assert.strictEqual(r.slug, 'a-b-c'); }
		});

		test('rejects empty summary', () => {
			const r = buildBranchName({ summary: '', runId: 'r1' });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'summary-empty'); }
		});

		test('rejects whitespace-only summary', () => {
			const r = buildBranchName({ summary: '   ', runId: 'r1' });
			assert.strictEqual(r.ok, false);
		});

		test('rejects malformed runId', () => {
			const r = buildBranchName({ summary: 'x', runId: 'has space' });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'run-id-malformed'); }
		});

		test('default prefix is vibe', () => {
			const r = buildBranchName({ summary: 'x', runId: 'r1' });
			if (r.ok) { assert.ok(r.branch.startsWith('vibe/')); }
		});

		test('over-long summary truncated', () => {
			const r = buildBranchName({ summary: 'a'.repeat(500), runId: 'r1' });
			if (r.ok) { assert.ok(r.branch.length < 250); }
		});

		test('prefix with spaces sanitised', () => {
			const r = buildBranchName({ prefix: 'My Agent', summary: 'x', runId: 'r1' });
			if (r.ok) { assert.ok(r.branch.startsWith('my-agent/')); }
		});
	});

	suite('buildPrTitle', () => {
		test('plain summary', () => {
			const r = buildPrTitle({ summary: 'Add login flow' });
			if (r.ok) { assert.strictEqual(r.title, 'Add login flow'); }
		});

		test('conventional commit prefix', () => {
			const r = buildPrTitle({ summary: 'Add login', conventionalCommitType: 'feat', scope: 'auth' });
			if (r.ok) { assert.strictEqual(r.title, 'feat(auth): Add login'); }
		});

		test('conventional without scope', () => {
			const r = buildPrTitle({ summary: 'Refactor', conventionalCommitType: 'refactor' });
			if (r.ok) { assert.strictEqual(r.title, 'refactor: Refactor'); }
		});

		test('truncates to 72 chars with ellipsis', () => {
			const long = 'a'.repeat(100);
			const r = buildPrTitle({ summary: long });
			if (r.ok) {
				assert.strictEqual(r.title.length, 72);
				assert.ok(r.title.endsWith('…'));
			}
		});

		test('truncate keeps prefix intact', () => {
			const r = buildPrTitle({
				summary: 'a'.repeat(100),
				conventionalCommitType: 'feat',
				scope: 'auth',
			});
			if (r.ok) {
				assert.ok(r.title.startsWith('feat(auth): '));
				assert.strictEqual(r.title.length, 72);
			}
		});

		test('rejects empty summary', () => {
			const r = buildPrTitle({ summary: '' });
			assert.strictEqual(r.ok, false);
		});

		test('whitespace-only summary rejected', () => {
			const r = buildPrTitle({ summary: '   ' });
			assert.strictEqual(r.ok, false);
		});
	});

	suite('buildPrBody', () => {
		test('summary section with bullets', () => {
			const md = buildPrBody({ summaryBullets: ['Added auth', 'Wired callbacks'] });
			assert.ok(md.includes('## Summary'));
			assert.ok(md.includes('- Added auth'));
			assert.ok(md.includes('- Wired callbacks'));
		});

		test('all sections present when non-empty', () => {
			const md = buildPrBody({
				summaryBullets: ['x'],
				changedFiles: ['src/foo.ts'],
				testPlan: ['Run unit tests'],
				relatedIssues: ['Closes #42'],
			});
			assert.ok(md.includes('## Summary'));
			assert.ok(md.includes('## Changed files'));
			assert.ok(md.includes('## Test plan'));
			assert.ok(md.includes('## Related'));
		});

		test('empty section dropped (no header rendered)', () => {
			const md = buildPrBody({ summaryBullets: ['x'], changedFiles: [] });
			assert.ok(!md.includes('## Changed files'));
		});

		test('test plan uses checkbox format', () => {
			const md = buildPrBody({ summaryBullets: ['x'], testPlan: ['Verify login'] });
			assert.ok(md.includes('- [ ] Verify login'));
		});

		test('changed files >50 → truncates with "and N more"', () => {
			const files = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
			const md = buildPrBody({ summaryBullets: ['x'], changedFiles: files });
			assert.ok(md.includes('and 10 more'));
		});

		test('agent footer included by default', () => {
			const md = buildPrBody({ summaryBullets: ['x'] });
			assert.ok(md.includes('Generated by VibeIDE agent'));
		});

		test('agent footer suppressed by opt-out', () => {
			const md = buildPrBody({ summaryBullets: ['x'], includeAgentFooter: false });
			assert.ok(!md.includes('Generated by'));
		});

		test('deduplicates and trims bullets', () => {
			const md = buildPrBody({ summaryBullets: ['  same  ', 'same', 'unique', '   '] });
			const matches = md.match(/- same/g) ?? [];
			assert.strictEqual(matches.length, 1);
			assert.ok(md.includes('- unique'));
		});

		test('completely empty input → only footer (or nothing if footer off)', () => {
			const md = buildPrBody({ summaryBullets: [], includeAgentFooter: false });
			assert.strictEqual(md, '');
		});
	});
});
