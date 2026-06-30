/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { buildRoute, classifyTask, needsSecurity } from '../../common/vibeAgentRoutes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Vibe Agents — orchestration routes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies by signal: review / bug / backend / frontend / full', () => {
		assert.deepStrictEqual(
			['сделай ревью кода', 'почини баг в форме', 'добавь api endpoint', 'свёрстай страницу', 'добавь фичу профиля'].map(classifyTask),
			['review', 'bug', 'backend', 'frontend', 'full-feature'],
		);
	});

	test('backend + frontend signals → full-feature', () => {
		assert.strictEqual(classifyTask('новый api и компонент интерфейса'), 'full-feature');
	});

	test('security-by-default fires on sensitive surfaces, not on plain tasks', () => {
		assert.strictEqual(needsSecurity('добавь oauth-логин'), true);
		assert.strictEqual(needsSecurity('обработка платежей картой'), true);
		assert.strictEqual(needsSecurity('поменяй цвет кнопки'), false);
	});

	test('buildRoute appends security only when triggered', () => {
		const plain = buildRoute('свёрстай лендинг');
		const sensitive = buildRoute('сделай страницу входа через oauth с токеном');
		assert.deepStrictEqual(
			{ plainHasSecurity: plain.roles.includes('security'), plainAdded: plain.securityAdded, sensitiveHasSecurity: sensitive.roles.includes('security'), sensitiveAdded: sensitive.securityAdded },
			{ plainHasSecurity: false, plainAdded: false, sensitiveHasSecurity: true, sensitiveAdded: true },
		);
	});

	test('route is ordered: planner first, qa last (for full-feature)', () => {
		const route = buildRoute('добавь фичу корзины с api и ui');
		assert.strictEqual(route.roles[0], 'planner');
		assert.strictEqual(route.roles[route.roles.length - 1], 'qa');
	});

	test('full-feature runs backend ∥ frontend in one parallel stage', () => {
		const route = buildRoute('добавь фичу корзины с api и ui');
		const parallel = route.stages.find(s => s.length > 1);
		assert.deepStrictEqual(parallel ? [...parallel].sort() : [], ['backend-dev', 'frontend-dev']);
	});
});
