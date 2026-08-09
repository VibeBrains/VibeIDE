/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { councilAdviserPrompt, councilSummaryPrompt, COUNCIL_OPINION_LIMIT, CouncilOpinion, formatCouncilResult } from '../../common/modelCouncil.js';

const opinion = (over: Partial<CouncilOpinion> = {}): CouncilOpinion => ({
	providerName: 'minimax', modelName: 'MiniMax-M3', text: 'Позиция: делать A.', durationMs: 4200, ...over,
});

suite('Model council', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the adviser is asked for a position AND its cost, and told it is not alone', () => {
		const prompt = councilAdviserPrompt({ question: 'Свой рантайм или чужой?', context: 'бюджет на месяц' });
		assert.deepStrictEqual(
			{
				asksCost: prompt.includes('Чем платим'),
				asksFalsifier: prompt.includes('передумаешь'),
				forbidsFence: prompt.includes('оба варианта хороши'),
				saysIndependent: prompt.includes('их ответов ты не видишь'),
				carriesContext: prompt.includes('бюджет на месяц'),
			},
			{ asksCost: true, asksFalsifier: true, forbidsFence: true, saysIndependent: true, carriesContext: true },
		);
	});

	test('the summariser sees only answers that arrived, and is told to keep the disagreement', () => {
		const prompt = councilSummaryPrompt({ question: 'A или B?' }, [
			opinion({ text: 'За A' }),
			opinion({ providerName: 'dead', text: '', error: 'таймаут' }),
			opinion({ providerName: 'anthropic', modelName: 'claude', text: 'За B' }),
		]);
		assert.deepStrictEqual(
			{
				keepsDisagreement: prompt.includes('В чём расходятся'),
				asksWhatSettlesIt: prompt.includes('Что решает исход'),
				includesAnswers: prompt.includes('За A') && prompt.includes('За B'),
				// A failed adviser must not appear as an empty voice in the panel.
				skipsFailed: !prompt.includes('dead'),
			},
			{ keepsDisagreement: true, asksWhatSettlesIt: true, includesAnswers: true, skipsFailed: true },
		);
	});

	test('long opinions are cut, not dropped', () => {
		const long = 'ц'.repeat(COUNCIL_OPINION_LIMIT + 500);
		const prompt = councilSummaryPrompt({ question: 'q' }, [opinion({ text: long })]);
		assert.deepStrictEqual(
			{ cut: prompt.includes('ответ обрезан'), kept: prompt.includes('ц'.repeat(100)) },
			{ cut: true, kept: true },
		);
	});

	test('the report says who did not answer — a panel of five that became two is a different answer', () => {
		const text = formatCouncilResult({ question: 'A или B?' }, {
			opinions: [opinion(), opinion({ providerName: 'zai', modelName: 'glm', text: '', error: 'не ответил за 120 с' })],
			summary: 'Согласны: начать с A.',
		});
		assert.deepStrictEqual(
			{
				counts: text.includes('Ответили 1 из 2'),
				namesFailure: text.includes('zai/glm') && text.includes('не ответил за 120 с'),
				hasSummary: text.includes('Согласны: начать с A.'),
			},
			{ counts: true, namesFailure: true, hasSummary: true },
		);
	});

	test('with no summary the opinions are still shown, with the reason on top', () => {
		const text = formatCouncilResult({ question: 'q' }, {
			opinions: [opinion({ text: 'мнение советника' })],
			summary: undefined,
			summaryError: 'сводящая модель не ответила',
		});
		assert.deepStrictEqual(
			{ explains: text.includes('сводящая модель не ответила'), keepsOpinion: text.includes('мнение советника') },
			{ explains: true, keepsOpinion: true },
		);
	});
});
