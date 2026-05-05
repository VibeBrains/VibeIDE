#!/usr/bin/env node
/**
 * vibe checkpoint prune — clean up old VibeIDE snapshots
 *
 * Usage:
 *   node scripts/vibe-checkpoint-prune.js --keep-last 50
 *   node scripts/vibe-checkpoint-prune.js --older-than 30d
 *   node scripts/vibe-checkpoint-prune.js --dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function parseArgs() {
	const keepLast = args.find(a => a.startsWith('--keep-last='))?.split('=')[1]
		|| (args.includes('--keep-last') ? args[args.indexOf('--keep-last') + 1] : null);
	const olderThan = args.find(a => a.startsWith('--older-than='))?.split('=')[1]
		|| (args.includes('--older-than') ? args[args.indexOf('--older-than') + 1] : null);

	return {
		keepLast: keepLast ? parseInt(keepLast) : null,
		olderThanDays: olderThan ? parseDuration(olderThan) : null,
	};
}

function parseDuration(str) {
	const match = str.match(/^(\d+)(d|h|w)$/);
	if (!match) return null;
	const [, num, unit] = match;
	const n = parseInt(num);
	switch (unit) {
		case 'd': return n;
		case 'h': return n / 24;
		case 'w': return n * 7;
		default: return null;
	}
}

function pruneSnapshots(snapshotsDir, opts) {
	if (!fs.existsSync(snapshotsDir)) {
		console.log(`No snapshots directory found at ${snapshotsDir}`);
		return { deleted: 0, kept: 0 };
	}

	const files = fs.readdirSync(snapshotsDir)
		.filter(f => f.endsWith('.json') && !f.startsWith('named-'))
		.map(f => {
			const filePath = path.join(snapshotsDir, f);
			const stat = fs.statSync(filePath);
			let createdAt = stat.mtimeMs;

			// Try to read createdAt from snapshot JSON
			try {
				const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
				if (data.createdAt) createdAt = data.createdAt;
			} catch {}

			return { name: f, path: filePath, createdAt, size: stat.size };
		})
		.sort((a, b) => b.createdAt - a.createdAt); // newest first

	const now = Date.now();
	const toDelete = new Set();

	// Apply --older-than filter
	if (opts.olderThanDays !== null) {
		const cutoff = now - opts.olderThanDays * 24 * 60 * 60 * 1000;
		for (const f of files) {
			if (f.createdAt < cutoff) toDelete.add(f.name);
		}
	}

	// Apply --keep-last filter
	if (opts.keepLast !== null) {
		const toKeep = files.slice(0, opts.keepLast).map(f => f.name);
		for (const f of files) {
			if (!toKeep.includes(f.name)) toDelete.add(f.name);
		}
	}

	// If no flags, use default: keep last 50
	if (opts.keepLast === null && opts.olderThanDays === null) {
		console.log('No filter specified. Using default: --keep-last 50');
		for (const f of files.slice(50)) {
			toDelete.add(f.name);
		}
	}

	let deleted = 0;
	let totalFreed = 0;

	for (const f of files) {
		if (toDelete.has(f.name)) {
			totalFreed += f.size;
			if (DRY_RUN) {
				console.log(`  [dry-run] Would delete: ${f.name} (${(f.size / 1024).toFixed(1)}KB)`);
			} else {
				fs.unlinkSync(f.path);
				console.log(`  Deleted: ${f.name} (${(f.size / 1024).toFixed(1)}KB)`);
			}
			deleted++;
		}
	}

	const kept = files.length - deleted;
	console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}Pruned ${deleted} snapshot(s), kept ${kept}. Freed: ${(totalFreed / 1024 / 1024).toFixed(2)}MB`);
	return { deleted, kept };
}

// Main
const workspacePath = args.find(a => a.startsWith('--workspace='))?.split('=')[1]
	|| args[args.indexOf('--workspace') + 1]
	|| process.cwd();

const snapshotsDir = path.join(workspacePath, '.vibe', 'snapshots');
const opts = parseArgs();

console.log(`🗂  vibe checkpoint prune`);
console.log(`Snapshots dir: ${snapshotsDir}`);
if (DRY_RUN) console.log('Mode: dry-run (no files deleted)\n');

pruneSnapshots(snapshotsDir, opts);
