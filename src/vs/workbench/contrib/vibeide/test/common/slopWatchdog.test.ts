/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { checkWithinBudget, SlopRunner } from '../../common/textSlop/slopWatchdog.js';
import { compileShippedSlopCatalog, runSlopRequest, SlopWorkerRequest } from '../../common/textSlop/textSlopWorker.js';

/**
 * Проверка нейрослопа, которую не повесит правило проекта
 *
 * Регулярку из `.vibe/slop.json` на её потоке не прервать, поэтому исполнитель отвечает «не уложилась», а распорядитель
 * решает, что проверять дальше. Здесь исполнитель подставной: «зависает» любой запрос, где есть правило HANG
 */
suite('slopWatchdog — правило проекта не вешает проверку', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const reply = (label: string) => ({ reports: [], warnings: [label] });
	const hangingRunner = (hanging: readonly string[], shippedHangs = false): { runner: SlopRunner; asked: string[] } => {
		const asked: string[] = [];
		const runner: SlopRunner = async (request: SlopWorkerRequest) => {
			const label = request.only ? `only:${request.only}` : request.overrides === undefined ? 'shipped' : request.exclude ? `without:${request.exclude.join('+')}` : 'full';
			asked.push(label);
			const rulesInPlay = request.overrides === undefined ? [] : request.only ? [request.only] : ['HANG', 'SLOW', 'OK'].filter(id => !(request.exclude ?? []).includes(id));
			const hangs = rulesInPlay.some(id => hanging.includes(id)) || (request.overrides === undefined && shippedHangs);
			return hangs ? 'timeout' : reply(label);
		};
		return { runner, asked };
	};
	const request: SlopWorkerRequest = { texts: ['текст'], overrides: '{}' };

	test('виновное правило найдено поштучно, остальные правила проекта продолжают считаться', async () => {
		const quiet = hangingRunner([]);
		const oneBad = hangingRunner(['HANG']);
		const shippedToo = hangingRunner(['HANG'], true);
		const outcomes = [
			await checkWithinBudget(quiet.runner, request, ['HANG', 'SLOW', 'OK'], 20),
			await checkWithinBudget(oneBad.runner, request, ['HANG', 'SLOW', 'OK'], 20),
			await checkWithinBudget(shippedToo.runner, request, ['HANG', 'SLOW', 'OK'], 20),
		];
		assert.deepStrictEqual({
			asked: [quiet.asked, oneBad.asked, shippedToo.asked],
			skipped: outcomes.map(o => o.skippedRules),
			checked: outcomes.map(o => o.reports !== undefined),
			lastWarning: outcomes.map(o => o.warnings[o.warnings.length - 1]),
		}, {
			asked: [
				['full'],
				['full', 'shipped', 'only:HANG', 'only:SLOW', 'only:OK', 'without:HANG'],
				['full', 'shipped'],
			],
			skipped: [[], ['HANG'], []],
			checked: [true, true, false],
			lastWarning: [
				'full',
				'Правила HANG из .vibe/slop.json не уложились в 20 с на этом тексте (вероятно, катастрофический возврат в регулярке) — проверено без них',
				'Проверка нейрослопа не уложилась в 20 с даже без правил проекта — текст не проверен',
			],
		});
	});

	test('запрос воркера: одно правило проекта отдельно, без виновного и только короткие правила страницы', () => {
		const shipped = compileShippedSlopCatalog();
		const overrides = JSON.stringify({ rules: [{ id: 'P-BUILD', lang: 'ru', kind: 'regex', severity: 'minor', name: 'сборка', patterns: ['\\bсборк\\w*'] }] });
		const text = 'Стоит отметить, что сборка занимает две минуты.';
		const rulesOf = (req: SlopWorkerRequest) => runSlopRequest(req, shipped).reports?.[0].findings.map(f => f.rule);
		assert.deepStrictEqual({
			full: rulesOf({ texts: [text], overrides }),
			only: rulesOf({ texts: [text], overrides, only: 'P-BUILD' }),
			without: rulesOf({ texts: [text], overrides, exclude: ['P-BUILD'] }),
		}, {
			full: ['RU-W2', 'P-BUILD'],
			only: ['P-BUILD'],
			without: ['RU-W2'],
		});
	});
});
