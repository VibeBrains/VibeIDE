#!/usr/bin/env node
// Roadmap §"settings styling audit" — canonical naming check for `vibeide.*`.
//
// Canonical style: `vibeide.<domain>.<feature>.<property>` where every
// segment is lowerCamelCase (no kebab, no snake, no PascalCase initial).
// Examples that PASS:
//   vibeide.chat.compactToolResultsAfterTurns
//   vibeide.diagnostics.idleWatchdog.intervalMinutes
// Examples that FAIL:
//   vibeide.chat.compact_tool_results_after_turns      (snake)
//   vibeide.chat.compact-tool-results-after-turns      (kebab)
//   vibeide.Chat.intervalMinutes                       (PascalCase domain)
//   vibeide.diagnostics.idle_watchdog.intervalMinutes  (mixed style)
//
// Run with `--strict` to fail CI on violations. Default mode is informational
// (lists violations + suggested fixes).

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const configFiles = [
	path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common', 'vibeideGlobalSettingsConfiguration.ts'),
];

const STRICT = process.argv.includes('--strict');
const KEY_RE = /['"`](vibeide\.[a-zA-Z_$][\w$.-]*)['"`]\s*:\s*\{/g;
const CANONICAL_SEGMENT_RE = /^[a-z][a-zA-Z0-9]*$/;

const findings = [];

function checkKey(key) {
	const segments = key.split('.');
	if (segments.length < 2) return ['root segment only — needs at least `vibeide.<domain>.<property>`'];
	if (segments[0] !== 'vibeide') return [`unexpected root: ${segments[0]} (must be 'vibeide')`];
	const issues = [];
	for (let i = 1; i < segments.length; i += 1) {
		const seg = segments[i];
		if (!CANONICAL_SEGMENT_RE.test(seg)) {
			let suggested = seg;
			if (seg.includes('_')) suggested = seg.split('_').map((p, idx) => idx === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');
			else if (seg.includes('-')) suggested = seg.split('-').map((p, idx) => idx === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');
			else if (seg[0] === seg[0].toUpperCase()) suggested = seg[0].toLowerCase() + seg.slice(1);
			issues.push(`segment '${seg}' not lowerCamelCase → suggest '${suggested}'`);
		}
	}
	return issues;
}

for (const file of configFiles) {
	if (!fs.existsSync(file)) continue;
	const content = fs.readFileSync(file, 'utf8');
	for (const m of content.matchAll(KEY_RE)) {
		const key = m[1];
		const issues = checkKey(key);
		if (issues.length > 0) {
			findings.push({ file: path.relative(repoRoot, file), key, issues });
		}
	}
}

if (findings.length === 0) {
	console.log('Settings naming audit clean.');
	process.exit(0);
}

console.log(`\n${findings.length} key(s) violate canonical naming style:`);
for (const { file, key, issues } of findings) {
	console.log(`\n  ${key}  (${file})`);
	for (const issue of issues) console.log(`    - ${issue}`);
}
console.log(`\nCanonical style: vibeide.<domain>.<feature>.<property> — every segment lowerCamelCase.`);

process.exit(STRICT ? 1 : 0);
