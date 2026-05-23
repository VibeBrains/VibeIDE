#!/usr/bin/env node
// Roadmap V.4 prevention — Test placeholder detector.
//
// Catches test files where ALL asserts are `assert.ok(true, ...)` or
// `assert.strictEqual(1, 1, ...)` — fake-passes copy-pasted from template
// that never validate anything.
//
// Trigger: V.4 incident — 4 files with 14 fake-passes shipped to main.
//
// Exit 0 = no placeholder-only tests; exit 1 = findings printed.

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const testRoots = [
	path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'test'),
];

const ASSERT_LINE_RE = /\bassert\.(?:ok|strictEqual|deepStrictEqual|equal|notStrictEqual|notEqual)\s*\(/;
const TRIVIAL_ASSERT_RE = /\bassert\.(?:ok\s*\(\s*true\b|strictEqual\s*\(\s*1\s*,\s*1\b|equal\s*\(\s*1\s*,\s*1\b|deepStrictEqual\s*\(\s*\{\s*\}\s*,\s*\{\s*\}\s*\))/;
const TEST_KEYWORD_RE = /\b(?:test|it)\s*\(\s*['"`]/;

function* walk(dir) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile() && (full.endsWith('.test.ts') || full.endsWith('.test.js'))) {
			yield full;
		}
	}
}

const findings = [];

for (const root of testRoots) {
	for (const file of walk(root)) {
		const content = fs.readFileSync(file, 'utf8');
		if (!TEST_KEYWORD_RE.test(content)) continue;
		const assertLines = content.split('\n').filter(line => ASSERT_LINE_RE.test(line));
		if (assertLines.length === 0) {
			// File has tests but no asserts — separate red flag.
			findings.push({ file, kind: 'no-asserts', count: 0 });
			continue;
		}
		const trivial = assertLines.filter(line => TRIVIAL_ASSERT_RE.test(line));
		// Flag if ALL assertions are trivial.
		if (trivial.length === assertLines.length && assertLines.length > 0) {
			findings.push({ file, kind: 'all-trivial', count: assertLines.length });
		}
	}
}

if (findings.length === 0) {
	console.log('No placeholder-only tests found.');
	process.exit(0);
}

console.error(`\n${findings.length} test file(s) with placeholder-only asserts:`);
for (const { file, kind, count } of findings) {
	const rel = path.relative(repoRoot, file);
	console.error(`  ${rel}  (${kind}, ${count} assert(s))`);
}
process.exit(1);
