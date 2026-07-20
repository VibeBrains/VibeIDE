#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Roadmap W.16 — Disposable / timer leak detector.
//
// Greps `src/vs/workbench/contrib/vibeide/` for `setInterval(` / `setTimeout(`
// without a nearby (`±50` lines) `clearInterval` / `clearTimeout` / `dispose`
// / `disposableTimeout` / `MutableDisposable`. Catches the V.3 / W.0 class
// of bugs (timers that outlive their owner).
//
// Exit 0 = no findings. Exit 1 = findings printed; integrate into CI as a
// soft gate (warn on regressions) or hard gate (fail PR with new findings).

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'vibeide');
if (!fs.existsSync(root)) {
	console.error(`directory not found: ${root}`);
	process.exit(2);
}

// A real timer call is a *bare* `setTimeout(`/`setInterval(` — NOT a method call
// (`socket.setTimeout(`, `this._x.setInterval(`), which are unrelated APIs.
const TIMER_RE = /(?<![.\w])(setInterval|setTimeout)\s*\(/g;
const CLEAR_HINT_RE = /\bclearInterval\s*\(|\bclearTimeout\s*\(|\bdispose\b|\bdisposableTimeout\b|\bdisposableInterval\b|\bMutableDisposable\b|\bthis\._register\b/;
const WINDOW = 50;

// Provably-safe awaited-sleep idiom: the timer only resolves a Promise and self-clears,
// so there is nothing to dispose — `setTimeout(resolve, …)` / `setTimeout(() => resolve(…), …)`
// / `setTimeout(function(){…}, …)` inside a `new Promise(...)` executor.
const SLEEP_RE = /\bsetTimeout\s*\(\s*(resolve|res|r|c|cb|done|function\b|\(\s*\)\s*=>\s*(resolve|res|r|c)\b)/;

// Is the timer assigned to a named handle whose cleanup lives elsewhere in the file
// (beyond the ±WINDOW context)? e.g. `this._intervalTimer = setInterval(...)` cleared by a
// `_clearTimer('_intervalTimer')` helper or `clearInterval(this._intervalTimer)` far below.
function handleIsCleaned(handle, fullText) {
	const field = handle.replace(/^this\./, '');
	const esc = handle.replace(/[.$]/g, '\\$&');
	// Cleared by name anywhere in the file: clearTimeout(handle) / clearInterval(handle) /
	// _clearTimer('field') / unrefTimer(handle) (intentional fire-and-forget lifetime).
	const re = new RegExp(`clear(?:Timeout|Interval)\\s*\\(\\s*${esc}|_clearTimer\\s*\\(\\s*['"\`]${field}['"\`]|unrefTimer\\s*\\(\\s*${esc}`);
	return re.test(fullText);
}

function hasFileWideCleanup(lineIdx, lines, fullText) {
	// A timer assigned to a named handle whose cleanup lives elsewhere in the file (beyond ±WINDOW):
	// look at the timer line plus the next two (`const h = setInterval(...); this._x = h;`).
	for (let j = lineIdx; j <= Math.min(lines.length - 1, lineIdx + 2); j++) {
		const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*set(?:Timeout|Interval)|(this\.[A-Za-z_$][\w$]*)\s*=\s*(?:set(?:Timeout|Interval)|[A-Za-z_$][\w$]*)/.exec(lines[j]);
		if (!assign) { continue; }
		const handle = assign[1] ?? assign[2];
		if (handle && handleIsCleaned(handle, fullText)) { return true; }
	}
	return false;
}

// Is the timer the body of a `new Promise(...)` executor (an awaited sleep/timeout that resolves)?
// Detected by a `new Promise` on the timer line or the two lines above it.
function isPromiseExecutorSleep(lineIdx, lines) {
	for (let j = Math.max(0, lineIdx - 2); j <= lineIdx; j++) {
		if (/new\s+Promise\b/.test(lines[j])) { return true; }
	}
	// Or the timer callback itself settles a Promise (`resolve(…)` / `reject(…)`) within a few
	// lines — an awaited yield/sleep whose only effect is to resolve, so nothing can leak.
	for (let j = lineIdx; j <= Math.min(lines.length - 1, lineIdx + 5); j++) {
		if (/\b(resolve|reject)\s*\(/.test(lines[j])) { return true; }
	}
	return false;
}

// Inline reviewed-suppression: `// @timer-audit-ok: <reason>` on the timer line or the line above
// marks an intentional fire-and-forget timer (e.g. in a repeatedly-called method where registering
// a disposable would itself accumulate). New, un-annotated timers still fail the gate.
const AUDIT_OK_RE = /@timer-audit-ok/;
function isSuppressed(lineIdx, lines) {
	// Directive on the timer line or within the three lines immediately above it (a short comment).
	for (let j = Math.max(0, lineIdx - 3); j <= lineIdx; j++) {
		if (AUDIT_OK_RE.test(lines[j])) { return true; }
	}
	return false;
}

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === '.build') {continue;}
			yield* walk(full);
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
			// Test files spin up short sleeps by design; they are not shipped and cannot leak an owner.
			yield full;
		}
	}
}

const findings = [];
for (const file of walk(root)) {
	const text = fs.readFileSync(file, 'utf-8');
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (!TIMER_RE.test(raw)) { TIMER_RE.lastIndex = 0; continue; }
		TIMER_RE.lastIndex = 0;
		// Skip comment-only lines and string-literal payloads (e.g. injected client JS): the timer
		// is not a real call in this process.
		const trimmed = raw.trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('\'') || trimmed.startsWith('"') || trimmed.startsWith('`')) { continue; }
		// Reviewed intentional timer.
		if (isSuppressed(i, lines)) { continue; }
		// Skip the provably-safe awaited-sleep idiom (bare `setTimeout(resolve, …)` and the
		// `new Promise(resolve => setTimeout(() => { … resolve() … }, …))` executor form).
		if (SLEEP_RE.test(raw) || isPromiseExecutorSleep(i, lines)) { continue; }
		// Skip timers whose named handle is cleared elsewhere in the same file.
		if (hasFileWideCleanup(i, lines, text)) { continue; }
		const start = Math.max(0, i - WINDOW);
		const end = Math.min(lines.length, i + WINDOW + 1);
		const ctx = lines.slice(start, end).join('\n');
		if (CLEAR_HINT_RE.test(ctx)) {continue;}
		findings.push({ file: path.relative(process.cwd(), file), line: i + 1, snippet: trimmed });
	}
}

if (findings.length === 0) {
	console.log(`OK — no untracked timers in ${root}`);
	process.exit(0);
}
console.error(`Found ${findings.length} suspicious timer(s) without nearby cleanup:`);
for (const f of findings) {
	console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
}
process.exit(1);
