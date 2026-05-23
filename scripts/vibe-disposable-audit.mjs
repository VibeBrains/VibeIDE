#!/usr/bin/env node
// Roadmap W.16 — Disposable / timer leak detector.
//
// Greps `src/vs/workbench/contrib/vibeide/` for `setInterval(` / `setTimeout(`
// without a nearby (`±50` lines) `clearInterval` / `clearTimeout` / `dispose`
// / `disposableTimeout` / `MutableDisposable`. Catches the V.3 / W.0 class
// of bugs (timers that outlive their owner).
//
// Exit 0 = no findings. Exit 1 = findings printed; integrate into CI as a
// soft gate (warn on regressions) or hard gate (fail PR with new findings).

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'vibeide');
if (!fs.existsSync(root)) {
	console.error(`directory not found: ${root}`);
	process.exit(2);
}

const TIMER_RE = /\bsetInterval\s*\(|\bsetTimeout\s*\(/g;
const CLEAR_HINT_RE = /\bclearInterval\s*\(|\bclearTimeout\s*\(|\bdispose\b|\bdisposableTimeout\b|\bdisposableInterval\b|\bMutableDisposable\b|\bthis\._register\b/;
const WINDOW = 50;

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === '.build') continue;
			yield* walk(full);
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			yield full;
		}
	}
}

const findings = [];
for (const file of walk(root)) {
	const text = fs.readFileSync(file, 'utf-8');
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!TIMER_RE.test(lines[i])) { TIMER_RE.lastIndex = 0; continue; }
		TIMER_RE.lastIndex = 0;
		const start = Math.max(0, i - WINDOW);
		const end = Math.min(lines.length, i + WINDOW + 1);
		const ctx = lines.slice(start, end).join('\n');
		if (CLEAR_HINT_RE.test(ctx)) continue;
		findings.push({ file: path.relative(process.cwd(), file), line: i + 1, snippet: lines[i].trim() });
	}
}

if (findings.length === 0) {
	console.log(`OK — no untracked timers in ${root}`);
	process.exit(0);
}
console.error(`Found ${findings.length} suspicious timer(s) without nearby cleanup:`);
for (const f of findings) {
	console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
}
process.exit(1);
