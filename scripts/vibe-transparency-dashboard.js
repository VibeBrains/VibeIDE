#!/usr/bin/env node
/**
 * vibe transparency dashboard — generate public transparency report
 * Shows what VibeIDE sends externally in each mode.
 * Used to auto-update transparency dashboard page on website.
 *
 * Usage:
 *   node scripts/vibe-transparency-dashboard.js --output dashboard.json
 *   node scripts/vibe-transparency-dashboard.js --markdown > TRANSPARENCY.md
 *   node scripts/vibe-transparency-dashboard.js --model-usage --audit-log=.vibe/audit.jsonl
 *   node scripts/vibe-transparency-dashboard.js --model-usage --audit-log=.vibe/audit.jsonl --days=30
 */

'use strict';

const args = process.argv.slice(2);
const OUTPUT = args.find(a => a.startsWith('--output='))?.split('=')[1]
	|| (args.includes('--output') ? args[args.indexOf('--output') + 1] : null);
const MARKDOWN = args.includes('--markdown');
const MODEL_USAGE = args.includes('--model-usage');
const AUDIT_LOG = args.find(a => a.startsWith('--audit-log='))?.split('=').slice(1).join('=')
	|| (args.includes('--audit-log') ? args[args.indexOf('--audit-log') + 1] : null);
const DAYS = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || '7', 10);
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { aggregateModelUsage, renderUsageMarkdown } = require('./lib/model-usage-aggregator.cjs');

function getVersion() {
	try {
		const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
		return pkg.vibeVersion || pkg.version || 'unknown';
	} catch { return 'unknown'; }
}

const dashboard = {
	generatedAt: new Date().toISOString(),
	ideVersion: getVersion(),
	modes: {
		byok: {
			name: 'BYOK (Bring Your Own Key)',
			description: 'Default mode. Your keys, your data.',
			externalRequests: [
				{ destination: 'LLM Provider (Anthropic/OpenAI/etc.)', data: 'Code context + prompts', purpose: 'AI assistance', canDisable: false },
				{ destination: 'registry.vibeide.io', data: 'GET /models.json (no code)', purpose: 'Model list refresh', canDisable: true },
				{ destination: 'LLM Provider', data: 'Embeddings for RAG (code)', purpose: 'Semantic search', canDisable: true },
			]
		},
		privacy: {
			name: 'Privacy/Offline Mode',
			description: 'Nothing leaves your machine.',
			externalRequests: [
				{ destination: 'None', data: 'N/A', purpose: 'N/A', canDisable: false }
			]
		},
		gateway: {
			name: 'Gateway Mode (Phase 2)',
			description: 'Convenience proxy. Routing metadata only — no prompts stored.',
			externalRequests: [
				{ destination: 'vibe-gateway (VibeIDE proxy)', data: 'Routing metadata only (no prompts)', purpose: 'API key management', canDisable: true },
				{ destination: 'LLM Provider', data: 'Code context + prompts', purpose: 'AI assistance', canDisable: false },
			]
		}
	},
	alwaysLocal: [
		'.vibe/audit.jsonl (audit log)',
		'.vibe/snapshots/ (rollback points)',
		'.vibe/context.md (project brain)',
		'API keys (encrypted via OS keychain)',
	],
	neverSent: [
		'API keys (encrypted client-side)',
		'Workspace contents in offline mode',
		'Audit logs',
		'Snapshots',
	]
};

if (MODEL_USAGE) {
	if (!AUDIT_LOG) {
		console.error('❌  --audit-log=<path> is required with --model-usage');
		process.exit(1);
	}
	const auditPath = path.resolve(AUDIT_LOG);
	let events = [];
	try {
		const raw = fs.readFileSync(auditPath, 'utf-8');
		for (const line of raw.split('\n')) {
			const t = line.trim();
			if (!t) continue;
			try {
				const obj = JSON.parse(t);
				if (obj.action === 'reply' && obj.ok && obj.meta) {
					// Normalise audit record into ModelUsageEvent shape
					const meta = obj.meta;
					const [provider, modelId] = typeof meta.model === 'string'
						? meta.model.split('/').length >= 2
							? [meta.model.split('/')[0], meta.model.split('/').slice(1).join('/')]
							: [meta.model, 'unknown']
						: ['unknown', 'unknown'];
					events.push({
						timestamp: typeof obj.ts === 'number' ? obj.ts : Date.now(),
						provider,
						modelId,
						kind: 'chat',
						inputTokens: typeof meta.inputTokens === 'number' ? meta.inputTokens : 0,
						outputTokens: typeof meta.outputTokens === 'number' ? meta.outputTokens : 0,
					});
				}
			} catch { /* skip malformed line */ }
		}
	} catch (e) {
		console.error(`❌  Cannot read audit log at ${auditPath}: ${e.message}`);
		process.exit(1);
	}

	const now = Date.now();
	const periodStart = now - (DAYS * 24 * 60 * 60 * 1000);
	const agg = aggregateModelUsage(events, periodStart, now);

	if (OUTPUT) {
		fs.writeFileSync(OUTPUT, JSON.stringify(agg, null, 2));
		console.log(`✅ Model usage report written to ${OUTPUT}`);
	} else if (MARKDOWN) {
		console.log(renderUsageMarkdown(agg));
	} else {
		console.log(JSON.stringify(agg, null, 2));
	}
} else if (MARKDOWN) {
	console.log(`# VibeIDE Transparency Dashboard`);
	console.log(`\n> Generated: ${dashboard.generatedAt} | Version: ${dashboard.ideVersion}`);
	console.log(`\n## What VibeIDE sends externally\n`);
	for (const [modeKey, mode] of Object.entries(dashboard.modes)) {
		console.log(`### ${mode.name}`);
		console.log(`> ${mode.description}\n`);
		console.log('| Destination | Data | Purpose | Can disable? |');
		console.log('|-------------|------|---------|--------------|');
		mode.externalRequests.forEach(r => {
			console.log(`| ${r.destination} | ${r.data} | ${r.purpose} | ${r.canDisable ? '✅ Yes' : '❌ Required'} |`);
		});
		console.log('');
	}
	console.log(`## Always local\n`);
	dashboard.alwaysLocal.forEach(item => console.log(`- ${item}`));
	console.log(`\n## Never sent externally\n`);
	dashboard.neverSent.forEach(item => console.log(`- ${item}`));
} else if (OUTPUT) {
	fs.writeFileSync(OUTPUT, JSON.stringify(dashboard, null, 2));
	console.log(`✅ Transparency dashboard written to ${OUTPUT}`);
} else {
	console.log(JSON.stringify(dashboard, null, 2));
}
