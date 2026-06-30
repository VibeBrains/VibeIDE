/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeForkChangeEntry,
	formatForkChangeLine,
	dedupeForkChangeEntries,
	decideForkChangeAppend,
	ForkChangeEntry,
} from '../../common/forkChangesEntry.js';

const valid: ForkChangeEntry = {
	date: '2026-05-08',
	service: 'VibeMCPOAuthService',
	summary: 'Add PKCE flow',
	prRef: '123',
};

suite('FORK_CHANGES.md entry formatter + dedup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeForkChangeEntry', () => {
		test('happy path', () => {
			const r = decodeForkChangeEntry(valid);
			assert.strictEqual(r.ok, true);
		});

		test('rejects malformed date', () => {
			const r = decodeForkChangeEntry({ ...valid, date: '2026-5-8' });
			assert.strictEqual(r.ok, false);
		});

		test('rejects ISO with timezone', () => {
			const r = decodeForkChangeEntry({ ...valid, date: '2026-05-08T12:00:00Z' });
			assert.strictEqual(r.ok, false);
		});

		test('rejects lowercase service name', () => {
			const r = decodeForkChangeEntry({ ...valid, service: 'lowercaseService' });
			assert.strictEqual(r.ok, false);
		});

		test('rejects empty summary', () => {
			const r = decodeForkChangeEntry({ ...valid, summary: '' });
			assert.strictEqual(r.ok, false);
		});

		test('rejects too-long summary', () => {
			const r = decodeForkChangeEntry({ ...valid, summary: 'a'.repeat(300) });
			assert.strictEqual(r.ok, false);
		});

		test('trims summary whitespace', () => {
			const r = decodeForkChangeEntry({ ...valid, summary: '  Add PKCE  ' });
			if (r.ok) { assert.strictEqual(r.value.summary, 'Add PKCE'); }
		});

		test('prRef optional', () => {
			const r = decodeForkChangeEntry({ ...valid, prRef: undefined });
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.prRef, undefined); }
		});

		test('prRef numeric form accepted', () => {
			const r = decodeForkChangeEntry({ ...valid, prRef: '42' });
			assert.strictEqual(r.ok, true);
		});

		test('prRef #NNN form accepted', () => {
			const r = decodeForkChangeEntry({ ...valid, prRef: '#42' });
			assert.strictEqual(r.ok, true);
		});

		test('prRef org/repo#NNN form accepted', () => {
			const r = decodeForkChangeEntry({ ...valid, prRef: 'borodatych/vibeide#42' });
			assert.strictEqual(r.ok, true);
		});

		test('rejects malformed prRef', () => {
			const r = decodeForkChangeEntry({ ...valid, prRef: 'PR_42' });
			assert.strictEqual(r.ok, false);
		});
	});

	suite('formatForkChangeLine', () => {
		test('renders pipe-separated fields', () => {
			const line = formatForkChangeLine(valid);
			assert.strictEqual(line, '- date: 2026-05-08 | service: VibeMCPOAuthService | summary: Add PKCE flow (#123)');
		});

		test('numeric prRef → #NNN', () => {
			const line = formatForkChangeLine({ ...valid, prRef: '42' });
			assert.ok(line.endsWith('(#42)'));
		});

		test('org/repo#NNN passed through', () => {
			const line = formatForkChangeLine({ ...valid, prRef: 'borodatych/vibeide#42' });
			assert.ok(line.endsWith('(borodatych/vibeide#42)'));
		});

		test('without prRef → no parens tail', () => {
			const line = formatForkChangeLine({ ...valid, prRef: undefined });
			assert.ok(!line.endsWith(')'));
		});
	});

	suite('dedupeForkChangeEntries', () => {
		test('dedup by prRef', () => {
			const r = dedupeForkChangeEntries([
				valid,
				{ ...valid, summary: 'duplicate' },
			]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].summary, 'Add PKCE flow');
		});

		test('dedup by composite key when prRef absent', () => {
			const a: ForkChangeEntry = { ...valid, prRef: undefined };
			const b: ForkChangeEntry = { ...valid, prRef: undefined };
			const r = dedupeForkChangeEntries([a, b]);
			assert.strictEqual(r.length, 1);
		});

		test('different prRef → both kept', () => {
			const r = dedupeForkChangeEntries([
				valid,
				{ ...valid, prRef: '99' },
			]);
			assert.strictEqual(r.length, 2);
		});

		test('numeric vs #NNN normalised to same key', () => {
			const r = dedupeForkChangeEntries([
				{ ...valid, prRef: '42' },
				{ ...valid, prRef: '#42' },
			]);
			assert.strictEqual(r.length, 1);
		});

		test('empty input', () => {
			assert.deepStrictEqual(dedupeForkChangeEntries([]), []);
		});
	});

	suite('decideForkChangeAppend', () => {
		test('append when not present', () => {
			const r = decideForkChangeAppend(valid, '');
			assert.strictEqual(r.action, 'append');
			if (r.action === 'append') { assert.ok(r.line.includes('VibeMCPOAuthService')); }
		});

		test('skip when prRef already present', () => {
			const r = decideForkChangeAppend(valid, 'previous entry: (#123)\n');
			assert.strictEqual(r.action, 'skip');
			if (r.action === 'skip') { assert.strictEqual(r.reason, 'duplicate-pr'); }
		});

		test('skip when composite key matches and no prRef', () => {
			const without = { ...valid, prRef: undefined };
			const existing = formatForkChangeLine(without) + '\n';
			const r = decideForkChangeAppend(without, existing);
			assert.strictEqual(r.action, 'skip');
		});

		test('reject empty summary', () => {
			const r = decideForkChangeAppend({ ...valid, summary: '   ' }, '');
			assert.strictEqual(r.action, 'reject');
		});

		test('numeric prRef recognised in #NNN existing line', () => {
			const r = decideForkChangeAppend({ ...valid, prRef: '42' }, '(#42)\n');
			assert.strictEqual(r.action, 'skip');
		});
	});
});
