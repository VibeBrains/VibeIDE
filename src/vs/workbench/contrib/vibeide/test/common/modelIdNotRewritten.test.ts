/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { matchQuirks, ModelQuirksRule } from '../../common/modelQuirks/modelQuirksTypes.js';

/**
 * Страж: каталог квирков НАСТРАИВАЕТ модель, но никогда её не переименовывает.
 *
 * WHY a guard and not a comment. opencode learned this the expensive way: its Bedrock branch keeps
 * a `modelRequiresPrefix` list (claude, deepseek, nova) and prepends `us.` unconditionally, with no
 * exception for ARNs — so a valid `arn:aws:bedrock:…:foundation-model/deepseek.v3.2` becomes
 * `us.deepseek.v3.2` and the API rejects it as an invalid identifier (anomalyco/opencode#18812).
 * A model outside that list and outside models.dev resolves to `undefined` before the request is
 * even sent (#25428). Both are billing and routing bugs that look like «модель не отвечает».
 *
 * Our matcher READS the id and never writes it, so that failure is structurally impossible — today.
 * «Today» is the word this suite exists for: the day someone adds a field that can substitute the
 * id, the key-set assertion below fails and the author has to decide on purpose rather than by
 * convenience.
 */
suite('идентификатор модели не переписывается', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Полный набор полей, которые правило может отдать.
	 *
	 * Deliberately spelled out rather than derived from the type: a list derived from the type would
	 * grow with it silently, which is the one thing this test exists to prevent.
	 */
	const ALLOWED_FIELDS = [
		// `provider` здесь НЕТ намеренно: matchQuirks выбрасывает его вместе с `match` и `note` —
		// это ключ сопоставления, а не настройка. Тип `ResolvedModelQuirks` раньше его декларировал,
		// хотя в рантайме поля не бывает никогда; расхождение нашёл этот тест и оно исправлено.
		'source', 'observedAt',
		'temperature', 'topP', 'topK',
		'forceEmptyReasoning', 'mirrorReasoningContent', 'reasoningEffortInSystemPrompt',
		'forceToolCallFormat', 'forcedToolChoiceUnsupported', 'reasoningBoundToModel',
	];

	test('набор отдаваемых полей не расширился незаметно', () => {
		const rules: ModelQuirksRule[] = [{
			match: 'x', provider: 'p', source: 's', observedAt: '2026-01-01',
			temperature: 1, topP: 1, topK: 1,
			forceEmptyReasoning: true, mirrorReasoningContent: true,
			reasoningEffortInSystemPrompt: 'e', forceToolCallFormat: 'auto',
			forcedToolChoiceUnsupported: true, reasoningBoundToModel: true,
		}];
		// Провайдер передаётся: правило со `provider` применяется только при его совпадении.
		const resolved = matchQuirks(rules, 'x', 'p')!;
		assert.ok(resolved, 'правило не сопоставилось — проверьте условия матчинга, а не набор полей');
		// Новое поле здесь — повод спросить: не способно ли оно подменить имя модели?
		assert.deepStrictEqual(Object.keys(resolved).sort(), [...ALLOWED_FIELDS].sort());
	});

	/**
	 * ARN — тот самый вход, на котором сломался сосед: у него внутри и точки, и слэши, и имя
	 * семейства модели. У нас он проходит сопоставление как обычная строка.
	 */
	test('ARN сопоставляется как строка и остаётся собой', () => {
		const arn = 'arn:aws:bedrock:us-east-1::foundation-model/deepseek.v3.2';
		const resolved = matchQuirks([{ match: 'deepseek', temperature: 0.7 }], arn);
		assert.deepStrictEqual(resolved, { temperature: 0.7 });
		// Идентификатор не возвращается ни в одном поле: вернуть его — первый шаг к тому, что
		// кто-то начнёт использовать возвращённое вместо исходного.
		assert.ok(!JSON.stringify(resolved).includes('deepseek'), 'квирки вернули имя модели');
		assert.ok(!JSON.stringify(resolved).includes('arn:'), 'квирки вернули ARN');
	});

	/** Модель, которой нет ни в одном правиле, остаётся без квирков — а не без имени. */
	test('незнакомая модель остаётся без квирков, а не без имени', () => {
		assert.strictEqual(matchQuirks([{ match: 'claude' }], 'совершенно-новая-модель-2027'), null);
	});
});
