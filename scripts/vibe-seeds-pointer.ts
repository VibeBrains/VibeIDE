#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Указатель набора сидов обязан указывать на коммит, который есть в `origin/main` VibeBrains.
 *
 * 09.09.2026 указатель `.vibe-defaults` в пяти запушенных коммитах `next` ушёл на коммит набора,
 * сделанный только локально и затем выброшенный. Чекаут этих коммитов не восстанавливал сиды,
 * `git bisect` через них спотыкался, а собранные из них сборки несли версию сида, которой нет ни в
 * одной истории, — её потом пропустили обе ручные сверки покрытия `deprecated.json`. Порядок
 * «сначала запушить набор, потом бампнуть указатель» был договорённостью; договорённость без гейта
 * протухает молча, поэтому она стала гейтом.
 *
 * WHY reachable from origin/main rather than merely «exists somewhere on the remote»: VibeIDE ships
 * the set's canon, and a pointer to a side branch vanishes when that branch is deleted. The five
 * historical commits were repaired with the archive tag `archive/edf534b`; that is history, and this
 * gate judges only the pointer being committed now.
 *
 * WHY the INDEX and not the checkout: what matters is the pointer that goes into the commit. A
 * submodule checked out at one commit and staged at another is exactly the confusion that produced
 * the incident.
 *
 * Without network it WARNS and lets the commit through: blocking offline work teaches people to
 * bypass the hook, and the push of VibeIDE itself is still ahead of them.
 *
 * WHY it runs from the `precommit` chain and not from lint-staged: lint-staged drops submodules by
 * design — `getStagedFiles.js` filters out mode 160000 («Filter out submodules and symlinks»), so a
 * lint-staged task keyed on `.vibe-defaults` is registered and never fires. Found by a live run, not
 * by reading the config: the task sat in the list while two opposite pointers both passed silently.
 * Running on every commit means the ordinary case — pointer untouched — must cost nothing, hence the
 * first check below needs neither network nor the submodule.
 *
 * Usage: node scripts/vibe-seeds-pointer.ts
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const cp: typeof import('child_process') = require('child_process');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const SUBMODULE = '.vibe-defaults';
const CANON = 'origin/main';
const FETCH_TIMEOUT_MS = 60_000;

function git(args: readonly string[], cwd: string = ROOT, timeout?: number): { code: number; out: string; err: string } {
	const result = cp.spawnSync('git', [...args], { cwd, encoding: 'utf8', timeout });
	return { code: result.status ?? -1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function warnAndPass(message: string): never {
	console.log(`\n⚠️  НЕ ПРОВЕРЕНО: ${message}`);
	console.log('   Коммит пропущен. Перед пушем VibeIDE убедитесь, что набор запушен в main.');
	process.exit(0);
}

function fail(message: string, fix: string): never {
	console.log(`\n❌ ${message}`);
	console.log(`   ${fix}`);
	process.exit(1);
}

// `160000 <sha> 0\t.vibe-defaults` — mode 160000 is a gitlink; anything else is not a submodule.
const staged = git(['ls-files', '--stage', '--', SUBMODULE]).out.split(/\s+/);
if (staged[0] !== '160000' || !/^[0-9a-f]{40}$/.test(staged[1] ?? '')) {
	fail(`В индексе нет указателя подмодуля ${SUBMODULE}.`,
		'Если набор убирается из проекта намеренно, это отдельное решение, а не бамп указателя.');
}
const pointer = staged[1];

// `160000 commit <sha>\t.vibe-defaults`. Unchanged pointer — nothing to judge, and no reason to touch
// the network on a commit that does not move it. A missing HEAD (first commit) falls through to a check.
const head = git(['ls-tree', 'HEAD', '--', SUBMODULE]).out.split(/\s+/);
if (head[0] === '160000' && head[2] === pointer) {
	console.log(`🔗 Указатель набора не менялся (${pointer.slice(0, 9)}) — проверять нечего.`);
	process.exit(0);
}

console.log('🔗 Указатель набора сидов: коммит обязан быть в main VibeBrains');
console.log('─'.repeat(60));
console.log(`указатель в индексе: ${pointer.slice(0, 9)} (был ${head[0] === '160000' ? head[2].slice(0, 9) : 'не задан'})`);

if (git(['rev-parse', '--git-dir'], path.join(ROOT, SUBMODULE)).code !== 0) {
	warnAndPass(`подмодуль ${SUBMODULE} не инициализирован — сверять не с чем.`);
}

const setDir = path.join(ROOT, SUBMODULE);
const fetched = git(['fetch', '--quiet', 'origin', 'main'], setDir, FETCH_TIMEOUT_MS);
if (fetched.code !== 0) {
	warnAndPass(`нет связи с удалённым VibeBrains (${fetched.err.split('\n')[0] || 'fetch не удался'}).`);
}

const reach = git(['merge-base', '--is-ancestor', pointer, CANON], setDir);
if (reach.code === 0) {
	console.log(`\n✅ ${pointer.slice(0, 9)} есть в ${CANON} набора — указатель разворачивается у любого.`);
	process.exit(0);
}
// Exit 1 means «known here, but not in main»; anything else (128) means the commit is not even known
// locally after the fetch — so it is in no remote branch we ship from either way.
const known = git(['cat-file', '-e', `${pointer}^{commit}`], setDir).code === 0;
fail(
	known
		? `Коммит набора ${pointer.slice(0, 9)} есть только у вас: в ${CANON} VibeBrains его нет.`
		: `Коммит набора ${pointer.slice(0, 9)} неизвестен даже локально после fetch.`,
	'Сначала запушьте набор — `git -C .vibe-defaults push origin HEAD:main`, — затем повторите коммит. Указатель на незапушенный коммит не развернётся ни у кого, кроме вас.',
);
