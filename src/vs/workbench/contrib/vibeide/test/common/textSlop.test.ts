/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SLOP_CATALOG_JSONC } from '../../common/slopCatalog.generated.js';
import { compileSlopCatalog, CompiledSlopCatalog, parseSlopCatalog, SlopSeverity, unicodeClassesOf } from '../../common/textSlop/slopCatalog.js';
import { renderSlopReport } from '../../common/textSlop/slopRender.js';
import { analyzeTextSlop, SlopFinding, SlopReport } from '../../common/textSlop/textSlop.js';
import { VIBE_DEFAULTS_MANIFEST } from '../../common/vibeDefaultsManifest.generated.js';

/**
 * Детектор нейрослопа — то, что у VibeIDE своё: каталог, вшитый в сборку, общий навык набора, ответ модели и сервис.
 * Что детектор находит и как считает, проверяют общие с VibeIDEA векторы набора — `test/node/textSlopVectors.test.ts`:
 * две копии одних и тех же случаев разошлись бы молча.
 */
suite('textSlop — каталог сборки, навык набора и ответ модели', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const warnings: string[] = [];
	const parsed = parseSlopCatalog(SLOP_CATALOG_JSONC, warning => warnings.push(warning));
	const catalog: CompiledSlopCatalog = compileSlopCatalog(parsed!, warning => warnings.push(warning));
	const check = (text: string) => analyzeTextSlop(text, catalog);

	test('каталог сборки разбирается без единого предупреждения, id правил уникальны, есть обе части', () => {
		const rules = catalog.rules.map(compiled => compiled.rule);
		assert.deepStrictEqual({
			warnings,
			unique: new Set(rules.map(rule => rule.id.toUpperCase())).size === rules.length,
			languages: [rules.some(rule => rule.lang === 'ru'), rules.some(rule => rule.lang === 'en')],
		}, { warnings: [], unique: true, languages: [true, true] });
	});

	test('\\w, \\d и \\b видят все письменности, как в Java под UNICODE_CHARACTER_CLASS', () => {
		const find = (pattern: string, text: string) => text.match(new RegExp(unicodeClassesOf(pattern), 'giu')) ?? [];
		assert.deepStrictEqual({
			word: find('\\bсинерги\\w*', 'Наша синергия и синергии.'),
			wholeWordOnly: find('\\bрост\\b', 'проросток и рост'),
			wordInClass: find('[\\w-]+', 'по-русски!'),
			digits: find('\\d+', 'стр. ٣٤ и 12'),
			notBoundary: find('ер\\B', 'сервер верный'),
			// `[\b]` is a backspace, `\\b` a backslash and a letter: neither is a boundary to rewrite.
			untouched: [unicodeClassesOf('[\\b]'), unicodeClassesOf('\\\\b')],
		}, {
			word: ['синергия', 'синергии'],
			wholeWordOnly: ['рост'],
			wordInClass: ['по-русски'],
			digits: ['٣٤', '12'],
			notBoundary: ['ер', 'ер'],
			untouched: ['[\\b]', '\\\\b'],
		});
	});

	test('общий навык anti-slop проходит собственный детектор, ничего тяжелее пометки', () => {
		for (const name of ['SKILL.md', 'references/reviewer.md', 'references/voice.md']) {
			const file = VIBE_DEFAULTS_MANIFEST.find(entry => entry.path === `skills/anti-slop/${name}`);
			assert.ok(file, `skills/anti-slop/${name} is not in the seed manifest`);
			const report = check(file.contents);
			assert.deepStrictEqual(
				{ passed: report.passed, heavy: report.findings.filter(finding => finding.severity !== 'note').map(finding => `${finding.rule}:${finding.line}`) },
				{ passed: true, heavy: [] },
				name,
			);
		}
	});

	test('ответ модели: вердикт, запрет, находки от тяжёлой к лёгкой, хвост и предупреждения', () => {
		const finding = (rule: string, severity: SlopSeverity, line: number, over: Partial<SlopFinding> = {}): SlopFinding =>
			({ rule, name: `имя ${rule}`, severity, line, column: 1, start: 0, end: 0, match: 'кусок', fix: 'исправить', ...over });
		const report: SlopReport = {
			score: 72.5, passed: false, passScore: 90, maxSeverity: 'minor', blocking: ['B1'], words: 100, deductions: [],
			findings: [
				finding('N1', 'note', 1),
				finding('D1', 'minor', 3, { density: { count: 4, perThousand: 12.25, lines: [3, 5] } }),
				// A project's own rule may come without a fix: no arrow pointing at nothing.
				finding('B1', 'major', 7, { fix: '' }),
			],
		};
		assert.deepStrictEqual(renderSlopReport(report, ['slop.json: правило X не собрано'], 2).split('\n'), [
			'Нейрослоп: 72.5/100 (проход — от 90), не проходит, находок: 3',
			'Не пропускают: B1',
			'- строка 7:1 [B1] имя B1 (major): «кусок»',
			'- строка 3:1 [D1] имя D1 (minor): 4 раз, 12.3 на 1000 слов, строки 3, 5 → исправить',
			'…и ещё 1',
			'Предупреждения: slop.json: правило X не собрано',
		]);
	});
});
