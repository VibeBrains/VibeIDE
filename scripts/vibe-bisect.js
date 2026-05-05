#!/usr/bin/env node
/**
 * vibe bisect — binary search through .vibe/snapshots/ to find when a bug appeared
 *
 * Usage:
 *   node scripts/vibe-bisect.js good <snapshot-id> bad <snapshot-id>
 *   node scripts/vibe-bisect.js --list   # list available snapshots
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const WORKSPACE = process.cwd();
const snapshotsDir = path.join(WORKSPACE, '.vibe', 'snapshots');

function listSnapshots() {
	if (!fs.existsSync(snapshotsDir)) return [];
	return fs.readdirSync(snapshotsDir)
		.filter(f => f.endsWith('.json'))
		.map(f => {
			try {
				const data = JSON.parse(fs.readFileSync(path.join(snapshotsDir, f), 'utf-8'));
				return { id: data.id || f, createdAt: data.createdAt || 0, files: data.files?.length || 0 };
			} catch { return null; }
		})
		.filter(Boolean)
		.sort((a, b) => a.createdAt - b.createdAt);
}

if (args.includes('--list')) {
	const snapshots = listSnapshots();
	if (snapshots.length === 0) {
		console.log('No snapshots found in .vibe/snapshots/');
	} else {
		console.log(`\nAvailable snapshots (${snapshots.length}):\n`);
		snapshots.forEach(s => {
			console.log(`  ${s.id.slice(0, 20).padEnd(20)} | ${new Date(s.createdAt).toISOString()} | ${s.files} files`);
		});
	}
	process.exit(0);
}

const goodIdx = args.indexOf('good');
const badIdx = args.indexOf('bad');

if (goodIdx === -1 || badIdx === -1) {
	console.log('Usage:\n  node vibe-bisect.js good <id> bad <id>\n  node vibe-bisect.js --list');
	process.exit(0);
}

const goodId = args[goodIdx + 1];
const badId = args[badIdx + 1];

const snapshots = listSnapshots();
const goodIdx2 = snapshots.findIndex(s => s.id.includes(goodId));
const badIdx2 = snapshots.findIndex(s => s.id.includes(badId));

if (goodIdx2 === -1 || badIdx2 === -1) {
	console.error(`Snapshot not found. Run: node vibe-bisect.js --list`);
	process.exit(1);
}

const range = snapshots.slice(Math.min(goodIdx2, badIdx2), Math.max(goodIdx2, badIdx2) + 1);

console.log(`\n🔍 vibe bisect — searching ${range.length} snapshots\n${'─'.repeat(50)}`);
console.log(`Good: ${snapshots[goodIdx2].id.slice(0, 20)} (${new Date(snapshots[goodIdx2].createdAt).toISOString()})`);
console.log(`Bad:  ${snapshots[badIdx2].id.slice(0, 20)} (${new Date(snapshots[badIdx2].createdAt).toISOString()})`);

async function runBisect() {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (q) => new Promise(r => rl.question(q, r));

	let lo = 0;
	let hi = range.length - 1;

	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const snapshot = range[mid];

		console.log(`\nTesting snapshot ${mid + 1}/${range.length}:`);
		console.log(`  ID: ${snapshot.id.slice(0, 30)}`);
		console.log(`  Date: ${new Date(snapshot.createdAt).toISOString()}`);
		console.log(`  Files: ${snapshot.files}`);
		console.log('\n  Restore this snapshot and test if the bug is present.');
		console.log('  To restore: check .vibe/snapshots/ and load in VibeIDE Agent Action History.\n');

		const answer = await ask('  Is the bug present in this snapshot? (y/n/q): ');
		if (answer.toLowerCase() === 'q') { console.log('Bisect aborted.'); break; }

		if (answer.toLowerCase() === 'y') {
			hi = mid; // bug exists here, look earlier
		} else {
			lo = mid + 1; // bug not here, look later
		}
	}

	const culprit = range[lo];
	console.log(`\n✅ Bug introduced in snapshot:\n  ${culprit.id}\n  ${new Date(culprit.createdAt).toISOString()}`);
	rl.close();
}

runBisect().catch(e => { console.error(e); process.exit(1); });
