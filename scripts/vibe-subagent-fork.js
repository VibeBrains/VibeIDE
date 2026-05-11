#!/usr/bin/env node
// Copyright 2026 VibeIDE Team. MIT License.
//
// Default child_process.fork entry script for IVibeSubagentIsolationRuntime
// (roadmap §L883). Mirrors `vibe-subagent-worker.js` but runs in a full
// forked process and accepts the parent handoff via `process.on('message')`
// (IPC) plus environment variables. Host runtime captures stdout/stderr.

'use strict';

const invocationId = process.env.VIBE_SUBAGENT_INVOCATION_ID || '<unknown>';
const kind = process.env.VIBE_SUBAGENT_KIND || '<unknown>';
const ctxTokens = Number(process.env.VIBE_SUBAGENT_CTX_TOKENS || 0) || 0;

let pending = null;

process.on('message', (msg) => {
	if (!msg || typeof msg !== 'object') return;
	if (msg.type !== 'start') return;
	pending = msg;
	finish();
});

const idleTimer = setTimeout(() => {
	// No `start` arrived → exit with non-zero so the host marks failure.
	process.stderr.write('vibe-subagent-fork: no start message in 5s\n');
	process.exit(3);
}, 5000);

function finish() {
	clearTimeout(idleTimer);
	const task = typeof pending?.task === 'string' ? pending.task : '';
	const handoff = typeof pending?.handoff === 'string' ? pending.handoff : '';
	const report = {
		invocationId,
		kind,
		contextWindowTokens: ctxTokens,
		taskBytes: Buffer.byteLength(task, 'utf8'),
		handoffBytes: Buffer.byteLength(handoff, 'utf8'),
		ts: new Date().toISOString(),
		message: 'default-fork-stub: replace via SubagentInvocationRequest.entryScript to perform real work',
	};
	process.stdout.write(JSON.stringify(report) + '\n');
	process.exit(0);
}
