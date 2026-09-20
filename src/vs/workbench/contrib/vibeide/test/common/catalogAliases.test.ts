/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { floatingRefOf } from '../../common/catalogAliases.js';

/**
 * Плавающий id ведёт к разным моделям в разные дни, и вендор не объявляет перенацеливание.
 * Квирк, заведённый на такое имя, начинает описывать не ту модель — молча.
 */
suite('catalogAliases — плавающий идентификатор виден до того, как на него что-то повесят', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('алиас и снимок помечаются по-разному, фиксированный id — никак', () => {
		// Формы взяты дословно из живого каталога OpenRouter, 12.09.2026.
		assert.deepStrictEqual(
			[
				floatingRefOf({ alias_target: { name: 'OpenAI: GPT-6 Astra', slug: 'openai/gpt-6-astra' }, canonical_slug: '~openai/gpt-astra-latest' }, '~openai/gpt-astra-latest'),
				floatingRefOf({ canonical_slug: 'sakana/fugu-ultra-v2-20260911' }, 'sakana/fugu-ultra-v2'),
				floatingRefOf({ canonical_slug: 'anthropic/claude-opus-5' }, 'anthropic/claude-opus-5'),
				floatingRefOf({}, 'openai/gpt-4.1'),
			],
			[
				{ target: 'openai/gpt-6-astra', kind: 'alias' },
				{ target: 'sakana/fugu-ultra-v2-20260911', kind: 'snapshot' },
				undefined,
				undefined,
			],
		);
	});

	test('алиас сильнее канонического слага — он называет модель, а не снапшот', () => {
		assert.deepStrictEqual(
			floatingRefOf({ alias_target: { slug: 'z-ai/glm-5.3-flash' }, canonical_slug: '~z-ai/glm-flash-latest' }, '~z-ai/glm-flash-latest'),
			{ target: 'z-ai/glm-5.3-flash', kind: 'alias' },
		);
	});

	test('мусор вместо записи не превращается в пометку', () => {
		assert.deepStrictEqual(
			[
				floatingRefOf(undefined, 'x'),
				floatingRefOf('строка', 'x'),
				floatingRefOf({ alias_target: { slug: '' }, canonical_slug: '' }, 'x'),
				floatingRefOf({ alias_target: 'не объект' }, 'x'),
			],
			[undefined, undefined, undefined, undefined],
		);
	});
});
