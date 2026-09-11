/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideSkillTrust,
	describeSkillForApproval,
	diffSkillPackage,
	isExecutableSkillFile,
	isSkillApproval,
	isSkillTrusted,
	sha256OfBytes,
	SkillApproval,
	skillPackageDigest,
	SkillTrustState,
	VibeSkillPackage,
} from '../../common/skillApproval.js';

/**
 * Одобрение скилла — это одобрение байтов всего каталога: текста, скриптов, вложений.
 * Модель видит вывод скриптов, но не их код, поэтому отпечаток одного `SKILL.md` одобрял бы ровно тот
 * файл, который человек и так прочитал.
 */
suite('skillApproval — отпечаток каталога и решение о доверии', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const bytes = (text: string) => new TextEncoder().encode(text);

	test('sha256 — стандартный, по байтам', async () => {
		assert.strictEqual(await sha256OfBytes(bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	test('отпечаток не зависит от порядка файлов, но зависит от имён и содержимого', async () => {
		const text = { path: 'SKILL.md', sha256: '1' };
		const script = { path: 'scripts/run.sh', sha256: '2' };
		const base = await skillPackageDigest([text, script]);
		assert.deepStrictEqual({
			порядок: await skillPackageDigest([script, text]) === base,
			переименование: await skillPackageDigest([text, { ...script, path: 'bin/run.sh' }]) === base,
			содержимое: await skillPackageDigest([text, { ...script, sha256: '3' }]) === base,
			лишнийФайл: await skillPackageDigest([text, script, { path: 'notes.txt', sha256: '4' }]) === base,
		}, { порядок: true, переименование: false, содержимое: false, лишнийФайл: false });
	});

	test('решение о доверии: встроенный, затем «не проверить», затем релиз, затем одобрение', () => {
		const approval: SkillApproval = { digest: 'd1', files: [], approvedAt: 0 };
		const decide = (over: Partial<Parameters<typeof decideSkillTrust>[0]>) =>
			decideSkillTrust({ builtin: false, shipped: false, digest: 'd1', approval: undefined, ...over });
		const states: SkillTrustState[] = ['builtin', 'shipped', 'approved', 'changed', 'new', 'unverifiable'];
		assert.deepStrictEqual({
			встроенный: decide({ builtin: true, digest: undefined }),
			неПроверить: decide({ digest: undefined, shipped: true, approval }),
			изРелиза: decide({ shipped: true }),
			новый: decide({}),
			одобрен: decide({ approval }),
			изменился: decide({ approval, digest: 'd2' }),
			видитМодель: states.filter(isSkillTrusted),
		}, {
			встроенный: 'builtin',
			неПроверить: 'unverifiable',
			изРелиза: 'shipped',
			новый: 'new',
			одобрен: 'approved',
			изменился: 'changed',
			видитМодель: ['builtin', 'shipped', 'approved'],
		});
	});

	test('разница с одобренным: добавлено, удалено, изменено', () => {
		assert.deepStrictEqual(diffSkillPackage(
			[{ path: 'SKILL.md', sha256: '1' }, { path: 'scripts/old.sh', sha256: '2' }, { path: 'scripts/run.sh', sha256: '3' }],
			[{ path: 'SKILL.md', sha256: '1' }, { path: 'scripts/run.sh', sha256: '9' }, { path: 'scripts/new.py', sha256: '4' }],
		), { added: ['scripts/new.py'], removed: ['scripts/old.sh'], modified: ['scripts/run.sh'] });
	});

	/** Скрипт без расширения выдаёт себя строкой `#!`, двоичный файл — сигнатурой; имя не нужно ни тому, ни другому. */
	test('исполняемый — по расширению, по #! и по сигнатуре двоичного файла', () => {
		const empty = new Uint8Array();
		assert.deepStrictEqual({
			sh: isExecutableSkillFile('scripts/run.sh', empty),
			pyВерхнийРегистр: isExecutableSkillFile('tool.PY', empty),
			шебанг: isExecutableSkillFile('bin/tool', bytes('#!/usr/bin/env node\n')),
			elf: isExecutableSkillFile('bin/tool', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2])),
			machO: isExecutableSkillFile('bin/tool', new Uint8Array([0xcf, 0xfa, 0xed, 0xfe])),
			markdown: isExecutableSkillFile('SKILL.md', bytes('# Заголовок')),
			справка: isExecutableSkillFile('references/api.txt', bytes('curl is used here')),
			короткийФайл: isExecutableSkillFile('a', bytes('M')),
		}, { sh: true, pyВерхнийРегистр: true, шебанг: true, elf: true, machO: true, markdown: false, справка: false, короткийФайл: false });
	});

	/** Хранилище переживает версии кода: повреждённая или чужая запись не одобряет ничего. */
	test('запись одобрения читается с проверкой формы', () => {
		assert.deepStrictEqual([
			isSkillApproval({ digest: 'd', files: [{ path: 'SKILL.md', sha256: '1' }], approvedAt: 1 }),
			isSkillApproval({ digest: 'd', files: [{ path: 'SKILL.md' }], approvedAt: 1 }),
			isSkillApproval({ digest: 1, files: [], approvedAt: 1 }),
			isSkillApproval(null),
			isSkillApproval('d'),
		], [true, false, false, false, false]);
	});

	/** Диалог, который говорит только «скилл изменился», просит доверия, не сказав, в чём. */
	test('текст для одобрения называет изменения, исполняемые файлы и находки Config Guard', () => {
		const pkg: VibeSkillPackage = {
			root: URI.file('/ws/.vibe/skills/deploy'),
			origin: 'foreign',
			trust: 'changed',
			digest: 'd2',
			files: [
				{ path: 'SKILL.md', sha256: '1', size: 10, executable: false },
				{ path: 'scripts/run.sh', sha256: '9', size: 20, executable: true },
			],
			changes: { added: [], removed: [], modified: ['scripts/run.sh'] },
			findings: ['скрипт scripts/run.sh скачивает и выполняет код из сети'],
		};
		assert.strictEqual(describeSkillForApproval('deploy', pkg), [
			'«deploy» — изменился после одобрения; не из релиза — свой или со стороны',
			'Изменены: scripts/run.sh',
			'Файлов: 2, исполняемых: 1 — scripts/run.sh. Модель увидит их вывод, но не код.',
			'Config Guard: скрипт scripts/run.sh скачивает и выполняет код из сети',
		].join('\n'));
	});
});
