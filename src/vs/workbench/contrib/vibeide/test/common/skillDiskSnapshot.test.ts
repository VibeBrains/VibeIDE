/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { skillSnapshotResource, VIBE_SKILL_PREVIOUS_SCHEME } from '../../common/skillDiskSnapshot.js';

suite('Снимок навыка в diff обновления', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('прежняя версия — своя схема только для чтения, не безымянный буфер, с меткой открытия', () => {
		const file = URI.file('/work/project/.vibe/skills/night-work/SKILL.md');
		const first = skillSnapshotResource(file, '1');
		const second = skillSnapshotResource(file, '2');
		assert.deepStrictEqual(
			{ scheme: first.scheme, untitled: first.scheme === Schemas.untitled, path: first.path, differs: first.toString() !== second.toString() },
			{ scheme: VIBE_SKILL_PREVIOUS_SCHEME, untitled: false, path: file.path, differs: true },
		);
	});
});
