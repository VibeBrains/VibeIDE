/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Три файла `*.generated.ts` собираются из источников (документация, набор сидов, спеки) и при
 * этом лежат в git. `precompile` перегенерирует их перед каждой компиляцией, поэтому СБОРКА
 * всегда свежая — а вот версия в репозитории отстаёт молча, пока кто-нибудь не заметит чужой
 * файл в `git status` и не догадается, что это не мусор.
 *
 * Чем это плохо, если сборка и так свежая:
 *   1. читающий код видит документацию, которой уже нет — а бандл именно для того и существует,
 *      чтобы агент отвечал по нему, не выходя в интернет;
 *   2. дифф всплывает у каждого, кто собирает, и приучает пролистывать `git status`;
 *   3. можно закоммитить бандл, собранный от СТАРЫХ доков, откатив чужую свежую правку — git
 *      не увидит здесь конфликта.
 *
 * Проверка перегенерирует всё и сравнивает с рабочим деревом. Ничего не оставляет за собой:
 * при расхождении файлы возвращаются в исходное состояние, чтобы гейт не превращался в молчаливую
 * правку (найдено 01.09.2026 — мануал `choosingModel.md` пролежал в репозитории несогласованным).
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFileSync } = require('child_process') as typeof import('child_process');

const ROOT = path.join(__dirname, '..');

/** Generator script → the file it writes. Keep in sync with `gen:all` in package.json. */
const GENERATED: ReadonlyArray<{ readonly script: string; readonly out: string }> = [
	{ script: 'scripts/gen-vibe-defaults.mjs', out: 'src/vs/workbench/contrib/vibeide/common/vibeDefaultsManifest.generated.ts' },
	{ script: 'scripts/gen-specs-help.mjs', out: 'src/vs/workbench/contrib/vibeide/common/vibeSpecsHelp.generated.ts' },
	{ script: 'scripts/gen-docs-bundle.mjs', out: 'src/vs/workbench/contrib/vibeide/common/vibeDocsBundle.generated.ts' },
];

const before = new Map<string, string>();
for (const { out } of GENERATED) {
	const abs = path.join(ROOT, out);
	before.set(out, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');
}

for (const { script } of GENERATED) {
	execFileSync(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, stdio: 'pipe' });
}

const stale: string[] = [];
for (const { out, script } of GENERATED) {
	const abs = path.join(ROOT, out);
	const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
	if (now !== before.get(out)) {
		stale.push(`${out}\n      источник изменился, а файл в репозитории — нет. Починка: node ${script} (или npm run gen:all) и закоммитить результат`);
		// Put the tree back: a check must not edit what it checks.
		fs.writeFileSync(abs, before.get(out)!, 'utf8');
	}
}

if (stale.length) {
	console.error('❌ Сгенерированные файлы отстали от источников:');
	for (const s of stale) { console.error(`   ${s}`); }
	console.error(`\n   всего: ${stale.length}. Рабочее дерево не тронуто — перегенерируйте сами.`);
	process.exit(1);
}
console.log(`✅ Сгенерированные файлы (${GENERATED.length}) совпадают с источниками.`);
