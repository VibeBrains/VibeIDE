/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	DEFAULT_EDIT_RISK_THRESHOLDS,
	isCriticalFile,
	isTestFile,
	scoreEditRisk,
	type IEditRiskInput,
} from '../../common/editRiskScoring.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const edit = (over: Partial<IEditRiskInput> = {}): IEditRiskInput => ({
	operation: 'edit_file',
	filePath: 'src/app/widget.ts',
	fileWasRead: true,
	...over,
});

const level = (over: Partial<IEditRiskInput> = {}) => scoreEditRisk(edit(over)).riskLevel;

suite('editRiskScoring', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('распознавание путей', () => {
		test('каталог с тестами не путается с похожими именами', () => {
			assert.deepStrictEqual(
				['src/latest/api.ts', 'app/protest/main.ts', 'src/test/a.ts', 'src/tests/a.ts', 'a/__tests__/b.ts', 'src/a.test.ts', 'test_helper.py']
					.map(isTestFile),
				[false, false, true, true, true, true, true]);
		});

		test('критические файлы узнаются по имени, а не по вхождению подстроки', () => {
			assert.deepStrictEqual(
				['.env', 'app/.env.local', '.github/workflows/ci.yml', 'package.json', 'src/environment.ts', 'docs/package.json.md']
					.map(isCriticalFile),
				[true, true, true, true, false, false]);
		});
	});

	suite('дефекты, найденные проверкой 14.08.2026', () => {
		test('правка критического файла требует человека, а не автоодобрения', () => {
			assert.deepStrictEqual(
				['.env', '.github/workflows/release.yml', 'package.json'].map(filePath => level({ filePath })),
				['HIGH', 'HIGH', 'HIGH']);
		});

		test('низкая уверенность достижима: правка вслепую перезаписью', () => {
			const blind = scoreEditRisk(edit({ operation: 'rewrite_file', fileWasRead: false, originalLength: 100, newLength: 105 }));
			assert.ok(blind.confidenceScore <= DEFAULT_EDIT_RISK_THRESHOLDS.highIfConfidenceAtMost,
				`уверенность ${blind.confidenceScore} должна опускаться до порога`);
			assert.strictEqual(blind.riskLevel, 'HIGH');
		});

		test('LOW достижим: обычная правка прочитанного некритического файла', () => {
			assert.strictEqual(level(), 'LOW');
		});

		test('тестовый файл снижает риск, а не повышает', () => {
			const test = scoreEditRisk(edit({ filePath: 'src/test/widget.test.ts' }));
			const plain = scoreEditRisk(edit());
			assert.ok(test.riskScore <= plain.riskScore, `${test.riskScore} должен быть не выше ${plain.riskScore}`);
		});
	});

	suite('прочие правила', () => {
		test('удаление — всегда HIGH', () => {
			assert.strictEqual(level({ operation: 'delete_file_or_folder', filePath: 'docs/readme.md' }), 'HIGH');
		});

		test('создание некритического файла не считается правкой вслепую', () => {
			assert.strictEqual(level({ operation: 'create_file_or_folder', fileWasRead: false, filePath: 'src/new.ts' }), 'LOW');
		});

		test('создание критического файла остаётся HIGH', () => {
			assert.strictEqual(level({ operation: 'create_file_or_folder', fileWasRead: false, filePath: '.env' }), 'HIGH');
		});

		test('перезапись, меняющая размер вдвое, поднимает риск', () => {
			const score = scoreEditRisk(edit({ operation: 'rewrite_file', originalLength: 100, newLength: 300 }));
			assert.ok(score.riskScore >= DEFAULT_EDIT_RISK_THRESHOLDS.highRiskAtLeast, `риск ${score.riskScore}`);
		});

		test('множественная операция добавляет риск, но сама по себе HIGH не делает', () => {
			// Три файла — это ещё не опасность, тридцать уже стоят взгляда, но ни то ни другое не
			// повод спрашивать человека: масштаб правки и её опасность — разные вещи.
			assert.deepStrictEqual(
				[level({ totalFilesInOperation: 3 }), level({ totalFilesInOperation: 30 })],
				['LOW', 'MEDIUM']);
		});

		test('причины возвращаются всегда — вердикт без объяснения бесполезен', () => {
			const score = scoreEditRisk(edit());
			assert.deepStrictEqual(
				[score.riskFactors.length > 0, score.confidenceFactors.length > 0],
				[true, true]);
		});
	});
});
