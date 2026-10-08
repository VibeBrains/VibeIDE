/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AUTOPILOT_EMPTY_TURN_NUDGE, AUTOPILOT_QUESTION_NUDGE, AUTOPILOT_TEXT_TURN_NUDGE, designHookNudge, nudgeHeadlineOf, slopGateNudge, unparsedToolCallNudge, verifyGateNudge, XML_REPAIR_NUDGE } from '../../common/agentNudges.js';
import { renderTurnChecksCorrective } from '../../common/agentTurnChecks.js';

/**
 * A service message to the model is shown folded to its headline
 * Every text must open with «<emoji> <ЯРЛЫК>:», or the folded line would show half a sentence
 */
suite('agent nudges — the folded headline', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every service message opens with its own label', () => {
		assert.deepStrictEqual([
			verifyGateNudge('npm test', 1, 1, 3, 'boom'),
			renderTurnChecksCorrective([], 1, 2),
			designHookNudge('• x', 1, false),
			slopGateNudge(1, 2, 'x'),
			XML_REPAIR_NUDGE,
			unparsedToolCallNudge(),
			AUTOPILOT_QUESTION_NUDGE,
			AUTOPILOT_EMPTY_TURN_NUDGE,
			AUTOPILOT_TEXT_TURN_NUDGE,
		].map(nudgeHeadlineOf), [
			'⛔ VERIFY-GATE',
			'⛔ ПРОВЕРКИ ХОДА',
			'⛔ DESIGN-HOOK',
			'⛔ НЕЙРОСЛОП',
			'⚙️ Авто-исправление',
			'⚙️ Вызов инструмента не выполнен',
			'⚙️ Авто-продолжение (автопилот)',
			'⚙️ Авто-продолжение (автопилот)',
			'⚙️ Авто-продолжение (автопилот)',
		]);
	});

	test('a text without a label is cut, not shown whole', () => {
		assert.deepStrictEqual(
			[nudgeHeadlineOf('просто строка'), nudgeHeadlineOf('x'.repeat(100)).length],
			['просто строка', 60],
		);
	});
});
