/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideRotationAction,
	decideRotationsForAll,
	ROTATION_DEFAULTS,
	MCPTokenRecord,
} from '../../common/mcpTokenRotationPolicy.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

const token = (overrides: Partial<MCPTokenRecord> = {}): MCPTokenRecord => ({
	serverId: 'github-mcp',
	provider: 'github',
	storedAt: NOW - 30 * DAY,
	lastUsedAt: NOW - DAY,
	...overrides,
});

const known = (...ids: string[]) => new Set(ids);

suite('MCP token rotation policy (920)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideRotationAction', () => {
		test('fresh token in known server → no-op', () => {
			const r = decideRotationAction(token(), NOW, known('github-mcp'));
			assert.deepStrictEqual(r, { kind: 'no-op' });
		});

		test('removed server forces auto-revoke regardless of age', () => {
			const r = decideRotationAction(token(), NOW, known(/* empty */));
			assert.deepStrictEqual(r, { kind: 'auto-revoke', serverId: 'github-mcp', reason: 'server-removed' });
		});

		test('expired explicit expiresAt → auto-revoke', () => {
			const r = decideRotationAction(
				token({ expiresAt: NOW - DAY }),
				NOW,
				known('github-mcp'),
			);
			assert.deepStrictEqual(r, { kind: 'auto-revoke', serverId: 'github-mcp', reason: 'expired' });
		});

		test('past hard rotation limit (default 365d) → auto-revoke', () => {
			const r = decideRotationAction(
				token({ storedAt: NOW - 366 * DAY }),
				NOW,
				known('github-mcp'),
			);
			assert.deepStrictEqual(r, { kind: 'auto-revoke', serverId: 'github-mcp', reason: 'hard-limit-passed' });
		});

		test('idle past idleAutoRevokeAfterMs (default 180d) → auto-revoke', () => {
			const r = decideRotationAction(
				token({ storedAt: NOW - 30 * DAY, lastUsedAt: NOW - 200 * DAY }),
				NOW,
				known('github-mcp'),
			);
			assert.deepStrictEqual(r, { kind: 'auto-revoke', serverId: 'github-mcp', reason: 'idle-too-long' });
		});

		test('soft rotation reminder past 90d', () => {
			const r = decideRotationAction(
				token({ storedAt: NOW - 100 * DAY, lastUsedAt: NOW - DAY }),
				NOW,
				known('github-mcp'),
			);
			assert.deepStrictEqual(r, { kind: 'remind', serverId: 'github-mcp', reason: 'soft-rotation-due' });
		});

		test('expiresAt within 7 days → remind expires-soon', () => {
			const r = decideRotationAction(
				token({ expiresAt: NOW + 3 * DAY }),
				NOW,
				known('github-mcp'),
			);
			assert.deepStrictEqual(r, { kind: 'remind', serverId: 'github-mcp', reason: 'expires-soon' });
		});

		test('expires-soon takes precedence over soft-rotation-due', () => {
			const r = decideRotationAction(
				token({ storedAt: NOW - 100 * DAY, expiresAt: NOW + 3 * DAY }),
				NOW,
				known('github-mcp'),
			);
			// Both conditions true, but expires-soon is more urgent.
			assert.strictEqual(r.kind, 'remind');
			if (r.kind === 'remind') { assert.strictEqual(r.reason, 'expires-soon'); }
		});

		test('lastUsedAt null falls back to storedAt for idle calc', () => {
			const r = decideRotationAction(
				token({ storedAt: NOW - 200 * DAY, lastUsedAt: null }),
				NOW,
				known('github-mcp'),
			);
			// Since storedAt is 200d ago and lastUsedAt is null → idle.
			assert.deepStrictEqual(r, { kind: 'auto-revoke', serverId: 'github-mcp', reason: 'idle-too-long' });
		});

		test('custom config respected', () => {
			const r = decideRotationAction(
				token({ storedAt: NOW - 5 * DAY }),
				NOW,
				known('github-mcp'),
				{ ...ROTATION_DEFAULTS, rotationReminderAfterMs: 3 * DAY },
			);
			assert.deepStrictEqual(r, { kind: 'remind', serverId: 'github-mcp', reason: 'soft-rotation-due' });
		});
	});

	suite('decideRotationsForAll', () => {
		test('skips no-op tokens, returns only actions', () => {
			const result = decideRotationsForAll([
				token({ serverId: 'a' }),
				token({ serverId: 'b', storedAt: NOW - 100 * DAY }),
				token({ serverId: 'c' }), // unknown server
			], NOW, known('a', 'b'));
			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].kind, 'remind');
			assert.strictEqual(result[1].kind, 'auto-revoke');
		});

		test('empty input → empty output', () => {
			assert.deepStrictEqual(decideRotationsForAll([], NOW, known()), []);
		});
	});
});
