/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { interactiveOnlyVerdict, interactiveOnlyVerdictForSelection, VibeLaunchVerdict } from '../../common/interactiveOnlyProvider.js';

const reasonOf = (verdict: VibeLaunchVerdict): string | undefined => verdict.allowed ? undefined : verdict.reason;

suite('Interactive-only provider — launch policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Рука человека — всегда; автоматический путь — отказ с причиной, называющей тариф */
	test('manual is allowed while every automatic source is refused', () => {
		const provider = { id: 'qwen-plan', name: 'Qwen Token Plan', interactiveOnly: true };
		const refused = ['auto', 'orchestration', 'pipeline', 'httpApi', 'telegram'] as const;
		assert.deepStrictEqual(
			{
				manual: interactiveOnlyVerdict(provider, 'manual').allowed,
				refused: refused.map(source => interactiveOnlyVerdict(provider, source).allowed),
				namesTheTariff: reasonOf(interactiveOnlyVerdict(provider, 'httpApi'))?.includes('Qwen Token Plan'),
				sendsToManualChat: reasonOf(interactiveOnlyVerdict(provider, 'telegram'))?.includes('вручную'),
			},
			{ manual: true, refused: [false, false, false, false, false], namesTheTariff: true, sendsToManualChat: true },
		);
	});

	/** Поле необязательное: без него провайдер участвует во всех путях, как раньше */
	test('a provider without the flag allows every source', () => {
		const provider = { id: 'plain' };
		assert.deepStrictEqual(
			(['manual', 'auto', 'orchestration', 'pipeline', 'httpApi', 'telegram'] as const).map(source => interactiveOnlyVerdict(provider, source).allowed),
			[true, true, true, true, true, true],
		);
	});

	/** Решение по выбранной модели читает флаг из настроек провайдера — сид файла или патч встроенного */
	test('selection reads the flag from provider settings', () => {
		const settings = { 'qwen-plan': { title: 'Qwen Token Plan', interactiveOnly: true }, plain: {} };
		assert.deepStrictEqual(
			{
				manual: interactiveOnlyVerdictForSelection(settings, { providerName: 'qwen-plan' }, 'manual').allowed,
				auto: interactiveOnlyVerdictForSelection(settings, { providerName: 'qwen-plan' }, 'auto').allowed,
				plain: interactiveOnlyVerdictForSelection(settings, { providerName: 'plain' }, 'auto').allowed,
				none: interactiveOnlyVerdictForSelection(settings, null, 'httpApi').allowed,
				autoProvider: interactiveOnlyVerdictForSelection(settings, { providerName: 'auto' }, 'auto').allowed,
			},
			{ manual: true, auto: false, plain: true, none: true, autoProvider: true },
		);
	});
});
