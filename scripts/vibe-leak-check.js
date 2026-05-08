#!/usr/bin/env node
/**
 * vibe leak-check — heuristic disposable hygiene linter for VibeIDE services.
 *
 * Walks src/vs/workbench/contrib/vibeide/** for `.on*` event subscriptions and
 * `setInterval` / `setTimeout` calls that don't appear to be wrapped in
 * `_register(...)` / `DisposableStore` / `MutableDisposable`. Reports candidates
 * for review. Pure regex pass — no AST parser required, deliberately conservative
 * (false negatives over false positives).
 *
 * Usage:
 *   node scripts/vibe-leak-check.js                    # report all suspicious lines
 *   node scripts/vibe-leak-check.js --json
 *   node scripts/vibe-leak-check.js --baseline path    # compare against a baseline
 *   node scripts/vibe-leak-check.js --write-baseline path
 *
 * Exit codes:
 *   0 — no findings or count == baseline
 *   1 — findings exceed baseline (CI gate)
 *
 * Patterns flagged:
 *   - `<obj>.onXxx(...)` not preceded on the same line by `_register(`
 *   - `setInterval(...)` / `setTimeout(...)` whose return is not stored in a
 *     `_register(...)`-wrapped variable
 *   - `new MutableDisposable()` without `_register(`
 *   - `IFileService.watch(uri)` not wrapped in `_register(`
 *
 * False positives the user can ignore: pure subscriptions on local Emitters used
 * inside a single function scope where dispose is implicit, or subscriptions on
 * Emitters whose owner already disposes them. Mark such lines with a trailing
 * `// vibe-leak-check: allow-naked` comment to silence.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function value(name) {
	const idx = args.indexOf(name);
	if (idx < 0 || idx + 1 >= args.length) {
		const eq = args.find(a => a.startsWith(name + '='));
		return eq ? eq.slice(name.length + 1) : null;
	}
	return args[idx + 1];
}

const JSON_OUT = flag('--json');
const BASELINE = value('--baseline');
const WRITE_BASELINE = value('--write-baseline');

const ROOTS = [
	path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide'),
];

const ALLOW_MARKER = /\/\/\s*vibe-leak-check:\s*allow-naked\b/;

const PATTERNS = [
	{
		name: 'event-subscribe-naked',
		// `something.onXxx(handler)` where the same line contains no `_register(`
		regex: /\b(\w+)\.(on[A-Z]\w*)\s*\(/,
		// extra check applied to whole line
		predicate: (line) => /\.(on[A-Z]\w*)\s*\(/.test(line) && !/_register\s*\(/.test(line),
	},
	{
		name: 'setInterval-naked',
		regex: /\bsetInterval\s*\(/,
		predicate: (line) => /\bsetInterval\s*\(/.test(line) && !/_register\s*\(/.test(line),
	},
	{
		name: 'setTimeout-naked',
		regex: /\bsetTimeout\s*\(/,
		predicate: (line) => /\bsetTimeout\s*\(/.test(line) && !/_register\s*\(/.test(line),
	},
	{
		name: 'mutable-disposable-naked',
		regex: /new\s+MutableDisposable\s*\(\s*\)/,
		predicate: (line) => /new\s+MutableDisposable\s*\(\s*\)/.test(line) && !/_register\s*\(/.test(line),
	},
	{
		name: 'fileservice-watch-naked',
		regex: /\.watch\s*\(/,
		predicate: (line) => /\bIFileService\b|\b_fileService\b|\bfileService\b/.test(line) === false
			? false
			: /\.watch\s*\(/.test(line) && !/_register\s*\(/.test(line),
	},
];

function walk(dir, acc = []) {
	if (!fs.existsSync(dir)) return acc;
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'react' || ent.name === 'test') continue;
			walk(p, acc);
		} else if (/\.tsx?$/.test(ent.name)) {
			acc.push(p);
		}
	}
	return acc;
}

function scanFile(filePath) {
	const text = fs.readFileSync(filePath, 'utf-8');
	const lines = text.split(/\r?\n/);
	const findings = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (ALLOW_MARKER.test(line)) continue;
		// Skip comment-only and import lines
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
		if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) continue;

		for (const p of PATTERNS) {
			if (p.regex.test(line) && p.predicate(line)) {
				findings.push({
					file: path.relative(ROOT, filePath),
					line: i + 1,
					pattern: p.name,
					excerpt: line.trim().slice(0, 200),
				});
				break; // only report first matching pattern per line
			}
		}
	}
	return findings;
}

function loadBaseline(file) {
	if (!file) return null;
	try {
		const baseline = JSON.parse(fs.readFileSync(file, 'utf-8'));
		return new Set(baseline.map(f => `${f.file}:${f.line}:${f.pattern}`));
	} catch {
		return null;
	}
}

function main() {
	const all = [];
	for (const r of ROOTS) {
		for (const file of walk(r)) {
			all.push(...scanFile(file));
		}
	}

	if (WRITE_BASELINE) {
		fs.writeFileSync(WRITE_BASELINE, JSON.stringify(all, null, 2) + '\n');
		console.log(`vibe leak-check: wrote ${all.length} findings to baseline ${WRITE_BASELINE}`);
		return 0;
	}

	const baseline = loadBaseline(BASELINE);
	const newFindings = baseline === null
		? all
		: all.filter(f => !baseline.has(`${f.file}:${f.line}:${f.pattern}`));

	if (JSON_OUT) {
		process.stdout.write(JSON.stringify({
			total: all.length,
			baselineCount: baseline === null ? null : baseline.size,
			newCount: newFindings.length,
			findings: all,
		}, null, 2) + '\n');
		return newFindings.length > 0 ? 1 : 0;
	}

	console.log(`vibe leak-check: ${all.length} candidate(s) across ${ROOTS.map(r => path.relative(ROOT, r)).join(', ')}`);
	if (baseline !== null) {
		console.log(`  baseline: ${baseline.size}, new since baseline: ${newFindings.length}`);
	}
	console.log('');
	const list = newFindings.length > 0 ? newFindings : all;
	const display = list.slice(0, 80);
	for (const f of display) {
		console.log(`  ${f.file}:${f.line}  [${f.pattern}]`);
		console.log(`    ${f.excerpt}`);
	}
	if (list.length > display.length) {
		console.log(`  … ${list.length - display.length} more`);
	}
	console.log('');
	console.log('Mark a legitimate naked subscription with `// vibe-leak-check: allow-naked` to silence.');
	return newFindings.length > 0 ? 1 : 0;
}

process.exit(main());
