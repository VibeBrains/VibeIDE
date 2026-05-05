#!/usr/bin/env node
/**
 * vibe session replay — replay agent session from audit log
 *
 * Usage:
 *   node scripts/vibe-session-replay.js [--session <id>] [--list]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { buildPlanIdPathMap, collectPlanIdsFromAuditEvents } = require('./lib/vibe-plan-paths.cjs');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const SESSION_ID = args.find(a => a.startsWith('--session='))?.split('=')[1]
	|| (args.includes('--session') ? args[args.indexOf('--session') + 1] : null);

const WORKSPACE = process.cwd();

function loadAuditLog() {
	const paths = [
		path.join(WORKSPACE, '.vibe', 'audit.jsonl'),
		path.join(WORKSPACE, '.vibe', 'audit', 'audit.jsonl'),
	];

	for (const p of paths) {
		if (fs.existsSync(p)) {
			try {
				const lines = fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
				return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
			} catch { return []; }
		}
	}
	return [];
}

function groupBySessions(events) {
	const sessions = {};
	for (const event of events) {
		const sessionId = event.meta?.sessionId || 'unknown';
		if (!sessions[sessionId]) sessions[sessionId] = [];
		sessions[sessionId].push(event);
	}
	return sessions;
}

const events = loadAuditLog();

if (events.length === 0) {
	console.log('No audit log found. Audit logging must be enabled in VibeIDE Settings → Audit.');
	process.exit(0);
}

const sessions = groupBySessions(events);

if (LIST || !SESSION_ID) {
	console.log(`\n📚 Sessions in audit log (${Object.keys(sessions).length}):\n`);
	for (const [id, sessionEvents] of Object.entries(sessions)) {
		const first = sessionEvents[0];
		const last = sessionEvents[sessionEvents.length - 1];
		const duration = Math.round((last.ts - first.ts) / 1000);
		console.log(`  ${id.slice(0, 16).padEnd(16)} | ${new Date(first.ts).toISOString()} | ${sessionEvents.length} events | ${duration}s`);
	}
	console.log('\nRun with --session <id> to replay a specific session.');
	process.exit(0);
}

const session = sessions[SESSION_ID] || Object.entries(sessions).find(([id]) => id.includes(SESSION_ID))?.[1];
if (!session) {
	console.error(`Session not found: ${SESSION_ID}`);
	process.exit(1);
}

console.log(`\n▶️  Replaying session: ${SESSION_ID}\n${'─'.repeat(50)}`);

const planPathById = buildPlanIdPathMap(WORKSPACE);
const planIdsInSession = collectPlanIdsFromAuditEvents(session);
if (planIdsInSession.size > 0) {
	console.log('\n📎 Persisted plan files (meta.planId → .vibe/plans):');
	for (const pid of planIdsInSession) {
		const rel = planPathById[pid];
		console.log(`   ${pid} → ${rel ?? '(no matching *.plan.md in workspace)'}`);
	}
}

session.forEach((event, i) => {
	const time = new Date(event.ts).toISOString().split('T')[1].slice(0, 8);
	const files = event.files?.join(', ') || '';
	const model = event.model ? ` [${event.model}]` : '';
	const status = event.ok ? '✅' : '❌';
	console.log(`  ${(i + 1).toString().padStart(3)}. ${time} ${status} ${event.action}${model}${files ? ` — ${files}` : ''}`);
	if (event.meta?.requestId) console.log(`       requestId: ${event.meta.requestId}`);
});

console.log(`\n📊 Summary: ${session.length} events`);
console.log(`   Duration: ${Math.round((session[session.length-1].ts - session[0].ts) / 1000)}s`);
console.log(`   Models used: ${[...new Set(session.filter(e => e.model).map(e => e.model))].join(', ') || 'none recorded'}`);
