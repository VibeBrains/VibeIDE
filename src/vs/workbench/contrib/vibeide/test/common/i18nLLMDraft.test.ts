/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	selectKeysForLLMDraft,
	buildI18nDraftRequest,
	parseI18nDraftResponse,
	applyI18nDraftMarkers,
	I18N_LLM_DRAFT_PREFIX,
	I18N_LLM_NEEDS_TRANSLATION_PREFIX,
} from '../../common/i18nLLMDraft.js';

suite('i18n LLM-assisted draft helpers — pure', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('selectKeysForLLMDraft', () => {
		test('selects missing key', () => {
			const r = selectKeysForLLMDraft(
				new Map([['greet', 'Hello']]),
				new Map(),
			);
			assert.deepStrictEqual(r, [{ key: 'greet', englishSource: 'Hello' }]);
		});

		test('selects empty translation', () => {
			const r = selectKeysForLLMDraft(
				new Map([['greet', 'Hello']]),
				new Map([['greet', '']]),
			);
			assert.strictEqual(r.length, 1);
		});

		test('selects [NEEDS_TRANSLATION] marker', () => {
			const r = selectKeysForLLMDraft(
				new Map([['greet', 'Hello']]),
				new Map([['greet', '[NEEDS_TRANSLATION] Hello']]),
			);
			assert.strictEqual(r.length, 1);
		});

		test('skips already-translated', () => {
			const r = selectKeysForLLMDraft(
				new Map([['greet', 'Hello']]),
				new Map([['greet', 'Привет']]),
			);
			assert.deepStrictEqual(r, []);
		});

		test('skips already-drafted [DRAFT_LLM]', () => {
			const r = selectKeysForLLMDraft(
				new Map([['greet', 'Hello']]),
				new Map([['greet', '[DRAFT_LLM] Привет']]),
			);
			assert.deepStrictEqual(r, []);
		});

		test('deterministic sort by key', () => {
			const r = selectKeysForLLMDraft(
				new Map([['z', 'Z'], ['a', 'A'], ['m', 'M']]),
				new Map(),
			);
			assert.deepStrictEqual(r.map(c => c.key), ['a', 'm', 'z']);
		});

		test('exported prefixes', () => {
			assert.strictEqual(I18N_LLM_DRAFT_PREFIX, '[DRAFT_LLM]');
			assert.strictEqual(I18N_LLM_NEEDS_TRANSLATION_PREFIX, '[NEEDS_TRANSLATION]');
		});
	});

	suite('buildI18nDraftRequest', () => {
		test('happy path → systemPrompt + userPrompt + JSON instruction', () => {
			const r = buildI18nDraftRequest({
				candidates: [{ key: 'greet', englishSource: 'Hello {0}' }],
				targetLocaleTag: 'ru',
				targetLocaleName: 'Russian',
				model: 'qwen2.5-coder',
			});
			assert.ok(r.systemPrompt.includes('Russian'));
			assert.ok(r.systemPrompt.includes('Preserve all placeholders'));
			assert.ok(r.userPrompt.includes('greet'));
			assert.ok(r.userPrompt.includes('Hello {0}'));
			assert.ok(r.userPrompt.includes('JSON array'));
			assert.strictEqual(r.model, 'qwen2.5-coder');
			assert.strictEqual(r.batchSize, 25);
		});

		test('respects custom batchSize, clamped to [1,100]', () => {
			const r1 = buildI18nDraftRequest({
				candidates: [{ key: 'a', englishSource: 'A' }],
				targetLocaleTag: 'ru',
				targetLocaleName: 'Russian',
				model: 'm',
				batchSize: 5,
			});
			assert.strictEqual(r1.batchSize, 5);

			const r0 = buildI18nDraftRequest({
				candidates: [{ key: 'a', englishSource: 'A' }],
				targetLocaleTag: 'ru',
				targetLocaleName: 'Russian',
				model: 'm',
				batchSize: 0,
			});
			assert.strictEqual(r0.batchSize, 1);

			const rOver = buildI18nDraftRequest({
				candidates: [{ key: 'a', englishSource: 'A' }],
				targetLocaleTag: 'ru',
				targetLocaleName: 'Russian',
				model: 'm',
				batchSize: 5_000,
			});
			assert.strictEqual(rOver.batchSize, 100);
		});

		test('only includes first `batchSize` candidates', () => {
			const r = buildI18nDraftRequest({
				candidates: [
					{ key: 'a', englishSource: 'A' },
					{ key: 'b', englishSource: 'B' },
					{ key: 'c', englishSource: 'C' },
				],
				targetLocaleTag: 'ru',
				targetLocaleName: 'Russian',
				model: 'm',
				batchSize: 2,
			});
			assert.ok(r.userPrompt.includes('a'));
			assert.ok(r.userPrompt.includes('b'));
			assert.ok(!r.userPrompt.includes('"C"'));
		});
	});

	suite('parseI18nDraftResponse', () => {
		test('happy path JSON array', () => {
			const r = parseI18nDraftResponse(
				'[{"key":"greet","translation":"Привет"}]',
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'ok');
			if (r.kind === 'ok') { assert.strictEqual(r.drafts.get('greet'), 'Привет'); }
		});

		test('extracts JSON from prose-wrapped response', () => {
			const r = parseI18nDraftResponse(
				`Here are the translations:\n[{"key":"greet","translation":"Привет"}]\nLet me know if more help needed!`,
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'ok');
		});

		test('invalid JSON → invalid-json verdict', () => {
			const r = parseI18nDraftResponse(
				'[{"key":"greet","translation":,}]', // syntax error
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'invalid-json');
		});

		test('non-array root → shape-mismatch:root-not-array', () => {
			const r = parseI18nDraftResponse('[true]', new Set(['greet']));
			assert.strictEqual(r.kind, 'shape-mismatch');
		});

		test('item missing key → shape-mismatch', () => {
			const r = parseI18nDraftResponse(
				'[{"translation":"Привет"}]',
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'shape-mismatch');
			if (r.kind === 'shape-mismatch') { assert.ok(r.reason.includes('key-missing')); }
		});

		test('item missing translation → shape-mismatch', () => {
			const r = parseI18nDraftResponse(
				'[{"key":"greet"}]',
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'shape-mismatch');
		});

		test('hallucinated key (not in expected set) → shape-mismatch', () => {
			const r = parseI18nDraftResponse(
				'[{"key":"made_up","translation":"x"}]',
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'shape-mismatch');
			if (r.kind === 'shape-mismatch') { assert.ok(r.reason.includes('hallucinated-key')); }
		});

		test('extra unknown fields tolerated', () => {
			const r = parseI18nDraftResponse(
				'[{"key":"greet","translation":"Привет","confidence":0.9}]',
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'ok');
		});

		test('no JSON found → invalid-json with preview', () => {
			const r = parseI18nDraftResponse('I cannot translate this.', new Set());
			assert.strictEqual(r.kind, 'invalid-json');
			if (r.kind === 'invalid-json') { assert.ok(r.preview.length > 0); }
		});

		test('empty translation kept (caller decides)', () => {
			const r = parseI18nDraftResponse(
				'[{"key":"greet","translation":""}]',
				new Set(['greet']),
			);
			assert.strictEqual(r.kind, 'ok');
			if (r.kind === 'ok') { assert.strictEqual(r.drafts.get('greet'), ''); }
		});
	});

	suite('applyI18nDraftMarkers', () => {
		test('prefixes drafts with [DRAFT_LLM]', () => {
			const { next } = applyI18nDraftMarkers(
				new Map([['greet', '[NEEDS_TRANSLATION] Hello']]),
				new Map([['greet', 'Привет']]),
			);
			assert.strictEqual(next.get('greet'), '[DRAFT_LLM] Привет');
		});

		test('drops empty drafts', () => {
			const r = applyI18nDraftMarkers(
				new Map([['greet', 'Hello']]),
				new Map([['greet', '   ']]),
			);
			assert.deepStrictEqual(r.dropped, ['greet']);
			assert.strictEqual(r.next.get('greet'), 'Hello');
		});

		test('non-mutating', () => {
			const orig = new Map([['greet', 'Hello']]);
			applyI18nDraftMarkers(orig, new Map([['greet', 'Привет']]));
			assert.strictEqual(orig.get('greet'), 'Hello');
		});

		test('preserves untouched keys', () => {
			const r = applyI18nDraftMarkers(
				new Map([['a', 'X'], ['b', 'Y']]),
				new Map([['a', 'X-translated']]),
			);
			assert.strictEqual(r.next.get('a'), '[DRAFT_LLM] X-translated');
			assert.strictEqual(r.next.get('b'), 'Y');
		});

		test('trims whitespace before adding marker', () => {
			const r = applyI18nDraftMarkers(
				new Map([['a', 'X']]),
				new Map([['a', '  Привет  ']]),
			);
			assert.strictEqual(r.next.get('a'), '[DRAFT_LLM] Привет');
		});
	});
});
