/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @i18n-scan-skip-file
// CJS mirror of src/vs/workbench/contrib/vibeide/common/diffCommitGrouping.ts
// MUST stay in sync with the TS source — logic is duplicated here for zero-dep Node use.
'use strict';

/** @param {string} p */
function classifyChange(p) {
	p = p.replace(/\\/g, '/');
	if (p.startsWith('.github/workflows/') || p === '.github/dependabot.yml') {
		return { type: 'ci', scope: 'workflows' };
	}
	if (p === 'package.json' || p === 'package-lock.json' || p === 'pnpm-lock.yaml' || p === 'yarn.lock' || p === 'tsconfig.json') {
		return { type: 'build', scope: 'deps' };
	}
	if (/\.md$/i.test(p) || p.startsWith('docs/')) {
		return { type: 'docs' };
	}
	if (/(^|\/)test\//.test(p) || /\.test\.tsx?$/.test(p) || /\.spec\.tsx?$/.test(p)) {
		return { type: 'test' };
	}
	if (/\.(css|scss|less)$/i.test(p)) {
		return { type: 'style' };
	}
	const srcMatch = p.match(/^src\/([^/]+)\//);
	if (srcMatch) {
		return { type: 'feat', scope: srcMatch[1] };
	}
	const top = p.split('/')[0];
	return { type: 'feat', scope: top || undefined };
}

function pickVerb(files) {
	const allNew = files.length > 0 && files.every(f => f.isNew);
	if (allNew) {return 'add';}
	const allDeleted = files.length > 0 && files.every(f => f.isDeleted);
	if (allDeleted) {return 'remove';}
	return 'edit';
}

/**
 * @param {Array<{path:string, isNew?:boolean, isDeleted?:boolean}>} changes
 * @returns {Array<{type:string, scope?:string, files:Array<{path:string}>}>}
 */
function groupDiffByCommitType(changes) {
	const buckets = new Map();
	const order = [];
	for (const change of changes) {
		if (!change || typeof change.path !== 'string' || change.path.length === 0) {continue;}
		const { type, scope } = classifyChange(change.path);
		const key = `${type}|${scope ?? ''}`;
		if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
		buckets.get(key).push(change);
	}
	return order.map(key => {
		const [type, scopePart] = key.split('|');
		const files = buckets.get(key);
		return { type, ...(scopePart ? { scope: scopePart } : {}), files };
	});
}

/**
 * @param {{type:string, scope?:string, files:Array<{path:string, isNew?:boolean, isDeleted?:boolean}>}} group
 */
function renderGroupStub(group) {
	const verb = pickVerb(group.files);
	const head = group.scope ? `${group.type}(${group.scope})` : group.type;
	return `${head}: ${verb} ${group.files.length} file${group.files.length === 1 ? '' : 's'}`;
}

// self-contained unit tests (run with: node scripts/lib/diff-commit-grouping.cjs --test)
if (process.argv.includes('--test')) {
	let passed = 0, failed = 0;
	function assert(desc, cond) { if (cond) { passed++; } else { failed++; console.error('FAIL:', desc); } }

	const g1 = groupDiffByCommitType([
		{ path: '.github/workflows/ci.yml' },
		{ path: 'src/workbench/foo.ts' },
		{ path: 'docs/README.md' },
	]);
	assert('ci bucket present', g1.some(g => g.type === 'ci'));
	assert('docs bucket present', g1.some(g => g.type === 'docs'));
	assert('feat bucket present', g1.some(g => g.type === 'feat'));

	const g2 = groupDiffByCommitType([{ path: 'package-lock.json' }]);
	assert('package-lock → build', g2[0].type === 'build');

	const g3 = groupDiffByCommitType([{ path: 'src/editor/foo.test.ts' }]);
	assert('.test.ts → test', g3[0].type === 'test');

	const stub = renderGroupStub({ type: 'feat', scope: 'workbench', files: [{ path: 'x.ts', isNew: true }] });
	assert('renderGroupStub new', stub === 'feat(workbench): add 1 file');

	const stub2 = renderGroupStub({ type: 'docs', files: [{ path: 'a.md' }, { path: 'b.md' }] });
	assert('renderGroupStub edit 2', stub2 === 'docs: edit 2 files');

	console.log(`diff-commit-grouping.cjs: ${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

module.exports = { groupDiffByCommitType, renderGroupStub, classifyChange };
