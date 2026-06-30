/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	routeMemoryWrite,
	auditMemoryLayers,
	MemoryRecord,
	SHORT_TERM_TTL_MS,
} from '../../common/memoryLayerRouter.js';

const NOW = 1_000_000;

const rec = (overrides: Partial<MemoryRecord>): MemoryRecord => ({
	id: 'r1',
	layer: 'long-term',
	content: 'fact',
	workspaceScoped: true,
	...overrides,
});

suite('Memory layer routing (1060)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('routeMemoryWrite', () => {
		test('user-explicit → explicit layer regardless of other flags', () => {
			const r = routeMemoryWrite({
				userExplicit: true,
				workspaceScoped: false,
				threadOnly: true,
			}, NOW);
			assert.strictEqual(r.layer, 'explicit');
			assert.strictEqual(r.reason, 'user-explicit-save');
		});

		test('thread-only → short-term with TTL hint', () => {
			const r = routeMemoryWrite({
				userExplicit: false,
				workspaceScoped: false,
				threadOnly: true,
			}, NOW);
			assert.strictEqual(r.layer, 'short-term');
			assert.strictEqual(r.reason, 'thread-scoped');
			assert.strictEqual(r.expiresAtHint, NOW + SHORT_TERM_TTL_MS);
		});

		test('ttlHint under 1 day → short-term', () => {
			const r = routeMemoryWrite({
				userExplicit: false,
				workspaceScoped: true,
				threadOnly: false,
				ttlHintMs: 60 * 60 * 1000,
			}, NOW);
			assert.strictEqual(r.layer, 'short-term');
			assert.strictEqual(r.reason, 'ttl-under-1-day');
			assert.strictEqual(r.expiresAtHint, NOW + 60 * 60 * 1000);
		});

		test('workspace-scoped → long-term', () => {
			const r = routeMemoryWrite({
				userExplicit: false,
				workspaceScoped: true,
				threadOnly: false,
			}, NOW);
			assert.strictEqual(r.layer, 'long-term');
			assert.strictEqual(r.reason, 'workspace-scoped-fact');
		});

		test('fallback → short-term when no explicit scope flag', () => {
			const r = routeMemoryWrite({
				userExplicit: false,
				workspaceScoped: false,
				threadOnly: false,
			}, NOW);
			assert.strictEqual(r.layer, 'short-term');
			assert.strictEqual(r.reason, 'fallback-no-explicit-scope');
		});

		test('explicit save with ttlHint still goes to explicit', () => {
			const r = routeMemoryWrite({
				userExplicit: true,
				workspaceScoped: true,
				threadOnly: false,
				ttlHintMs: 1000,
			}, NOW);
			assert.strictEqual(r.layer, 'explicit');
		});
	});

	suite('auditMemoryLayers', () => {
		test('empty input → no warnings', () => {
			assert.deepStrictEqual(auditMemoryLayers([]), []);
		});

		test('flags long-term entry without workspaceScoped', () => {
			const w = auditMemoryLayers([rec({ layer: 'long-term', workspaceScoped: false })]);
			assert.strictEqual(w.length, 1);
			assert.strictEqual(w[0].kind, 'long-term-without-workspace');
		});

		test('flags short-term entry with workspaceScoped', () => {
			const w = auditMemoryLayers([rec({ layer: 'short-term', workspaceScoped: true })]);
			assert.strictEqual(w.length, 1);
			assert.strictEqual(w[0].kind, 'short-term-with-workspace');
		});

		test('flags duplicate content across layers', () => {
			const w = auditMemoryLayers([
				rec({ id: 'a', layer: 'short-term', content: 'pick option A', workspaceScoped: false }),
				rec({ id: 'b', layer: 'long-term', content: 'pick option A' }),
			]);
			const dup = w.find(x => x.kind === 'duplicate-across-layers');
			assert.ok(dup, 'expected duplicate warning');
		});

		test('does NOT flag duplicate within same layer', () => {
			const w = auditMemoryLayers([
				rec({ id: 'a', layer: 'long-term', content: 'X', workspaceScoped: true }),
				rec({ id: 'b', layer: 'long-term', content: 'X', workspaceScoped: true }),
			]);
			assert.ok(!w.some(x => x.kind === 'duplicate-across-layers'));
		});

		test('content normalisation handles whitespace and case', () => {
			const w = auditMemoryLayers([
				rec({ id: 'a', layer: 'short-term', content: 'pick OPTION A', workspaceScoped: false }),
				rec({ id: 'b', layer: 'long-term', content: 'pick   option a' }),
			]);
			assert.ok(w.some(x => x.kind === 'duplicate-across-layers'));
		});

		test('happy path → no warnings', () => {
			const w = auditMemoryLayers([
				rec({ id: 'a', layer: 'long-term', content: 'X', workspaceScoped: true }),
				rec({ id: 'b', layer: 'short-term', content: 'Y', workspaceScoped: false }),
				rec({ id: 'c', layer: 'explicit', content: 'Z', workspaceScoped: false }),
			]);
			assert.deepStrictEqual(w, []);
		});
	});
});
