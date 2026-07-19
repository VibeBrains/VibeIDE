#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * vibe agent reset-leases — force-clear orphan execution leases.
 *
 * Reads .vibe/plans/.leases/*.json under the workspace root (default = cwd) and
 * deletes leases that match user-specified criteria. Used after IDE crashes,
 * deleted threads, or any scenario where the lease file outlives the process
 * that wrote it and the threadId-based comparison in IVibePersistedPlanService
 * cannot recover.
 *
 * Usage:
 *   node scripts/vibe-agent-reset-leases.js                        # dry-run, show stale leases
 *   node scripts/vibe-agent-reset-leases.js --force                # delete all stale leases
 *   node scripts/vibe-agent-reset-leases.js --workspace .          # explicit workspace
 *   node scripts/vibe-agent-reset-leases.js --plan-id <id>         # delete the specific lease only
 *   node scripts/vibe-agent-reset-leases.js --thread-id <id>       # delete leases held by a thread
 *   node scripts/vibe-agent-reset-leases.js --max-age-min 5        # treat leases older than N min as stale (default 2)
 *   node scripts/vibe-agent-reset-leases.js --json
 *
 * The script never reads or writes .plan.md content; it only touches the
 * .leases/ directory.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function value(name) {
	const idx = args.indexOf(name);
	if (idx < 0 || idx + 1 >= args.length) {
		const eqArg = args.find(a => a.startsWith(name + '='));
		return eqArg ? eqArg.slice(name.length + 1) : null;
	}
	return args[idx + 1];
}

const WORKSPACE = path.resolve(value('--workspace') ?? '.');
const FORCE = flag('--force');
const JSON_OUT = flag('--json');
const PLAN_ID = value('--plan-id');
const THREAD_ID = value('--thread-id');
const MAX_AGE_MIN = Number.parseInt(value('--max-age-min') ?? '2', 10);

const LEASES_DIR = path.join(WORKSPACE, '.vibe', 'plans', '.leases');
const STALE_THRESHOLD_MS = MAX_AGE_MIN * 60 * 1000;

function readLeaseSafe(filePath) {
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw);
		const stat = fs.statSync(filePath);
		return { ok: true, parsed, mtimeMs: stat.mtimeMs };
	} catch (e) {
		return { ok: false, reason: e.message };
	}
}

function classifyLease(filePath, info, now) {
	const reasons = [];
	const ageMs = now - info.mtimeMs;
	if (info.ok) {
		const heartbeatAt = info.parsed?.heartbeatAt ? new Date(info.parsed.heartbeatAt).getTime() : null;
		const heartbeatAgeMs = heartbeatAt ? now - heartbeatAt : ageMs;
		if (heartbeatAgeMs > STALE_THRESHOLD_MS) {
			reasons.push(`heartbeat older than ${MAX_AGE_MIN} min (${Math.round(heartbeatAgeMs / 1000)}s)`);
		}
		if (PLAN_ID && info.parsed?.planId === PLAN_ID) {
			reasons.push('matches --plan-id');
		}
		if (THREAD_ID && info.parsed?.threadId === THREAD_ID) {
			reasons.push('matches --thread-id');
		}
	} else {
		reasons.push(`lease file unparseable: ${info.reason}`);
	}
	return { filePath, ageMs, info, stale: reasons.length > 0, reasons };
}

function main() {
	if (!fs.existsSync(LEASES_DIR)) {
		const msg = `No leases directory at ${LEASES_DIR}.`;
		if (JSON_OUT) {
			process.stdout.write(JSON.stringify({ workspace: WORKSPACE, leases: [], deleted: [] }) + '\n');
		} else {
			console.log(msg);
		}
		return;
	}

	const now = Date.now();
	const entries = fs.readdirSync(LEASES_DIR, { withFileTypes: true })
		.filter(e => e.isFile() && e.name.endsWith('.json'))
		.map(e => path.join(LEASES_DIR, e.name));

	const classified = entries.map(p => classifyLease(p, readLeaseSafe(p), now));
	const stale = classified.filter(c => c.stale);
	const deleted = [];

	if (FORCE) {
		for (const c of stale) {
			try {
				fs.unlinkSync(c.filePath);
				deleted.push(c.filePath);
			} catch (e) {
				console.error(`Failed to delete ${c.filePath}: ${e.message}`);
			}
		}
	}

	if (JSON_OUT) {
		process.stdout.write(JSON.stringify({
			workspace: WORKSPACE,
			leases: classified.map(c => ({
				file: c.filePath,
				stale: c.stale,
				ageSeconds: Math.round(c.ageMs / 1000),
				reasons: c.reasons,
				planId: c.info.ok ? c.info.parsed?.planId : null,
				threadId: c.info.ok ? c.info.parsed?.threadId : null,
			})),
			deleted,
		}, null, 2) + '\n');
		return;
	}

	console.log(`Workspace: ${WORKSPACE}`);
	console.log(`Leases directory: ${LEASES_DIR}`);
	console.log(`Found ${classified.length} lease file(s); ${stale.length} stale.`);
	console.log('');
	for (const c of classified) {
		const tag = c.stale ? 'STALE' : '  ok ';
		const planId = c.info.ok ? c.info.parsed?.planId : '<unparseable>';
		console.log(`  [${tag}] ${path.basename(c.filePath)}  planId=${planId}  age=${Math.round(c.ageMs / 1000)}s`);
		for (const r of c.reasons) {
			console.log(`         ${r}`);
		}
	}
	if (!FORCE && stale.length > 0) {
		console.log('');
		console.log('Re-run with --force to delete the stale leases above.');
	} else if (FORCE && deleted.length > 0) {
		console.log('');
		console.log(`Deleted ${deleted.length} stale lease(s).`);
	}
}

main();
