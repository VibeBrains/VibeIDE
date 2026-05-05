#!/usr/bin/env node
/**
 * vibe snapshot — manage named checkpoints
 *
 * Usage:
 *   node scripts/vibe-snapshot.js --named "before-auth-refactor"
 *   node scripts/vibe-snapshot.js --list
 *   node scripts/vibe-snapshot.js --restore "before-auth-refactor"
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const NAMED = args.find(a => a.startsWith('--named='))?.split('=')[1]
	|| (args.includes('--named') ? args[args.indexOf('--named') + 1] : null);
const RESTORE = args.find(a => a.startsWith('--restore='))?.split('=')[1]
	|| (args.includes('--restore') ? args[args.indexOf('--restore') + 1] : null);
const WORKSPACE = process.cwd();
const snapshotsDir = path.join(WORKSPACE, '.vibe', 'snapshots');
const namedDir = path.join(snapshotsDir, 'named');

function ensureDirs() {
	fs.mkdirSync(snapshotsDir, { recursive: true });
	fs.mkdirSync(namedDir, { recursive: true });
}

if (LIST) {
	ensureDirs();
	const named = fs.existsSync(namedDir)
		? fs.readdirSync(namedDir).filter(f => f.endsWith('.json'))
		: [];
	const auto = fs.existsSync(snapshotsDir)
		? fs.readdirSync(snapshotsDir).filter(f => f.endsWith('.json'))
		: [];

	console.log(`\n📸 VibeIDE Snapshots\n${'─'.repeat(40)}`);
	if (named.length > 0) {
		console.log(`\nNamed (${named.length}):`);
		named.forEach(f => {
			try {
				const data = JSON.parse(fs.readFileSync(path.join(namedDir, f), 'utf-8'));
				console.log(`  📌 ${path.basename(f, '.json').padEnd(30)} | ${new Date(data.createdAt || 0).toISOString()} | ${data.files?.length || 0} files`);
			} catch { console.log(`  📌 ${f}`); }
		});
	}

	console.log(`\nAuto-snapshots: ${auto.length} (last 5):`);
	auto.sort().slice(-5).forEach(f => {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(snapshotsDir, f), 'utf-8'));
			console.log(`  🔖 ${f.slice(0, 30).padEnd(30)} | ${new Date(data.createdAt || 0).toISOString()}`);
		} catch { console.log(`  🔖 ${f}`); }
	});
	process.exit(0);
}

if (NAMED) {
	ensureDirs();
	// Create a named snapshot from git state
	const { execSync } = require('child_process');
	let gitStatus = '';
	try {
		gitStatus = execSync('git status --short', { encoding: 'utf-8', cwd: WORKSPACE }).trim();
	} catch {}

	const snapshot = {
		id: NAMED,
		createdAt: Date.now(),
		label: NAMED,
		gitStatus: gitStatus.split('\n').slice(0, 20),
		files: [], // Phase 1: no file content, just metadata. VibeIDE IDE creates full snapshot.
		_note: 'Named checkpoint created via CLI. For full file snapshot, use VibeIDE → Agent Action History → Save Checkpoint.',
	};

	const outputPath = path.join(namedDir, `${NAMED.replace(/[^a-z0-9-_]/gi, '-')}.json`);
	fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
	console.log(`✅ Named checkpoint "${NAMED}" created: ${outputPath}`);
	process.exit(0);
}

console.log('Usage:\n  vibe snapshot --named "checkpoint-name"\n  vibe snapshot --list\n  vibe snapshot --restore "checkpoint-name"');
