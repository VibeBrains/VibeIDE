#!/usr/bin/env node
// Copyright 2026 VibeIDE Team. MIT License.
//
// Default worker-thread entry script for IVibeSubagentIsolationRuntime
// (roadmap §L883). Receives task description via `workerData`, runs the
// requested subagent kind, and exits with code 0 on success / non-zero on
// failure. The host runtime captures stdout/stderr and reports the result.
//
// This is a thin shell: real subagent execution is host-injected via the
// `entryScript` field of SubagentInvocationRequest. When the host omits
// `entryScript`, this default is used; it produces a deterministic echo
// suitable for smoke-testing the spawn path and the parent-handoff contract
// without performing any LLM calls.

'use strict';

const wt = require('worker_threads');

if (wt.isMainThread) {
	// Direct invocation (e.g. `node scripts/vibe-subagent-worker.js`) — refuse;
	// this file is meant to be spawned by `new Worker()` from the runtime.
	process.stderr.write('vibe-subagent-worker: must be spawned as Worker thread, not main\n');
	process.exit(2);
}

try {
	const data = wt.workerData || {};
	const { invocationId, kind, task, handoff, contextWindowTokens } = data;

	const taskBytes = typeof task === 'string' ? Buffer.byteLength(task, 'utf8') : 0;
	const handoffBytes = typeof handoff === 'string' ? Buffer.byteLength(handoff, 'utf8') : 0;

	const report = {
		invocationId: invocationId || '<unknown>',
		kind: kind || '<unknown>',
		contextWindowTokens: contextWindowTokens || 0,
		taskBytes,
		handoffBytes,
		ts: new Date().toISOString(),
		message: 'default-worker-stub: replace via SubagentInvocationRequest.entryScript to perform real work',
	};
	process.stdout.write(JSON.stringify(report) + '\n');
	process.exit(0);
} catch (e) {
	process.stderr.write(`vibe-subagent-worker: ${e && e.message || String(e)}\n`);
	process.exit(1);
}
