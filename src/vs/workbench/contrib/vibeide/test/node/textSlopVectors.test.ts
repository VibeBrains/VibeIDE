/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Детектор нейрослопа — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/textSlop.json`).
 *
 * Каталог у продуктов один, а детекторов два, на Kotlin и на TypeScript. Проверенные каждый своим тестом, они
 * расходились бы молча; общий файл падает сразу у того продукта, который прочитал текст иначе. Каталог берётся
 * вшитый в сборку — тот, что едет пользователю. Файл читается через `fs`, поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SLOP_CATALOG_JSONC } from '../../common/slopCatalog.generated.js';
import { applySlopOverrides, compileSlopCatalog, CompiledSlopCatalog, parseSlopCatalog, parseSlopOverrides } from '../../common/textSlop/slopCatalog.js';
import { analyzeTextSlop } from '../../common/textSlop/textSlop.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в subscriptionQuotaVectors.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

/** Only the fields a case names are compared; the file's `_comment` spells out each of them. */
interface SlopExpectation {
	readonly passed?: boolean;
	readonly score?: number;
	readonly minScore?: number;
	readonly passScore?: number;
	readonly blocking?: readonly string[];
	readonly findings?: readonly string[];
	readonly has?: readonly string[];
	readonly lacks?: readonly string[];
	readonly matches?: Readonly<Record<string, readonly string[]>>;
	readonly density?: Readonly<Record<string, { readonly count?: number; readonly lines?: readonly number[] }>>;
	readonly deductions?: Readonly<Record<string, { readonly severity?: string; readonly count?: number; readonly points?: number }>>;
	readonly warnedAbout?: readonly string[];
}

interface SlopVector {
	readonly name: string;
	readonly text?: string;
	readonly lines?: readonly string[];
	readonly slopJson?: string;
	readonly expect: SlopExpectation;
}

/** The keys of `wanted` taken from `actual`: a case pins only what it names. */
function pick<T extends object>(actual: T | undefined, wanted: object): Partial<T> {
	const out: Partial<T> = {};
	for (const key of Object.keys(wanted) as (keyof T)[]) {
		out[key] = actual?.[key];
	}
	return out;
}

/** What the detector says about a case, in the shape of its expectation, so one comparison shows every mismatch. */
function observe(vector: SlopVector, catalog: CompiledSlopCatalog): SlopExpectation {
	const warnings: string[] = [];
	const project = vector.slopJson === undefined
		? catalog
		: applySlopOverrides(parseSlopOverrides(vector.slopJson, warning => warnings.push(warning)), catalog, warning => warnings.push(warning));
	const report = analyzeTextSlop(vector.text ?? (vector.lines ?? []).join('\n'), project);
	const found = new Set(report.findings.map(finding => finding.rule));
	const ofRule = (rule: string) => report.findings.filter(finding => finding.rule === rule);
	const expect = vector.expect;
	const perRule = <T>(wanted: Readonly<Record<string, unknown>> | undefined, value: (rule: string) => T) =>
		wanted && Object.fromEntries(Object.keys(wanted).map(rule => [rule, value(rule)]));
	const observed: { -readonly [K in keyof SlopExpectation]: SlopExpectation[K] } = {
		passed: report.passed,
		score: report.score,
		// The expected floor itself when it holds, the real score when it does not — a mismatch then names it.
		minScore: expect.minScore !== undefined && report.score >= expect.minScore ? expect.minScore : report.score,
		passScore: report.passScore,
		blocking: report.blocking,
		findings: report.findings.map(finding => `${finding.rule}:${finding.line}`),
		has: expect.has?.filter(rule => found.has(rule)),
		lacks: expect.lacks?.filter(rule => !found.has(rule)),
		matches: perRule(expect.matches, rule => ofRule(rule).map(finding => finding.match)),
		density: perRule(expect.density, rule => pick(ofRule(rule)[0]?.density, expect.density![rule])),
		deductions: perRule(expect.deductions, rule => pick(report.deductions.find(deduction => deduction.rule === rule), expect.deductions![rule])),
		// An empty list means "no warnings at all", so every warning shows up in a mismatch.
		warnedAbout: expect.warnedAbout?.length === 0 ? warnings : expect.warnedAbout?.filter(rule => warnings.some(warning => warning.includes(rule))),
	};
	return pick(observed, expect);
}

suite('textSlop — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: { readonly cases: readonly SlopVector[] } = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'textSlop.json'), 'utf8'));
	const shipped = parseSlopCatalog(SLOP_CATALOG_JSONC, () => { });

	test('каждый текст даёт те же находки и тот же счёт, что в VibeIDEA', () => {
		assert.ok(shipped, 'the shipped catalogue does not parse');
		const catalog = compileSlopCatalog(shipped, () => { });
		assert.deepStrictEqual(
			vectors.cases.map(vector => ({ name: vector.name, ...observe(vector, catalog) })),
			vectors.cases.map(vector => ({ name: vector.name, ...vector.expect })),
		);
	});
});
