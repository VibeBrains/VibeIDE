/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { commandEscapesScope, describeCommandEscape } from '../../common/commandEscapesScope.js';

const reasonOf = (command: string) => commandEscapesScope(command)?.reason;

suite('commandEscapesScope — команда шага не обходит его границы записи', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('смена папки, перенаправление git и нечитаемая строка отклоняются', () => {
		assert.deepStrictEqual([
			reasonOf('cd ../other && rm -rf .'),
			reasonOf('npm test && cd src'),
			reasonOf('git -C ../other commit -am x'),
			reasonOf('git --no-pager -C /tmp/repo log'),
			reasonOf('GIT_DIR=/tmp/x git status'),
			reasonOf('echo $(whoami) > file'),
			reasonOf('eval "rm -rf /"'),
		].map(reason => reason !== undefined), [true, true, true, true, true, true, true]);
	});

	test('обычные команды проекта проходят', () => {
		assert.deepStrictEqual([
			commandEscapesScope('npm run test'),
			commandEscapesScope('git status --porcelain'),
			commandEscapesScope('node scripts/gen.mjs docs/'),
			commandEscapesScope('   '),
			commandEscapesScope('grep -rn "cdn" docs'),
		], [undefined, undefined, undefined, undefined, undefined]);
	});

	test('отказ называет причину, границы и саму команду', () => {
		const escape = commandEscapesScope('cd /tmp && touch x')!;
		assert.ok(describeCommandEscape('cd /tmp && touch x', escape, ['docs/**']).includes('docs/**'));
		assert.ok(describeCommandEscape('cd /tmp && touch x', escape, undefined).includes('границы объявлены шагом'));
	});
});
