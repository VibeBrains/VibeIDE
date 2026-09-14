/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { floatingTargetOf } from '../../common/catalogAliases.js';

/**
 * Плавающий id ведёт к разным моделям в разные дни, и вендор не объявляет перенацеливание.
 * Квирк, заведённый на такое имя, начинает описывать не ту модель — молча.
 */
suite('catalogAliases — плавающий идентификатор виден до того, как на него что-то повесят', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('явный алиас и датированный снапшот — оба плавающие, фиксированный id — нет', () => {
		// Формы взяты дословно из живого каталога OpenRouter, 12.09.2026.
		assert.deepStrictEqual(
			[
				floatingTargetOf({ alias_target: { name: 'OpenAI: GPT-6 Astra', slug: 'openai/gpt-6-astra' }, canonical_slug: '~openai/gpt-astra-latest' }, '~openai/gpt-astra-latest'),
				floatingTargetOf({ canonical_slug: 'sakana/fugu-ultra-v2-20260911' }, 'sakana/fugu-ultra-v2'),
				floatingTargetOf({ canonical_slug: 'anthropic/claude-opus-5' }, 'anthropic/claude-opus-5'),
				floatingTargetOf({}, 'openai/gpt-4.1'),
			],
			['openai/gpt-6-astra', 'sakana/fugu-ultra-v2-20260911', undefined, undefined],
		);
	});

	test('алиас сильнее канонического слага — он называет модель, а не снапшот', () => {
		assert.strictEqual(
			floatingTargetOf({ alias_target: { slug: 'z-ai/glm-5.3-flash' }, canonical_slug: '~z-ai/glm-flash-latest' }, '~z-ai/glm-flash-latest'),
			'z-ai/glm-5.3-flash',
		);
	});

	test('мусор вместо записи не превращается в пометку', () => {
		assert.deepStrictEqual(
			[
				floatingTargetOf(undefined, 'x'),
				floatingTargetOf('строка', 'x'),
				floatingTargetOf({ alias_target: { slug: '' }, canonical_slug: '' }, 'x'),
				floatingTargetOf({ alias_target: 'не объект' }, 'x'),
			],
			[undefined, undefined, undefined, undefined],
		);
	});
});
