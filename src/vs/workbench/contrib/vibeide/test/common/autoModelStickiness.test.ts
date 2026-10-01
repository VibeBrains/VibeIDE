/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AutoModelPin, pinAfterFallback, pinnedAutoModel } from '../../common/autoModelStickiness.js';
import { ModelSelection } from '../../common/vibeideSettingsTypes.js';

const sonnet: ModelSelection = { providerName: 'anthropic', modelName: 'claude-sonnet-5' };
const pin: AutoModelPin = { selection: sonnet, chatMode: 'agent', vision: false };
const always = () => true;
const never = () => false;

suite('autoModelStickiness — «Авто» выбирает модель на разговор', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('выбор держится, пока условия те же; меняется режим, приходит картинка, модель пропала или вендор её выключил — решаем заново', () => {
		assert.deepStrictEqual([
			pinnedAutoModel(pin, { chatMode: 'agent', needsVision: false, isAvailable: always, isRetired: never }),
			pinnedAutoModel(undefined, { chatMode: 'agent', needsVision: false, isAvailable: always, isRetired: never }),
			pinnedAutoModel(pin, { chatMode: 'normal', needsVision: false, isAvailable: always, isRetired: never }),
			pinnedAutoModel(pin, { chatMode: 'agent', needsVision: true, isAvailable: always, isRetired: never }),
			pinnedAutoModel({ ...pin, vision: true }, { chatMode: 'agent', needsVision: true, isAvailable: always, isRetired: never }),
			pinnedAutoModel(pin, { chatMode: 'agent', needsVision: false, isAvailable: () => false, isRetired: never }),
			pinnedAutoModel(pin, { chatMode: 'agent', needsVision: false, isAvailable: always, isRetired: always }),
		], [sonnet, undefined, undefined, undefined, sonnet, undefined, undefined]);
	});

	/**
	 * Запасная модель, которая ответила, забирает закрепление: закреплённая только что упала, кэш промпта теперь у запасной
	 * Совпадающее закрепление не переписывается
	 */
	test('после замены на ошибке закрепление переходит на ответившую запасную модель', () => {
		const opus: ModelSelection = { providerName: 'anthropic', modelName: 'claude-opus-5' };
		const answered: AutoModelPin = { selection: opus, chatMode: 'agent', vision: true };
		assert.deepStrictEqual([
			pinAfterFallback(pin, answered),
			pinAfterFallback(undefined, answered),
			pinAfterFallback(answered, answered),
			pinAfterFallback({ ...answered, chatMode: 'normal' }, answered),
		], [answered, answered, undefined, answered]);
	});
});
