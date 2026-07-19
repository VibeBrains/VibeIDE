#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * vibe services-inventory — list every vibe*Service.ts and check it is mentioned
 * in docs/roadmap.md. Surfaces "orphan" services that have no roadmap row.
 *
 * Usage:
 *   node scripts/vibe-services-inventory.js              # human-readable table
 *   node scripts/vibe-services-inventory.js --json       # JSON
 *   node scripts/vibe-services-inventory.js --orphans    # only services without a roadmap mention
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
const ROADMAP = path.join(ROOT, 'docs', 'roadmap.md');

const args = process.argv.slice(2);
const MODE = {
	json: args.includes('--json'),
	orphansOnly: args.includes('--orphans'),
};

/** @param {string} dir @param {string[]} acc */
function walk(dir, acc = []) {
	if (!fs.existsSync(dir)) {
		return acc;
	}
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'react') {
				continue;
			}
			walk(p, acc);
		} else if (/Service\.ts$/i.test(ent.name) && /^vibe/i.test(ent.name)) {
			acc.push(p);
		}
	}
	return acc;
}

function readRoadmap() {
	if (!fs.existsSync(ROADMAP)) {
		return '';
	}
	return fs.readFileSync(ROADMAP, 'utf-8');
}

function classify(filePath, roadmapText) {
	const base = path.basename(filePath);
	const stem = base.replace(/\.ts$/, '');
	const className = stem.replace(/^vibe/i, 'Vibe').replace(/Service$/, 'Service');
	// Mention is one of: file basename, stem, exported class name, or interface I<className>.
	const probes = new Set([
		base,
		stem,
		className,
		'I' + className.replace(/^Vibe/, 'Vibe'),
	]);
	let mentioned = false;
	for (const probe of probes) {
		if (probe.length < 6) {
			continue; // avoid spurious matches
		}
		if (roadmapText.includes(probe)) {
			mentioned = true;
			break;
		}
	}
	return { file: path.relative(ROOT, filePath), stem, className, mentioned };
}

function main() {
	const services = walk(SRC_ROOT).sort();
	const roadmap = readRoadmap();
	const rows = services.map(s => classify(s, roadmap));
	const orphans = rows.filter(r => !r.mentioned);

	if (MODE.json) {
		const out = MODE.orphansOnly ? orphans : rows;
		process.stdout.write(JSON.stringify(out, null, 2) + '\n');
		return;
	}

	const list = MODE.orphansOnly ? orphans : rows;
	const totalServices = rows.length;
	const totalOrphans = orphans.length;

	console.log(`Vibe services inventory — ${totalServices} files, ${totalOrphans} not mentioned in docs/roadmap.md`);
	console.log('');
	for (const r of list) {
		const tag = r.mentioned ? '  ' : '!!';
		console.log(`${tag} ${r.file}`);
	}
	if (!MODE.orphansOnly && totalOrphans > 0) {
		console.log('');
		console.log(`!! marks services that the roadmap does not mention. Run with --orphans for the short list.`);
	}
}

main();
