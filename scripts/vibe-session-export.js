#!/usr/bin/env node
/**
 * vibe session export/import — session handoff between team members
 *
 * Usage:
 *   node scripts/vibe-session-export.js --session <id> --output session.json
 *   node scripts/vibe-session-export.js --all --output full-export.json
 *   node scripts/vibe-session-export.js --compliance --since 2026-01-01 --output report.json --embed-plan-steps
 *   node scripts/vibe-session-export.js --anonymize  (strip paths/usernames)
 *   node scripts/vibe-session-export.js --delete-all  (GDPR erasure)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
	buildPlanIdPathMap,
	collectPlanIdsFromAuditEvents,
	extractStepsFromPlanMarkdown,
} = require('./lib/vibe-plan-paths.cjs');

const args = process.argv.slice(2);
const SESSION = args.find(a => a.startsWith('--session='))?.split('=')[1]
	|| (args.includes('--session') ? args[args.indexOf('--session') + 1] : null);
const OUTPUT = args.find(a => a.startsWith('--output='))?.split('=')[1]
	|| (args.includes('--output') ? args[args.indexOf('--output') + 1] : null)
	|| 'vibe-export.json';
const SINCE = args.find(a => a.startsWith('--since='))?.split('=')[1]
	|| (args.includes('--since') ? args[args.indexOf('--since') + 1] : null);
const ALL = args.includes('--all');
const COMPLIANCE = args.includes('--compliance');
const ANONYMIZE = args.includes('--anonymize');
const DELETE_ALL = args.includes('--delete-all');
const EMBED_PLAN_STEPS = args.includes('--embed-plan-steps');

const WORKSPACE = process.cwd();

function loadAuditLog() {
	const auditPath = path.join(WORKSPACE, '.vibe', 'audit.jsonl');
	if (!fs.existsSync(auditPath)) return [];
	try {
		return fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
			.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}

function anonymize(obj) {
	const str = JSON.stringify(obj);
	const home = process.env.HOME || process.env.USERPROFILE || '';
	const username = process.env.USER || process.env.USERNAME || '';
	const workspace = WORKSPACE;
	let result = str;
	if (workspace) result = result.split(workspace).join('<workspace>');
	if (home) result = result.split(home).join('<home>');
	if (username) result = result.split(username).join('<user>');
	return JSON.parse(result);
}

if (DELETE_ALL) {
	console.log('⚠️  GDPR erasure: deleting all audit logs...');
	const auditPath = path.join(WORKSPACE, '.vibe', 'audit.jsonl');
	const snapshotsDir = path.join(WORKSPACE, '.vibe', 'snapshots');
	let deleted = 0;
	if (fs.existsSync(auditPath)) { fs.unlinkSync(auditPath); deleted++; }
	if (fs.existsSync(snapshotsDir)) {
		fs.readdirSync(snapshotsDir).forEach(f => {
			fs.unlinkSync(path.join(snapshotsDir, f)); deleted++;
		});
	}
	console.log(`✅ Deleted ${deleted} files. All audit data removed (GDPR right to erasure).`);
	process.exit(0);
}

const events = loadAuditLog();

// Filter events
let filtered = events;
if (SESSION) {
	filtered = events.filter(e => e.meta?.sessionId?.includes(SESSION));
}
if (SINCE) {
	const since = new Date(SINCE).getTime();
	filtered = filtered.filter(e => e.ts >= since);
}

if (ANONYMIZE) {
	filtered = filtered.map(e => anonymize(e));
}

const planPathById = buildPlanIdPathMap(WORKSPACE);
const planIdsInExport = collectPlanIdsFromAuditEvents(filtered);
/** @type {{ planId: string, relativePath?: string, steps?: ReturnType<typeof extractStepsFromPlanMarkdown> }[]} */
const persistedPlanArtifacts = [...planIdsInExport].map(pid => {
	const rel = planPathById[pid];
	/** @type {{ planId: string, relativePath?: string, steps?: ReturnType<typeof extractStepsFromPlanMarkdown> }} */
	const row = { planId: pid };
	if (rel) {
		row.relativePath = rel;
	}
	if (rel && EMBED_PLAN_STEPS) {
		try {
			const raw = fs.readFileSync(path.join(WORKSPACE, rel), 'utf8');
			const steps = extractStepsFromPlanMarkdown(raw);
			if (steps) {
				row.steps = steps;
			}
		} catch { /* ignore */ }
	}
	return row;
});

const export_data = {
	exportedAt: new Date().toISOString(),
	workspace: ANONYMIZE ? '<workspace>' : WORKSPACE,
	vibeVersion: '1.0.0',
	type: COMPLIANCE ? 'compliance_report' : SESSION ? 'session_handoff' : 'full_export',
	events: filtered,
	persistedPlanArtifacts: persistedPlanArtifacts.length ? persistedPlanArtifacts : undefined,
	summary: {
		totalEvents: filtered.length,
		aiActions: filtered.filter(e => ['apply', 'prompt', 'diff_preview'].includes(e.action)).length,
		filesModified: [...new Set(filtered.flatMap(e => e.files || []))].length,
		models: [...new Set(filtered.filter(e => e.model).map(e => e.model))],
		dateRange: filtered.length > 0 ? {
			from: new Date(Math.min(...filtered.map(e => e.ts))).toISOString(),
			to: new Date(Math.max(...filtered.map(e => e.ts))).toISOString(),
		} : null,
	}
};

if (!OUTPUT || OUTPUT === '-') {
	console.log(JSON.stringify(export_data, null, 2));
} else {
	fs.writeFileSync(OUTPUT, JSON.stringify(export_data, null, 2));
	console.log(`✅ Exported ${filtered.length} events to ${OUTPUT}`);
	console.log(`   Type: ${export_data.type}`);
	if (ANONYMIZE) console.log('   Anonymized: paths and usernames replaced with placeholders');
}

console.log('\n⚠️  GDPR note: after sharing this export, VibeIDE cannot guarantee deletion at the recipient side.');
