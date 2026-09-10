/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifySkillProvenance, setRelativeSkillPath } from '../../common/vibeSkillProvenance.js';
import { VIBE_DEFAULTS_MANIFEST } from '../../common/vibeDefaultsManifest.generated.js';

suite('происхождение скилла', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('путь в системе координат набора', () => {
		/**
		 * Главная ловушка: библиотека отдаёт путь от корня рабочей области, а манифест — от `.vibe`.
		 * Без пересчёта каждый засеянный скилл считался бы чужим, и это выглядело бы как «все скиллы
		 * со стороны» — то есть как страшилка, а не как дефект.
		 */
		test('приводит путь библиотеки к пути манифеста', () => {
			assert.deepStrictEqual({
				обычный: setRelativeSkillPath('.vibe/skills/teach/SKILL.md'),
				сТочкой: setRelativeSkillPath('./.vibe/skills/teach/SKILL.md'),
				вложенный: setRelativeSkillPath('packages/web/.vibe/skills/teach/SKILL.md'),
				виндовый: setRelativeSkillPath('.vibe\\skills\\teach\\SKILL.md'),
			}, {
				обычный: 'skills/teach/SKILL.md',
				сТочкой: 'skills/teach/SKILL.md',
				вложенный: 'skills/teach/SKILL.md',
				виндовый: 'skills/teach/SKILL.md',
			});
		});

		test('путь вне .vibe/skills набору не принадлежит', () => {
			assert.deepStrictEqual({
				глобальный: setRelativeSkillPath('/Users/me/.vibe-global/skills/x/SKILL.md'),
				неСкилл: setRelativeSkillPath('.vibe/rules.md'),
				пустой: setRelativeSkillPath(''),
			}, { глобальный: undefined, неСкилл: undefined, пустой: undefined });
		});

		/** Сверка с ОТГРУЖАЕМЫМИ байтами: пересчитанный путь обязан найтись в манифесте. */
		test('пересчитанный путь реального скилла есть в манифесте', () => {
			const shipped = VIBE_DEFAULTS_MANIFEST.find(f => f.path.startsWith('skills/') && f.path.endsWith('/SKILL.md'));
			assert.ok(shipped, 'в наборе нет ни одного скилла — тест устарел вместе с набором');
			const viaLibrary = setRelativeSkillPath(`.vibe/${shipped.path}`);
			assert.strictEqual(viaLibrary, shipped.path);
		});
	});

	test('три исхода и их формулировки', () => {
		assert.deepStrictEqual({
			изРелиза: classifySkillProvenance(true, true),
			правленый: classifySkillProvenance(true, false),
			// «Свой или со стороны», а не «чужой»: скилл, написанный самим пользователем, попадает
			// сюда же, и назвать его чужим значит научить не читать эту подпись вовсе.
			неИзНабора: classifySkillProvenance(false, false),
		}, {
			изРелиза: { origin: 'shipped', label: 'из релиза' },
			правленый: { origin: 'shipped-edited', label: 'из релиза, изменён' },
			неИзНабора: { origin: 'foreign', label: 'не из релиза — свой или со стороны' },
		});
	});

	test('для неизвестного пути второй факт ничего не меняет', () => {
		assert.deepStrictEqual(classifySkillProvenance(false, true), classifySkillProvenance(false, false));
	});
});
