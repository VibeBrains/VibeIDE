#!/usr/bin/env node
/**
 * vibe run --otel-endpoint — export agent actions as OpenTelemetry spans
 *
 * Usage:
 *   node scripts/vibe-otel-export.js --endpoint http://localhost:4318
 *   node scripts/vibe-otel-export.js --endpoint http://jaeger:4318 --session <id>
 *
 * Exports .vibe/audit.jsonl entries as OTLP JSON traces
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
const ENDPOINT = args.find(a => a.startsWith('--endpoint='))?.split('=')[1]
	|| (args.includes('--endpoint') ? args[args.indexOf('--endpoint') + 1] : null);
const SESSION = args.find(a => a.startsWith('--session='))?.split('=')[1]
	|| (args.includes('--session') ? args[args.indexOf('--session') + 1] : null);
const DRY_RUN = args.includes('--dry-run');

if (!ENDPOINT && !DRY_RUN) {
	console.error('Usage: node vibe-otel-export.js --endpoint <url> [--session <id>]');
	console.error('       node vibe-otel-export.js --dry-run  (shows payload without sending)');
	process.exit(1);
}

const WORKSPACE = process.cwd();

function loadAuditLog() {
	const auditPath = path.join(WORKSPACE, '.vibe', 'audit.jsonl');
	if (!fs.existsSync(auditPath)) return [];
	try {
		return fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
			.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}

function generateTraceId() {
	return [...Array(16)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

function generateSpanId() {
	return [...Array(8)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

function eventsToOTLP(events) {
	const traceId = generateTraceId();
	const spans = events.map(event => ({
		traceId,
		spanId: generateSpanId(),
		name: `vibe.agent.${event.action}`,
		kind: 1, // SPAN_KIND_SERVER
		startTimeUnixNano: String(event.ts * 1_000_000),
		endTimeUnixNano: String((event.ts + (event.latencyMs || 0)) * 1_000_000),
		attributes: [
			{ key: 'vibe.action', value: { stringValue: event.action } },
			{ key: 'vibe.ok', value: { boolValue: event.ok } },
			...(event.model ? [{ key: 'vibe.model', value: { stringValue: event.model } }] : []),
			...(event.files ? [{ key: 'vibe.files', value: { stringValue: event.files.join(',') } }] : []),
			...(event.meta?.sessionId ? [{ key: 'vibe.session_id', value: { stringValue: event.meta.sessionId } }] : []),
			...(event.meta?.requestId ? [{ key: 'vibe.request_id', value: { stringValue: event.meta.requestId } }] : []),
		],
		status: { code: event.ok ? 1 : 2 }, // STATUS_CODE_OK or ERROR
	}));

	return {
		resourceSpans: [{
			resource: {
				attributes: [
					{ key: 'service.name', value: { stringValue: 'vibeide' } },
					{ key: 'service.version', value: { stringValue: '1.0.0' } },
				]
			},
			scopeSpans: [{
				scope: { name: 'vibeide.agent', version: '1.0.0' },
				spans,
			}]
		}]
	};
}

// Main
const events = loadAuditLog();
const filtered = SESSION ? events.filter(e => e.meta?.sessionId?.includes(SESSION)) : events;

if (filtered.length === 0) {
	console.log('No audit events found. Enable audit logging in VibeIDE Settings → Audit.');
	process.exit(0);
}

const payload = eventsToOTLP(filtered);
const body = JSON.stringify(payload);

console.log(`\n📡 OTel export: ${filtered.length} spans`);

if (DRY_RUN) {
	console.log('\nPayload preview:');
	console.log(JSON.stringify(payload, null, 2).slice(0, 500) + '...');
	console.log('\n[dry-run] Not sending.');
	process.exit(0);
}

const url = new URL(`${ENDPOINT}/v1/traces`);
const client = url.protocol === 'https:' ? https : http;

const req = client.request({
	hostname: url.hostname,
	port: url.port || (url.protocol === 'https:' ? 443 : 80),
	path: url.pathname,
	method: 'POST',
	headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, res => {
	let data = '';
	res.on('data', d => data += d);
	res.on('end', () => {
		if (res.statusCode >= 200 && res.statusCode < 300) {
			console.log(`✅ Exported ${filtered.length} spans to ${ENDPOINT}`);
		} else {
			console.error(`❌ Export failed: ${res.statusCode} ${data}`);
		}
	});
});

req.on('error', e => { console.error('❌ Connection failed:', e.message); });
req.write(body);
req.end();
