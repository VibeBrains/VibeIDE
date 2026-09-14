/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { effectiveWriteScope, QA_DEFAULT_WRITE_PATHS, stepMayWrite } from '../../common/pipeline/vibePipelineFile.js';
import { parseRolesFile } from '../../common/pipeline/vibeRolesFile.js';
import { safeParseConfigJson } from '../../common/vibeConfigJsonParser.js';
import { VIBE_DEFAULTS_MANIFEST } from '../../common/vibeDefaultsManifest.generated.js';

/**
 * `.vibe/roles.json` общий с VibeIDEA. Ошибка в файле никогда не расширяет границу записи qa.
 */
suite('vibeRolesFile — умолчания ролей из общего файла', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('список из файла, нет записи qa — встроенный, пустой список — запрет', () => {
		assert.deepStrictEqual(
			[
				parseRolesFile({ version: 1, roles: { qa: { writePaths: ['e2e/**'] } } }),
				parseRolesFile({ version: 1, roles: {} }),
				parseRolesFile({ version: 1, roles: { qa: { writePaths: [] } } }),
			],
			[
				{ qaWritePaths: ['e2e/**'], warnings: [] },
				{ warnings: [] },
				{ qaWritePaths: [], warnings: [] },
			],
		);
	});

	test('битый список — встроенный с предупреждением, а не «пиши куда угодно»', () => {
		const broken = [
			parseRolesFile({ roles: { qa: { writePaths: '**' } } }),
			parseRolesFile({ roles: { qa: { writePaths: ['tests/**', ''] } } }),
			parseRolesFile({ roles: { qa: { writePaths: ['tests/**', 7] } } }),
			parseRolesFile('не объект'),
		];
		assert.deepStrictEqual(
			broken.map(r => [r.qaWritePaths, r.warnings.length]),
			[[undefined, 1], [undefined, 1], [undefined, 1], [undefined, 1]],
		);
	});

	test('пустой список из файла запрещает qa запись везде, свои paths шага по-прежнему сильнее', () => {
		const forbidden = effectiveWriteScope('qa', undefined, [])!;
		assert.deepStrictEqual(
			[
				stepMayWrite(forbidden, 'src/order.test.ts'),
				stepMayWrite(forbidden, 'src/order.ts'),
				effectiveWriteScope('qa', { paths: ['e2e/**'] }, []),
			],
			[false, false, { paths: ['e2e/**'] }],
		);
	});

	test('засеянный roles.json совпадает со встроенным списком — разойтись молча они не могут', () => {
		// Same check VibeIDEA runs against its own constant. A change to the shared file without the
		// constant (or the other way round) fails here, not in a user's project.
		const seed = VIBE_DEFAULTS_MANIFEST.find(file => file.path === 'roles.json');
		assert.ok(seed, 'roles.json must be seeded');
		const parsed = safeParseConfigJson(seed.contents);
		assert.ok(parsed.ok);
		assert.deepStrictEqual(parseRolesFile(parsed.value).qaWritePaths, QA_DEFAULT_WRITE_PATHS);
	});
});
