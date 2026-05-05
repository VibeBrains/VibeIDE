#!/usr/bin/env node
/**
 * vibe audit <commit-hash> — restore full audit context for a commit
 *
 * Usage:
 *   node scripts/vibe-audit.js <commit-hash>
 *   node scripts/vibe-audit.js HEAD
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const HASH = args[0];

if (!HASH) {
	console.error('Usage: node vibe-audit.js <commit-hash>');
	process.exit(1);
}

function resolveHash(hash) {
	try {
		return execSync(`git rev-parse ${hash}`, { encoding: 'utf-8', timeout: 5000 }).trim();
	} catch {
		return hash;
	}
}

function getCommitInfo(hash) {
	try {
		const info = execSync(`git show --stat --format="%H|%s|%an|%ae|%ad|%b" ${hash}`, {
			encoding: 'utf-8', timeout: 5000
		});
		const lines = info.split('\n');
		const [fullHash, subject, author, email, date, ...bodyLines] = lines[0].split('|');
		const body = bodyLines.join('|').trim();
		const stat = lines.slice(1).join('\n').trim();
		return { fullHash, subject, author, email, date, body, stat };
	} catch (e) {
		return null;
	}
}

function loadAuditLog(workspacePath) {
	const auditPath = path.join(workspacePath, '.vibe', 'audit.jsonl');
	if (!fs.existsSync(auditPath)) return [];
	
	try {
		const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
		return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch {
		return [];
	}
}

// Main
const fullHash = resolveHash(HASH);
const commitInfo = getCommitInfo(fullHash);

if (!commitInfo) {
	console.error(`Commit not found: ${HASH}`);
	process.exit(1);
}

console.log(`\n🔍 vibe audit — ${fullHash.slice(0, 12)}\n${'─'.repeat(50)}`);
console.log(`Subject: ${commitInfo.subject}`);
console.log(`Author:  ${commitInfo.author} <${commitInfo.email}>`);
console.log(`Date:    ${commitInfo.date}`);

if (commitInfo.body) {
	console.log(`\nBody:\n${commitInfo.body}`);
}

console.log(`\nFiles changed:\n${commitInfo.stat}`);

// Check if this was an AI commit
const isAI = commitInfo.email?.includes('agent@vibeide') || commitInfo.body?.includes('VibeIDE Agent');
console.log(`\nAI-assisted: ${isAI ? '✅ Yes (VibeIDE Agent)' : '❌ No (manual commit)'}`);

// Look for corresponding audit log entries
const auditLog = loadAuditLog(process.cwd());
if (auditLog.length > 0) {
	// Find entries near commit timestamp
	const commitTime = new Date(commitInfo.date).getTime();
	const nearby = auditLog.filter(e => Math.abs(e.ts - commitTime) < 3600000); // within 1 hour
	if (nearby.length > 0) {
		console.log(`\nAudit log entries near this commit (${nearby.length}):`);
		nearby.slice(-5).forEach(e => {
			console.log(`  [${new Date(e.ts).toISOString()}] ${e.action} ${e.files?.join(', ') || ''}`);
		});
	}
} else {
	console.log('\n💡 No audit log found. Audit logging enabled in VibeIDE Settings → Audit.');
}
