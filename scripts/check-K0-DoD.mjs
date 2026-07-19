#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Check K.0 (псевдо-готовность) DoD compliance — every item under
 * "### K.0 Псевдо-готовность" in docs/roadmap.md must satisfy one of:
 *   - [x] with a real-impl commit ref (commit `<hash>` somewhere in the body)
 *   - [~] with a real-impl commit ref + skeleton note
 *   - [ ] with an explicit BLOCKED reason inline (e.g. "EV cert", "marketing")
 *
 * Closes roadmap §1062 ("DoD для K.0 …каждый пункт имеет либо отдельный issue
 * в GitHub, либо `[x]` с реальным real-impl PR-ссылкой") as a deterministic
 * lint we can run from `npm run check-K0-DoD` and from `vibe doctor --full`.
 *
 * Usage:
 *   node scripts/check-K0-DoD.mjs            # warn-only, exit 0
 *   node scripts/check-K0-DoD.mjs --strict   # exit 1 on any non-conforming item
 *   node scripts/check-K0-DoD.mjs --json     # machine-readable
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ROADMAP_PATH = path.join(ROOT, 'docs', 'roadmap.md');

const SECTION_HEADER_RE = /^### K\.0 Псевдо-готовность/;
const NEXT_SECTION_RE = /^### K\.[1-9]/;
const ITEM_RE = /^- \[([ x~])\]\s*(.*)$/;
const COMMIT_RE = /commit `([0-9a-f]{7,40})`/i;
const BLOCKER_HINT_RE = /\b(EV\s*cert|notarization|marketing|sponsors|discord|publicly|public\s+announce|до\s*публичного|cert|account)/i;

function parseArgs(argv) {
	return {
		strict: argv.includes('--strict'),
		json: argv.includes('--json'),
	};
}

function readSection(text) {
	const lines = text.split(/\r?\n/);
	const out = [];
	let inside = false;
	for (const line of lines) {
		if (SECTION_HEADER_RE.test(line)) { inside = true; continue; }
		if (inside && NEXT_SECTION_RE.test(line)) { break; }
		if (inside) { out.push(line); }
	}
	return out;
}

function classifyItem(line) {
	const m = ITEM_RE.exec(line);
	if (!m) { return null; }
	const mark = m[1];
	const body = m[2];
	const commitMatch = COMMIT_RE.exec(body);
	const commit = commitMatch ? commitMatch[1] : null;
	const looksBlocked = BLOCKER_HINT_RE.test(body);

	if (mark === 'x' || mark === '~') {
		if (commit) {
			return { state: 'pass', mark, commit, summary: extractTitle(body) };
		}
		// `[~]` is for partial-impl; if the body carries a blocker hint
		// (EV cert, sponsors approval, marketing launch) the item is still in
		// "infrastructure landed, awaiting external action" — treat as BLOCKED.
		if (mark === '~' && looksBlocked) {
			return { state: 'blocked', mark, commit: null, summary: extractTitle(body) };
		}
		return { state: 'missing-commit', mark, commit: null, summary: extractTitle(body) };
	}
	// mark === ' '
	if (looksBlocked) {
		return { state: 'blocked', mark, commit: null, summary: extractTitle(body) };
	}
	return { state: 'open', mark, commit: null, summary: extractTitle(body) };
}

function extractTitle(body) {
	const boldMatch = /^\*\*(.+?)\*\*/.exec(body);
	if (boldMatch) { return boldMatch[1]; }
	return body.slice(0, 80) + (body.length > 80 ? '…' : '');
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!fs.existsSync(ROADMAP_PATH)) {
		console.error(`[check-K0-DoD] roadmap not found at ${ROADMAP_PATH}`);
		process.exit(args.strict ? 1 : 0);
	}
	const text = fs.readFileSync(ROADMAP_PATH, 'utf8');
	const sectionLines = readSection(text);
	if (sectionLines.length === 0) {
		console.error('[check-K0-DoD] section "### K.0 Псевдо-готовность" not found');
		process.exit(args.strict ? 1 : 0);
	}

	const items = sectionLines
		.map(classifyItem)
		.filter(Boolean);

	const summary = {
		total: items.length,
		pass: items.filter(i => i.state === 'pass').length,
		blocked: items.filter(i => i.state === 'blocked').length,
		open: items.filter(i => i.state === 'open').length,
		missingCommit: items.filter(i => i.state === 'missing-commit').length,
	};
	const violations = items.filter(i => i.state === 'open' || i.state === 'missing-commit');

	if (args.json) {
		console.log(JSON.stringify({ summary, items, violations }, null, 2));
		process.exit(violations.length > 0 && args.strict ? 1 : 0);
	}

	console.log(`[check-K0-DoD] section "### K.0 Псевдо-готовность"`);
	console.log(`  total items: ${summary.total}`);
	console.log(`  pass:        ${summary.pass}  ([x] or [~] with commit hash)`);
	console.log(`  blocked:     ${summary.blocked}  ([ ] with explicit blocker hint)`);
	console.log(`  open:        ${summary.open}  ([ ] without blocker context)`);
	console.log(`  missing:     ${summary.missingCommit}  ([x]/[~] without commit hash)`);
	console.log('');

	if (violations.length === 0) {
		console.log('OK: all K.0 items are either complete with commit ref or explicitly blocked.');
		process.exit(0);
	}

	console.log('Violations:');
	for (const v of violations) {
		const tag = v.state === 'open' ? 'OPEN' : 'NO-COMMIT';
		console.log(`  [${tag}] ${v.summary}`);
	}
	process.exit(args.strict ? 1 : 0);
}

main();
