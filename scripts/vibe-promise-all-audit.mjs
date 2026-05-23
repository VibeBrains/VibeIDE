#!/usr/bin/env node
// Roadmap V.1 prevention — `Promise.all` on side-effecting callbacks audit.
//
// `Promise.all([...])` over inner callbacks with side effects (state writes,
// finally-cleanup) can race when one resolves first and the others' cleanup
// is skipped on rejection. V.1 incident (MCP race) was this class. Replace
// with `Promise.allSettled` or per-callback try/finally.
//
// Heuristic: matches `Promise.all([...])` where the inline array body
// contains await-arrow patterns mutating `this.X = ...` or calling
// .finally/.catch on inner promises.
//
// This is a soft signal — not every Promise.all is wrong. Findings are a
// review hint, not auto-fail. Run with `--strict` to fail CI.

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const codeRoot = path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
if (!fs.existsSync(codeRoot)) {
	console.error(`directory not found: ${codeRoot}`);
	process.exit(2);
}

const STRICT = process.argv.includes('--strict');

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === '.build') continue;
			yield* walk(full);
		} else if (entry.isFile() && full.endsWith('.ts')) {
			yield full;
		}
	}
}

const PROMISE_ALL_RE = /Promise\.all\s*\(/g;
const SIDE_EFFECT_HINT_RE = /this\._?\w+\s*=|finally\s*\{|\.then\s*\(\s*\(\s*\)\s*=>|catch\s*\(\s*\(\s*\)\s*=>/;
const WINDOW = 20; // lines of context to inspect after `Promise.all(`

let findings = 0;

for (const file of walk(codeRoot)) {
	const content = fs.readFileSync(file, 'utf8');
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		if (!PROMISE_ALL_RE.test(lines[i])) {
			PROMISE_ALL_RE.lastIndex = 0;
			continue;
		}
		PROMISE_ALL_RE.lastIndex = 0;
		const window = lines.slice(i, Math.min(i + WINDOW, lines.length)).join('\n');
		if (SIDE_EFFECT_HINT_RE.test(window)) {
			findings += 1;
			const rel = path.relative(repoRoot, file);
			console.log(`${rel}:${i + 1}  Promise.all with side-effect-shaped callback`);
			console.log(`    ${lines[i].trim()}`);
		}
	}
}

if (findings === 0) {
	console.log('Promise.all audit clean.');
	process.exit(0);
}

console.log(`\n${findings} finding(s). Each is a review hint — Promise.allSettled or per-callback try/finally may be safer.`);
process.exit(STRICT ? 1 : 0);
