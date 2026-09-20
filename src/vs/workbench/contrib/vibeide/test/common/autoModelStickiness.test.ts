/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AutoModelPin, pinnedAutoModel } from '../../common/autoModelStickiness.js';
import { ModelSelection } from '../../common/vibeideSettingsTypes.js';

const sonnet: ModelSelection = { providerName: 'anthropic', modelName: 'claude-sonnet-5' };
const pin: AutoModelPin = { selection: sonnet, chatMode: 'agent', vision: false };
const always = () => true;

suite('autoModelStickiness — «Авто» выбирает модель на разговор', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('выбор держится, пока условия те же; меняется режим, приходит картинка или модель пропала — решаем заново', () => {
		assert.deepStrictEqual([
			pinnedAutoModel(pin, { chatMode: 'agent', needsVision: false, isAvailable: always }),
			pinnedAutoModel(undefined, { chatMode: 'agent', needsVision: false, isAvailable: always }),
			pinnedAutoModel(pin, { chatMode: 'normal', needsVision: false, isAvailable: always }),
			pinnedAutoModel(pin, { chatMode: 'agent', needsVision: true, isAvailable: always }),
			pinnedAutoModel({ ...pin, vision: true }, { chatMode: 'agent', needsVision: true, isAvailable: always }),
			pinnedAutoModel(pin, { chatMode: 'agent', needsVision: false, isAvailable: () => false }),
		], [sonnet, undefined, undefined, undefined, sonnet, undefined]);
	});
});
