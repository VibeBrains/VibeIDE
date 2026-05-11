#!/usr/bin/env node
// Copyright 2026 VibeIDE Team. MIT License.
//
// Default runner skeleton for IVibeBackgroundAgentRuntime (roadmap §L884).
// Speaks the JSON-line envelope protocol defined in
// `src/vs/workbench/contrib/vibeide/common/backgroundAgentIPC.ts`:
//   - reads inbound envelopes from stdin (one JSON object per line)
//   - writes outbound envelopes to stdout (one JSON object per line)
//
// This skeleton emits `ready`, echoes received tasks as `progress`, and
// terminates with `done(success)` on `abort` or when stdin closes. Replace
// the body of `runTask()` with the real subagent loop.

'use strict';

const PROTOCOL_VERSION = 1;
const sessionId = process.env.VIBE_AGENT_SESSION_ID || '<unknown>';

function emit(type, payload) {
	const env = { type, version: PROTOCOL_VERSION, correlationId: sessionId, payload: payload ?? null };
	try {
		process.stdout.write(JSON.stringify(env) + '\n');
	} catch (e) {
		// stdout closed — fail silently; parent will see exit code.
	}
}

emit('ready', { protocol: PROTOCOL_VERSION, scriptVersion: 'skeleton-1' });

let stepsCompleted = 0;
let lineBuf = '';
let aborting = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	lineBuf += chunk;
	let nl = lineBuf.indexOf('\n');
	while (nl >= 0) {
		const line = lineBuf.slice(0, nl).trim();
		lineBuf = lineBuf.slice(nl + 1);
		nl = lineBuf.indexOf('\n');
		if (line.length === 0) continue;
		handleLine(line);
	}
});

process.stdin.on('end', () => {
	if (!aborting) {
		emit('done', { outcome: 'success', stepsCompleted });
	}
	process.exit(0);
});

function handleLine(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		emit('error', { reason: 'malformed-inbound', preview: line.slice(0, 120) });
		return;
	}
	if (!parsed || typeof parsed !== 'object') return;
	const type = parsed.type;
	switch (type) {
		case 'start':
			runTask(parsed.payload && parsed.payload.task);
			break;
		case 'pause':
			emit('log', { level: 'info', message: 'received pause request — skeleton noop' });
			break;
		case 'resume':
			emit('log', { level: 'info', message: 'received resume request — skeleton noop' });
			break;
		case 'abort':
			aborting = true;
			emit('done', { outcome: 'failure', stepsCompleted, reason: 'aborted' });
			setTimeout(() => process.exit(0), 50);
			break;
		default:
			emit('error', { reason: 'unknown-inbound-type', type: String(type) });
			break;
	}
}

function runTask(task) {
	const taskStr = typeof task === 'string' ? task : '';
	emit('progress', { phase: 'started', stepsCompleted, taskBytes: Buffer.byteLength(taskStr, 'utf8') });
	stepsCompleted += 1;
	// Skeleton: immediately mark done. Real implementation drives a subagent loop
	// here, emitting `progress` on each step and `tool-request` / `tool-result`
	// envelopes as needed.
	emit('done', { outcome: 'success', stepsCompleted });
	setTimeout(() => process.exit(0), 50);
}
