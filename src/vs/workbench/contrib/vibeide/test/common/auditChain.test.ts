/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AUDIT_CHAIN_ROOT, chainRecord, chainTailOf, verifyAuditChain } from '../../common/auditChain.js';

/**
 * Tamper-evidence of the audit log.
 *
 * The point of the chain is a single question: if somebody removes or rewrites a line, does the
 * file still look fine? These tests answer it by actually doing the tampering, rather than by
 * asserting that a hash is a hash.
 */
suite('audit chain', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Build a chained file the way the service does. */
	const write = (records: object[]): string[] => {
		let tail = AUDIT_CHAIN_ROOT;
		return records.map(r => {
			const { line, hash } = chainRecord(r, tail);
			tail = hash;
			return line;
		});
	};

	const events = [
		{ ts: 1, actor: 'human', action: 'prompt', ok: true },
		{ ts: 2, actor: 'agent', action: 'apply', ok: true },
		{ ts: 3, actor: 'agent', action: 'tool_call:done', ok: true },
	];

	test('an untouched file verifies, and the tail continues it', () => {
		const lines = write(events);
		assert.deepStrictEqual(verifyAuditChain(lines), { ok: true, checked: 3 });
		// A restart picks the tail up and keeps going without breaking the chain.
		const { line } = chainRecord({ ts: 4, actor: 'system', action: 'rollback', ok: true }, chainTailOf(lines));
		assert.deepStrictEqual(verifyAuditChain([...lines, line]), { ok: true, checked: 4 });
	});

	test('a line cut out of the middle is reported at the line that no longer adds up', () => {
		const lines = write(events);
		assert.deepStrictEqual(
			verifyAuditChain([lines[0], lines[2]]),
			{ ok: false, line: 2, reason: 'broken-link' },
		);
	});

	test('editing a record in place breaks the NEXT link, not its own', () => {
		const lines = write(events);
		// The forger rewrites the middle record and keeps its `prev` intact — the record itself still
		// parses and still points at the right predecessor. What it cannot do is stay the predecessor
		// its successor remembers.
		const tampered = [...lines];
		tampered[1] = tampered[1].replace('"apply"', '"undo"');
		assert.deepStrictEqual(verifyAuditChain(tampered), { ok: false, line: 3, reason: 'broken-link' });
	});

	test('stripping the chain field is an accusation, not a shrug', () => {
		const lines = write(events);
		const stripped = [...lines];
		stripped[1] = JSON.stringify({ ts: 2, actor: 'agent', action: 'apply', ok: true });
		assert.deepStrictEqual(verifyAuditChain(stripped), { ok: false, line: 2, reason: 'unchained' });
	});

	test('blank lines and an empty file are not tampering', () => {
		const lines = write(events);
		assert.deepStrictEqual(verifyAuditChain(['', lines[0], '', lines[1], lines[2], '']), { ok: true, checked: 3 });
		assert.deepStrictEqual(verifyAuditChain([]), { ok: true, checked: 0 });
		assert.strictEqual(chainTailOf([]), AUDIT_CHAIN_ROOT);
		assert.strictEqual(chainTailOf(['', '  ']), AUDIT_CHAIN_ROOT);
	});

	test('garbage in the file is named as unparsable, not silently skipped', () => {
		const lines = write(events);
		assert.deepStrictEqual(verifyAuditChain([lines[0], '{not json']), { ok: false, line: 2, reason: 'unparsable' });
	});
});
