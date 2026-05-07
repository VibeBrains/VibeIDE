#!/usr/bin/env node
/**
 * vibe docs-dedup — find files with the same basename in docs/v1/ and references/v1/.
 *
 * Both trees are gitignored today; the L.2 policy (see references/v1/audit-2026-05-07-acceptance.md)
 * splits public-facing content (docs/v1/) from internal artefacts (references/v1/). This
 * script catches drift before a name collision becomes a contradiction.
 *
 * Usage:
 *   node scripts/vibe-docs-dedup.js              # human-readable report
 *   node scripts/vibe-docs-dedup.js --json
 *   node scripts/vibe-docs-dedup.js --diff       # also print head -20 of each duplicate
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TREES = [
	path.join(ROOT, 'docs', 'v1'),
	path.join(ROOT, 'references', 'v1'),
];

const args = process.argv.slice(2);
const MODE = {
	json: args.includes('--json'),
	diff: args.includes('--diff'),
};

/** @param {string} dir @param {string[]} acc */
function walk(dir, acc = []) {
	if (!fs.existsSync(dir)) {
		return acc;
	}
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			walk(p, acc);
		} else {
			acc.push(p);
		}
	}
	return acc;
}

function index(dir) {
	const idx = new Map();
	for (const f of walk(dir)) {
		const key = path.basename(f).toLowerCase();
		const arr = idx.get(key) || [];
		arr.push(f);
		idx.set(key, arr);
	}
	return idx;
}

function preview(filePath, n = 20) {
	try {
		const text = fs.readFileSync(filePath, 'utf-8');
		return text.split(/\r?\n/).slice(0, n).join('\n');
	} catch {
		return '<unreadable>';
	}
}

function main() {
	const left = index(TREES[0]);
	const right = index(TREES[1]);

	const collisions = [];
	for (const [base, lefts] of left) {
		const rights = right.get(base);
		if (rights && rights.length > 0) {
			collisions.push({ base, docs: lefts, references: rights });
		}
	}

	if (MODE.json) {
		process.stdout.write(JSON.stringify(collisions, null, 2) + '\n');
		return;
	}

	if (collisions.length === 0) {
		console.log('No basename collisions between docs/v1/ and references/v1/.');
		return;
	}

	console.log(`Found ${collisions.length} basename collision(s):`);
	console.log('');
	for (const c of collisions) {
		console.log(`# ${c.base}`);
		for (const p of c.docs) {
			console.log(`  docs/        ${path.relative(ROOT, p)}`);
		}
		for (const p of c.references) {
			console.log(`  references/  ${path.relative(ROOT, p)}`);
		}
		if (MODE.diff) {
			console.log('');
			console.log('  --- preview docs/ ---');
			console.log(preview(c.docs[0]).split('\n').map(l => '  ' + l).join('\n'));
			console.log('');
			console.log('  --- preview references/ ---');
			console.log(preview(c.references[0]).split('\n').map(l => '  ' + l).join('\n'));
		}
		console.log('');
	}
	console.log('Move each collision into one tree per the policy in references/v1/audit-2026-05-07-acceptance.md.');
}

main();
