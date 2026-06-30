/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	matchQuirks,
	validateCatalog,
	applyUserOverride,
	EMPTY_QUIRKS,
	ModelQuirksRule,
	ModelQuirksCatalog,
	ResolvedModelQuirks,
} from '../../common/modelQuirks/modelQuirksTypes.js';

suite('ModelQuirks — matchQuirks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();


	const rules: ModelQuirksRule[] = [
		{ match: 'kimi-k2.6', temperature: 1.0, topP: 0.95, mirrorReasoningContent: true },
		{ match: 'kimi-k2', temperature: 0.6 },
		{ match: 'kimi', temperature: 1.0 },
		{ match: 'deepseek', forceEmptyReasoning: true, mirrorReasoningContent: true },
		{ match: 'qwen', temperature: 0.55, topP: 1.0, forceToolCallFormat: 'xml' },
	];

	test('exact prefix wins over family fallback (most-specific field-merge)', () => {
		const q = matchQuirks(rules, 'kimi-k2.6');
		assert.strictEqual(q?.temperature, 1.0);
		assert.strictEqual(q?.topP, 0.95);
		assert.strictEqual(q?.mirrorReasoningContent, true);
	});

	test('legacy kimi-k2 (without version) gets the second rule, not the broad "kimi"', () => {
		const q = matchQuirks(rules, 'kimi-k2');
		assert.strictEqual(q?.temperature, 0.6);
		assert.strictEqual(q?.topP, undefined);
	});

	test('future kimi version falls through to broad "kimi" family rule', () => {
		const q = matchQuirks(rules, 'kimi-k99-future');
		assert.strictEqual(q?.temperature, 1.0);
	});

	test('case-insensitive — model id with uppercase matches lowercase pattern', () => {
		const q = matchQuirks(rules, 'DeepSeek-V4-pro');
		assert.strictEqual(q?.forceEmptyReasoning, true);
	});

	test('no match → null', () => {
		const q = matchQuirks(rules, 'gpt-5-future-unrelated');
		assert.strictEqual(q, null);
	});

	test('empty model id → null', () => {
		assert.strictEqual(matchQuirks(rules, ''), null);
		assert.strictEqual(matchQuirks(rules, null as unknown as string), null);
	});

	test('match field stripped from returned quirks', () => {
		const q = matchQuirks(rules, 'qwen3.6-plus');
		assert.ok(q);
		assert.ok(!Object.hasOwn(q, 'match'));
		assert.ok(!Object.hasOwn(q, 'note'));
		assert.strictEqual(q?.forceToolCallFormat, 'xml');
	});
});

suite('ModelQuirks — matchQuirks per-provider', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const rules: ModelQuirksRule[] = [
		// Provider-scoped rule for kimi via openCodeGo goes BEFORE unscoped kimi rule.
		{ match: 'kimi', provider: 'openCodeGo', forceToolCallFormat: 'xml', temperature: 1.0 },
		{ match: 'kimi', temperature: 0.6 },
	];

	test('provider-scoped rule wins when provider matches', () => {
		const q = matchQuirks(rules, 'kimi-k2.6', 'openCodeGo');
		assert.strictEqual(q?.forceToolCallFormat, 'xml');
		assert.strictEqual(q?.temperature, 1.0);
	});

	test('unscoped rule wins when provider differs', () => {
		const q = matchQuirks(rules, 'kimi-k2.6', 'directMoonshot');
		assert.strictEqual(q?.forceToolCallFormat, undefined);
		assert.strictEqual(q?.temperature, 0.6);
	});

	test('unscoped rule wins when providerName omitted (backward compat)', () => {
		const q = matchQuirks(rules, 'kimi-k2.6');
		// First rule is provider-scoped — skipped because no providerName given.
		// Falls through to unscoped rule.
		assert.strictEqual(q?.temperature, 0.6);
	});

	test('provider match is case-insensitive substring', () => {
		// Match direction: the supplied provider must CONTAIN the rule's provider
		// ('opencodego'), case-insensitively.
		const q1 = matchQuirks(rules, 'kimi-k2.6', 'OPENCODEGO');
		const q2 = matchQuirks(rules, 'kimi-k2.6', 'opencodego-zen');
		assert.strictEqual(q1?.forceToolCallFormat, 'xml');
		assert.strictEqual(q2?.forceToolCallFormat, 'xml');
	});

	test('provider field stripped from returned quirks', () => {
		const q = matchQuirks(rules, 'kimi-k2.6', 'openCodeGo');
		assert.ok(q);
		assert.ok(!Object.hasOwn(q, 'provider'));
	});

	test('field-merge: provider rule (toolFormat) + family rule (reasoning) BOTH apply (model-stalls #009)', () => {
		// Repro of the shadowing bug: a broad family rule sets the reasoning quirks; the provider-scoped
		// rule (placed AFTER it, broad `match`) sets the tool format. Old first-match-wins returned ONE
		// rule and dropped the other dimension. Merge must combine both — exactly how the minimax+openCodeGo
		// "Empty response / Calling: read_file as text" symptom is fixed.
		const mergeRules: ModelQuirksRule[] = [
			{ match: 'minimax-m2', temperature: 1.0, topK: 40, forceEmptyReasoning: true, mirrorReasoningContent: true },
			{ match: 'minimax', provider: 'openCodeGo', forceToolCallFormat: 'xml' },
		];
		const q = matchQuirks(mergeRules, 'minimax-m2.7', 'openCodeGo');
		assert.strictEqual(q?.forceToolCallFormat, 'xml');     // from provider-scoped rule
		assert.strictEqual(q?.forceEmptyReasoning, true);      // from family rule (lost under old first-match)
		assert.strictEqual(q?.mirrorReasoningContent, true);   // from family rule
		assert.strictEqual(q?.temperature, 1.0);               // from family rule
		assert.strictEqual(q?.topK, 40);                       // from family rule
	});

	test('field-merge: most-specific match wins on field conflict', () => {
		const mergeRules: ModelQuirksRule[] = [
			{ match: 'minimax', topK: 40 },
			{ match: 'minimax-m2', topK: 20 }, // longer match = more specific → wins for base m2
		];
		assert.strictEqual(matchQuirks(mergeRules, 'minimax-m2')?.topK, 20);
		assert.strictEqual(matchQuirks(mergeRules, 'minimax-other')?.topK, 40); // only broad rule matches
	});
});

suite('ModelQuirks — validateCatalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('valid catalog parses', () => {
		const raw = { version: 1, rules: [{ match: 'foo', temperature: 0.5 }] };
		const cat = validateCatalog(raw);
		assert.strictEqual(cat.version, 1);
		assert.strictEqual(cat.rules.length, 1);
		assert.strictEqual(cat.rules[0].match, 'foo');
		assert.strictEqual(cat.rules[0].temperature, 0.5);
	});

	test('missing version → throws', () => {
		assert.throws(() => validateCatalog({ rules: [] }), /version/);
	});

	test('non-object root → throws', () => {
		assert.throws(() => validateCatalog('not-an-object'), /not an object/);
		assert.throws(() => validateCatalog(null), /not an object/);
	});

	test('non-array rules → throws', () => {
		assert.throws(() => validateCatalog({ version: 1, rules: 'oops' }), /not an array/);
	});

	test('malformed rule (no match field) — skipped, NOT thrown', () => {
		const cat = validateCatalog({
			version: 1,
			rules: [
				{ temperature: 0.5 },             // no match — drop
				{ match: 'ok', temperature: 0.7 },
				{ match: 123 },                    // match not a string — drop
			],
		});
		assert.strictEqual(cat.rules.length, 1);
		assert.strictEqual(cat.rules[0].match, 'ok');
	});

	test('out-of-range numeric fields dropped (forward compat with sane defaults)', () => {
		const cat = validateCatalog({
			version: 1,
			rules: [
				{ match: 'a', temperature: -1, topP: 1.5, topK: -5 },
			],
		});
		assert.strictEqual(cat.rules[0].match, 'a');
		assert.strictEqual(cat.rules[0].temperature, undefined);
		assert.strictEqual(cat.rules[0].topP, undefined);
		assert.strictEqual(cat.rules[0].topK, undefined);
	});

	test('unknown rule fields silently ignored (forward compat)', () => {
		const cat = validateCatalog({
			version: 1,
			rules: [
				{ match: 'a', temperature: 0.5, futureField: 'whatever', anotherUnknown: 42 },
			],
		});
		assert.strictEqual(cat.rules[0].match, 'a');
		assert.strictEqual(cat.rules[0].temperature, 0.5);
		assert.strictEqual((cat.rules[0] as unknown as Record<string, unknown>).futureField, undefined);
	});

	test('forceToolCallFormat enum validation', () => {
		const cat = validateCatalog({
			version: 1,
			rules: [
				{ match: 'a', forceToolCallFormat: 'xml' },
				{ match: 'b', forceToolCallFormat: 'invalid-value' },
			],
		});
		assert.strictEqual(cat.rules[0].forceToolCallFormat, 'xml');
		assert.strictEqual(cat.rules[1].forceToolCallFormat, undefined);
	});

	test('forcedToolChoiceUnsupported bool validation', () => {
		const cat = validateCatalog({
			version: 1,
			rules: [
				{ match: 'a', forcedToolChoiceUnsupported: true },
				{ match: 'b', forcedToolChoiceUnsupported: 'yes' }, // non-bool → drop
			],
		});
		assert.strictEqual(cat.rules[0].forcedToolChoiceUnsupported, true);
		assert.strictEqual(cat.rules[1].forcedToolChoiceUnsupported, undefined);
	});
});

suite('ModelQuirks — applyUserOverride', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('user fields override catalog per-field', () => {
		const catalog = { temperature: 1.0, topP: 0.95, topK: 40 };
		const user = { temperature: 0.7 };
		const merged = applyUserOverride(catalog, user);
		assert.strictEqual(merged.temperature, 0.7);
		assert.strictEqual(merged.topP, 0.95);
		assert.strictEqual(merged.topK, 40);
	});

	test('null / undefined override → catalog unchanged', () => {
		const catalog = { temperature: 1.0 };
		assert.deepStrictEqual(applyUserOverride(catalog, null), catalog);
		assert.deepStrictEqual(applyUserOverride(catalog, undefined), catalog);
	});

	test('invalid user override value → catalog field preserved', () => {
		const catalog = { temperature: 1.0 };
		const user = { temperature: 'not-a-number' };
		const merged = applyUserOverride(catalog, user);
		assert.strictEqual(merged.temperature, 1.0);
	});

	test('user override on empty catalog → just user fields', () => {
		const merged = applyUserOverride(EMPTY_QUIRKS, { topP: 0.9 });
		assert.strictEqual(merged.topP, 0.9);
	});

	test('user override with topK fractional → dropped (must be integer)', () => {
		const catalog: ReturnType<typeof applyUserOverride> = {};
		const merged = applyUserOverride(catalog, { topK: 3.5 });
		assert.strictEqual(merged.topK, undefined);
	});

	test('forceToolCallFormat user override — enum check', () => {
		const catalog = {};
		assert.strictEqual(applyUserOverride(catalog, { forceToolCallFormat: 'xml' }).forceToolCallFormat, 'xml');
		assert.strictEqual(applyUserOverride(catalog, { forceToolCallFormat: 'bogus' }).forceToolCallFormat, undefined);
	});
});

suite('ModelQuirks — end-to-end integration via bundled rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Verify the actual rules in resources/model-quirks.json work as expected.
	// Re-construct the rule list here (kept in sync with the JSON catalog).
	const bundled: ModelQuirksCatalog = {
		version: 1,
		rules: [
			{ match: 'kimi-k2.6', temperature: 1.0, topP: 0.95, mirrorReasoningContent: true },
			{ match: 'kimi-k2.5', temperature: 1.0, topP: 0.95, mirrorReasoningContent: true },
			{ match: 'kimi-k2-thinking', temperature: 1.0, topP: 0.95, mirrorReasoningContent: true },
			{ match: 'kimi-k2', temperature: 0.6 },
			{ match: 'kimi', temperature: 1.0, topP: 0.95 },
			{ match: 'minimax-m2.7', temperature: 1.0, topP: 0.95, topK: 40 },
			{ match: 'minimax-m2.5', temperature: 1.0, topP: 0.95, topK: 40 },
			{ match: 'minimax-m2', temperature: 1.0, topP: 0.95, topK: 20 },
			{ match: 'minimax', temperature: 1.0, topP: 0.95, topK: 40 },
			{ match: 'deepseek', forceEmptyReasoning: true, mirrorReasoningContent: true },
			{ match: 'qwen', temperature: 0.55, topP: 1.0, forceToolCallFormat: 'xml' },
			{ match: 'glm', temperature: 1.0 },
			{ match: 'gemini', temperature: 1.0, topP: 0.95, topK: 64 },
		],
	};

	const cases: Array<[string, ResolvedModelQuirks | null]> = [
		['qwen3.6-plus', { temperature: 0.55, topP: 1.0, forceToolCallFormat: 'xml' }],
		['deepseek-v4-pro', { forceEmptyReasoning: true, mirrorReasoningContent: true }],
		['kimi-k2.6', { temperature: 1.0, topP: 0.95, mirrorReasoningContent: true }],
		['minimax-m2.7', { temperature: 1.0, topP: 0.95, topK: 40 }],
		['glm-5.1', { temperature: 1.0 }],
		['mimo-v2-pro', null],   // no match — provider defaults
		['hy3-preview', null],   // no match — provider defaults
	];

	for (const [modelId, expected] of cases) {
		test(`${modelId} → expected quirks`, () => {
			const q = matchQuirks(bundled.rules, modelId);
			if (expected === null) {
				assert.strictEqual(q, null);
				return;
			}
			assert.ok(q, `expected match for ${modelId}`);
			const resolved: Record<string, unknown> = q;
			for (const [k, v] of Object.entries(expected)) {
				assert.strictEqual(resolved[k], v, `field ${k} mismatch for ${modelId}`);
			}
		});
	}
});
