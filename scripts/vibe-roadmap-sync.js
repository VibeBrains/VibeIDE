#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * vibe roadmap-sync — pre-commit warner.
 *
 * Reads the staged file list (or the explicit --files list) and warns when files
 * under src/vs/workbench/contrib/vibeide/** are touched without a corresponding
 * checkbox flip in docs/roadmap.md. Non-blocking — designed for husky / lint-staged
 * to run as a soft reminder, not a gate.
 *
 * Usage:
 *   node scripts/vibe-roadmap-sync.js                    # uses git diff --cached --name-only
 *   node scripts/vibe-roadmap-sync.js --files A B C      # explicit list
 *   node scripts/vibe-roadmap-sync.js --json
 *   node scripts/vibe-roadmap-sync.js --since=HEAD~1     # check a commit range
 *
 * Exit code 0 — always (informational).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ROADMAP = path.join(ROOT, 'docs', 'roadmap.md');
const TARGET_PREFIX = 'src/vs/workbench/contrib/vibeide/';

const args = process.argv.slice(2);
const MODE = {
	json: args.includes('--json'),
	files: null,
	since: null,
};
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--files') {
		MODE.files = args.slice(i + 1).filter(a => !a.startsWith('--'));
		break;
	} else if (args[i].startsWith('--since=')) {
		MODE.since = args[i].slice('--since='.length);
	}
}

function gitOut(cmd) {
	try {
		return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' });
	} catch {
		return '';
	}
}

function stagedFiles() {
	if (MODE.files) {
		return MODE.files.map(f => f.replace(/\\/g, '/'));
	}
	if (MODE.since) {
		const out = gitOut(`git diff --name-only ${MODE.since}..HEAD`);
		return out.split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/'));
	}
	const out = gitOut('git diff --cached --name-only');
	return out.split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/'));
}

function readRoadmap() {
	if (!fs.existsSync(ROADMAP)) {
		return '';
	}
	return fs.readFileSync(ROADMAP, 'utf-8');
}

function classify(files, roadmapText) {
	const touchedVibe = files.filter(f => f.startsWith(TARGET_PREFIX));
	const roadmapTouched = files.includes('docs/roadmap.md');
	const warnings = [];
	for (const f of touchedVibe) {
		const stem = path.basename(f).replace(/\.(ts|tsx|js)$/, '');
		if (stem.length < 6) {
			continue;
		}
		if (!roadmapText.includes(stem) && !roadmapTouched) {
			warnings.push({ file: f, hint: `no mention of '${stem}' in docs/roadmap.md and roadmap not updated this commit` });
		}
	}
	return warnings;
}

function main() {
	const files = stagedFiles();
	const roadmap = readRoadmap();
	const warnings = classify(files, roadmap);

	if (MODE.json) {
		process.stdout.write(JSON.stringify({ warnings }, null, 2) + '\n');
		return;
	}

	if (warnings.length === 0) {
		// silent on success — pre-commit hook noise
		return;
	}

	console.log('vibe roadmap-sync — soft warning:');
	for (const w of warnings) {
		console.log(`  - ${w.file}`);
		console.log(`      ${w.hint}`);
	}
	console.log('');
	console.log('Update docs/roadmap.md (- [ ] → - [x] / - [~]) so future-you can find this work, then re-stage.');
}

main();
