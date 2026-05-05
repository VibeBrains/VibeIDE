#!/usr/bin/env node
/**
 * Export persisted agent plan (.plan.md) as an "Implementation plan" Markdown snippet for PR descriptions (GitHub/GitLab checkboxes).
 *
 * Usage:
 *   node scripts/vibe-plan-pr-export.js --file .vibe/plans/agent-plan-xxxx.plan.md
 *   node scripts/vibe-plan-pr-export.js --latest
 *   node scripts/vibe-plan-pr-export.js path/to/x.plan.md
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function usage() {
	console.error(`Usage:
  node scripts/vibe-plan-pr-export.js --file <path/to/*.plan.md>
  node scripts/vibe-plan-pr-export.js --latest
  node scripts/vibe-plan-pr-export.js <path/to/*.plan.md>`);
	process.exit(2);
}

/** @returns {string | undefined} */
function extractMachineJsonBlock(raw) {
	const marker = '<!-- vibe-plan-machine-context';
	const mi = raw.indexOf(marker);
	let slice = raw;
	if (mi !== -1) {
		slice = raw.slice(mi);
	}
	const fence = slice.match(/```json\s*\r?\n([\s\S]*?)```/);
	return fence ? fence[1] : undefined;
}

/** @param {string} raw */
function yamlFrontmatterPlanId(raw) {
	const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return undefined;
	const pm = m[1].match(/^\s*planId:\s*["']?([^"'\\\s]+)["']?\s*$/m);
	return pm ? pm[1].trim() : undefined;
}

/** @param {string} plansDir */
function latestPlanFile(plansDir) {
	if (!fs.existsSync(plansDir)) return undefined;
	const names = fs.readdirSync(plansDir).filter(n => /\.plan\.md$/i.test(n));
	if (!names.length) return undefined;
	let best = null;
	let bestM = 0;
	for (const n of names) {
		const fp = path.join(plansDir, n);
		try {
			const st = fs.statSync(fp);
			if (st.mtimeMs >= bestM) {
				bestM = st.mtimeMs;
				best = fp;
			}
		} catch {}
	}
	return best;
}

function resolveInputPath() {
	if (args.includes('--latest')) {
		const p = latestPlanFile(path.join(process.cwd(), '.vibe', 'plans'));
		if (!p) {
			console.error('No *.plan.md under .vibe/plans');
			process.exit(1);
		}
		return p;
	}
	const fi = args.indexOf('--file');
	if (fi !== -1 && args[fi + 1]) return path.resolve(args[fi + 1]);
	const pos = args.filter(a => !a.startsWith('-'));
	if (pos.length === 1) return path.resolve(pos[0]);
	usage();
}

function main() {
	const fp = resolveInputPath();
	let raw;
	try {
		raw = fs.readFileSync(fp, 'utf-8');
	} catch (e) {
		console.error(`Read failed: ${fp} — ${e.message}`);
		process.exit(1);
	}
	const jsonText = extractMachineJsonBlock(raw);
	if (!jsonText) {
		console.error(`No vibe-plan-machine-context JSON block in ${fp}`);
		process.exit(1);
	}
	let data;
	try {
		data = JSON.parse(jsonText);
	} catch (e) {
		console.error(`Invalid JSON: ${e.message}`);
		process.exit(1);
	}
	if (data.planKind && data.planKind !== 'vibeide.agent-plan') {
		console.error(`Unexpected planKind: ${data.planKind}`);
		process.exit(1);
	}
	const planId = data.planId || yamlFrontmatterPlanId(raw) || 'unknown';
	const steps = Array.isArray(data.steps) ? data.steps : [];
	const lines = [
		'## Implementation plan',
		'',
		`_Source: \`${path.relative(process.cwd(), fp) || fp}\` · \`planId=${planId}\`_`,
		'',
	];
	for (const s of steps.sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0))) {
		const n = s.stepNumber ?? 0;
		const anchor = `plan-step-${String(planId).slice(0, 8)}-${n}`;
		const baseDesc = String(s.description || '').replace(/\s+/g, ' ').trim() || '(no description)';
		const labeled = /^step\s*\d+/i.test(baseDesc) ? baseDesc : `Step ${n}: ${baseDesc}`;
		if (s.disabled) {
			lines.push(`- [ ] <!-- ${anchor} --> ~~${labeled}~~ _(skipped)_`);
			continue;
		}
		const done = String(s.status || '').toLowerCase() === 'done';
		const box = done ? '[x]' : '[ ]';
		lines.push(`- ${box} <!-- ${anchor} --> ${labeled}`);
	}
	if (!steps.length) {
		lines.push('_(no steps in machine JSON)_');
	}
	console.log(lines.join('\n'));
}

main();
