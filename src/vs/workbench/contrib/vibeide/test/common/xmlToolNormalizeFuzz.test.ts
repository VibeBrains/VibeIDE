/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * X.3 / X.15.9 — deterministic property-based fuzz tests for the XML
 * normalizer. Uses a seeded PRNG (Mulberry32) so failures are reproducible
 * without depending on `fast-check` or any other external fuzzer.
 *
 * Properties verified across 200 random inputs:
 *  1. **Idempotency**: `normalize(normalize(x)) === normalize(x)` always.
 *  2. **No-explosion**: `output.length <= input.length * 10` (guards against
 *     exponential blowup on adversarial input).
 *  3. **No-throw**: never throws, always returns a string.
 *  4. **Safety-net stability**: `stripUnclaimedToolTags` is idempotent too.
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	normalizeAlternativeToolSyntax,
	stripUnclaimedToolTags,
} from '../../common/xmlToolNormalize.js';

// Mulberry32 — small fast PRNG with explicit seed for reproducibility.
const makeRng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6D2B79F5) | 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Building blocks drawn from real observed formats. The generator picks
// from these + adds random noise (prose, malformed bits, fullwidth pipes)
// to exercise edge cases.
const TOOL_NAMES = ['read_file', 'write_file_text', 'edit_file', 'run_terminal_command', 'search_for_files', 'list_dir'];
const PARAM_NAMES = ['path', 'uri', 'contents', 'query', 'command', 'нестандарт', '路径'];
const ATTR_VALUES = ['/foo.ts', 'd:\\Projects\\app', 'echo "hi"', 'multi\nline', 'quotes "in" value', ''];
const PROSE = ['Reading file. ', 'Let me check. ', '<br />', '5 < 10', 'plain text ', '\n\n', ''];
const WRAPPERS = ['tool_calls', 'function_calls'];

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

const genFragment = (rng: () => number): string => {
	const kind = Math.floor(rng() * 9);
	const tool = pick(rng, TOOL_NAMES);
	const param = pick(rng, PARAM_NAMES);
	const value = pick(rng, ATTR_VALUES);
	switch (kind) {
		case 0:
			// Canonical block
			return `<${tool}><${param}>${value}</${param}></${tool}>`;
		case 1:
			// Invoke form
			return `<invoke name="${tool}"><parameter name="${param}">${value}</parameter></invoke>`;
		case 2:
			// Self-closing
			return `<${tool} ${param}="${value}" />`;
		case 3: {
			// DSML wrapper
			return `<｜｜DSML｜｜invoke name="${tool}"><｜｜DSML｜｜parameter name="${param}">${value}</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>`;
		}
		case 4: {
			// Outer wrapper + invoke
			const w = pick(rng, WRAPPERS);
			return `<${w}><invoke name="${tool}"><parameter name="${param}">${value}</parameter></invoke></${w}>`;
		}
		case 5:
			// Malformed close (missing `>`)
			return `<tool_calls<invoke name="${tool}"><parameter name="${param}">${value}</parameter></invoke</tool_calls`;
		case 6:
			// Self-closing invoke combo
			return `<invoke name="${tool}" ${param}="${value}" />`;
		case 7:
			// Truncated vendor wrapper (deepseek-v4-pro via openCodeGo, model-stalls #008):
			// `<tool_calls` cut to `<tool_c`, `</invoke` cut to `</inv`. Exercises the O.12
			// vendor-leak scrub through the existing no-throw / idempotency / no-explosion props.
			return `<tool_c <invoke name="${tool}"><parameter name="${param}">${value}</parameter> </inv </tool_c`;
		case 8:
		default:
			// Plain prose with no tools
			return pick(rng, PROSE);
	}
};

const genInput = (rng: () => number): string => {
	const segments = 1 + Math.floor(rng() * 5);
	let out = '';
	for (let i = 0; i < segments; i += 1) {
		out += pick(rng, PROSE) + genFragment(rng);
	}
	return out + pick(rng, PROSE);
};

const SEEDS = [1, 7, 42, 100, 2025, 12345, 99999, 314159, 271828, 666];
const ITERATIONS_PER_SEED = 20;
const MAX_EXPLOSION_RATIO = 10;

suite('XML normalize — fuzz / property tests (X.3 / X.15.9)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalize: never throws across 200 random inputs', () => {
		for (const seed of SEEDS) {
			const rng = makeRng(seed);
			for (let i = 0; i < ITERATIONS_PER_SEED; i += 1) {
				const input = genInput(rng);
				const result = normalizeAlternativeToolSyntax(input);
				assert.strictEqual(typeof result, 'string', `seed=${seed} i=${i} input=${input}`);
			}
		}
	});

	test('normalize: idempotency holds across 200 random inputs', () => {
		for (const seed of SEEDS) {
			const rng = makeRng(seed);
			for (let i = 0; i < ITERATIONS_PER_SEED; i += 1) {
				const input = genInput(rng);
				const once = normalizeAlternativeToolSyntax(input);
				const twice = normalizeAlternativeToolSyntax(once);
				assert.strictEqual(twice, once, `idempotency violation seed=${seed} i=${i} input=${input}`);
			}
		}
	});

	test('normalize: output length <= 10× input length (no-explosion)', () => {
		for (const seed of SEEDS) {
			const rng = makeRng(seed);
			for (let i = 0; i < ITERATIONS_PER_SEED; i += 1) {
				const input = genInput(rng);
				const out = normalizeAlternativeToolSyntax(input);
				assert.ok(
					out.length <= Math.max(input.length, 64) * MAX_EXPLOSION_RATIO,
					`explosion: seed=${seed} i=${i} in=${input.length} out=${out.length}`,
				);
			}
		}
	});

	test('stripUnclaimedToolTags: never throws', () => {
		for (const seed of SEEDS) {
			const rng = makeRng(seed);
			for (let i = 0; i < ITERATIONS_PER_SEED; i += 1) {
				const input = genInput(rng);
				const result = stripUnclaimedToolTags(input);
				assert.strictEqual(typeof result, 'string', `seed=${seed} i=${i}`);
			}
		}
	});

	test('stripUnclaimedToolTags: idempotency', () => {
		for (const seed of SEEDS) {
			const rng = makeRng(seed);
			for (let i = 0; i < ITERATIONS_PER_SEED; i += 1) {
				const input = genInput(rng);
				const once = stripUnclaimedToolTags(input);
				const twice = stripUnclaimedToolTags(once);
				assert.strictEqual(twice, once, `safety net idempotency seed=${seed} i=${i}`);
			}
		}
	});

	test('normalize + stripUnclaimed pipeline: no-throw composition', () => {
		// In production, normalize runs then any leak goes through safety net.
		// Compose them in fuzz to catch interaction bugs (e.g. normalize emits
		// something that crashes the safety net).
		for (const seed of SEEDS) {
			const rng = makeRng(seed);
			for (let i = 0; i < ITERATIONS_PER_SEED; i += 1) {
				const input = genInput(rng);
				const normalized = normalizeAlternativeToolSyntax(input);
				const stripped = stripUnclaimedToolTags(normalized);
				assert.strictEqual(typeof stripped, 'string');
			}
		}
	});
});
