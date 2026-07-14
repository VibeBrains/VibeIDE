/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { condenseTerminalOutput } from './terminalOutputCondenser.js';

/**
 * Command-aware output compression (knowledge/roadmap/tokenEconomy.md — RTK-style idea).
 *
 * `condenseTerminalOutput` is a GENERIC pass: it collapses identical/noise line runs regardless
 * of which command produced them. It cannot exploit the fact that a `git status` file list or a
 * `jest` per-test log has a KNOWN shape whose noise is safe to summarise aggressively. This module
 * adds a thin profile layer on top: detect the command kind from its first significant token, run
 * a profile-specific reducer, then hand off to the generic condenser as the second stage.
 *
 * Design constraints (mirror terminalOutputCompressor):
 *   - Pure and dependency-free → unit-testable from test/common/.
 *   - Profiles are DATA (a lookup table), not surgery in the agent loop — new command = new entry.
 *   - Never drop error/failure signal: profiles keep failure lines and final summaries verbatim.
 *   - Return the ORIGINAL when the win is under MIN_GAIN_RATIO — a marker in barely-shrunk output
 *     costs more clarity than it saves tokens.
 */

/** Recognised command families with a dedicated reducer; everything else is `unknown`. */
export type CommandKind = 'git' | 'test' | 'ls' | 'docker' | 'find' | 'install' | 'unknown';

/** Minimum shrink (fraction of original length) before a profile result is used. */
const MIN_GAIN_RATIO = 0.9;

/** Short outputs never benefit from profile reduction — no win, citation risk. */
const PROFILE_MIN_LINES = 12;

/** Package managers whose `test`/`t` subcommand delegates to a test runner. */
const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);

/** Test-runner binaries that emit per-test noise around a final summary. */
const TEST_RUNNERS = new Set(['jest', 'vitest', 'mocha', 'pytest', 'cargo', 'go', 'gradle', 'mvn', 'rspec', 'phpunit', 'dotnet', 'ctest', 'deno']);

/** Package-install commands whose progress spam ("already satisfied", downloads) is safe to fold. */
const INSTALL_TOOLS = new Set(['pip', 'pip3', 'apt', 'apt-get', 'brew', 'gem', 'cargo', 'go']);
const INSTALL_SUBS = new Set(['install', 'i', 'add', 'ci', 'get']);

/**
 * Detect the command family from a raw command string. Handles a leading `$ ` echo, env-var
 * prefixes (`FOO=bar cmd`) and `sudo`, then inspects the first real token (and the second token
 * for package-manager `test` / `cargo test` / `go test` delegation).
 */
export const detectCommandKind = (command: string): CommandKind => {
	if (!command) { return 'unknown'; }
	const tokens = command
		.replace(/^\s*\$\s+/, '')                 // strip our own `$ ` echo prefix
		.trim()
		.split(/\s+/)
		.filter(t => !/^\w+=/.test(t));           // drop leading `FOO=bar` env assignments
	let head = tokens[0] ?? '';
	let rest = tokens.slice(1);
	if (head === 'sudo') { head = rest[0] ?? ''; rest = rest.slice(1); }
	if (!head) { return 'unknown'; }

	const sub = rest[0] ?? '';
	if (head === 'git') { return 'git'; }
	if (head === 'ls') { return 'ls'; }
	if (head === 'find') { return 'find'; }
	if (head === 'docker' || head === 'docker-compose') { return 'docker'; }
	// Test detection precedes install for cargo/go (`cargo test` is a test run, `cargo install` an install).
	if (PACKAGE_MANAGERS.has(head) && (sub === 'test' || sub === 't' || sub === 'run')) { return 'test'; }
	if (TEST_RUNNERS.has(head) && (head !== 'cargo' && head !== 'go' ? true : sub === 'test')) { return 'test'; }
	if ((INSTALL_TOOLS.has(head) || PACKAGE_MANAGERS.has(head)) && INSTALL_SUBS.has(sub)) { return 'install'; }
	return 'unknown';
};

/** Lines whose signal must survive every profile: errors, failures, conflicts, summaries. */
const KEEP_PATTERN = /\b(error|err!|fail(ed|ure|ing)?|exception|traceback|panic(ked)?|fatal|conflict|rejected|denied|\d+\s+(passed|passing|failed|failing|pending|skipped|errors?|warnings?)|test result:|\d+\s+files?\s+changed)\b|✗|✘|×|^\s*(both modified|deleted by|added by)/i;

/**
 * git: collapse long staged/unstaged/untracked file listings in `status`/`add`/`checkout` into a
 * per-status count, and drop transfer-progress lines from `push`/`pull`/`clone`. Failure/conflict
 * lines are kept verbatim via KEEP_PATTERN so the model always sees what broke.
 */
const reduceGit = (output: string): string => {
	const lines = output.split('\n');
	const out: string[] = [];
	let fileRun = 0;
	const flushRun = () => {
		if (fileRun > 0) { out.push(`\t[… +${fileRun} file entries]`); fileRun = 0; }
	};
	for (const line of lines) {
		if (KEEP_PATTERN.test(line)) { flushRun(); out.push(line); continue; }
		// `git status` porcelain-ish file rows: `\tmodified:   path`, `\tnew file:   path`, or a bare
		// indented path (untracked). Collapse consecutive plain file rows into a single count line.
		if (/^\s+(modified|new file|deleted|renamed|copied|typechange):\s/.test(line) || /^\t\S/.test(line)) {
			if (out.length > 0 && out[out.length - 1].endsWith(':')) { out.push(line); continue; } // keep first under a header
			fileRun++;
			continue;
		}
		flushRun();
		out.push(line);
	}
	flushRun();
	return out.join('\n');
};

/** Runner-summary shapes kept verbatim so the final tally always survives test reduction. */
const TEST_SUMMARY_PATTERN = /\b(tests?:|test suites?:|test result:|snapshots?:|\d+\s+(passed|passing|failed|failing|pending|skipped|todo)|ran all test|ok\b|FAILED)\b/i;

/** Per-test PASS markers — safe to drop entirely (the summary carries the count). */
const TEST_PASS_PATTERN = /^\s*(✓|✔|√)\s|^\s*PASS(ED)?\b|^\s*ok\s+\d|\.{2,}\s*(ok|PASSED)\s*$|\s\.\.\.\s+ok\s*$/i;

/**
 * test: drop passing-test lines (the summary states the count anyway), keep failures, error stacks
 * and the final summary verbatim. This is where RTK-style savings are largest — a green run is
 * hundreds of `✓` lines the model pays to read for one "N passed" fact.
 */
const reduceTest = (output: string): string => {
	const lines = output.split('\n');
	const out: string[] = [];
	let dropped = 0;
	const flushDropped = () => {
		if (dropped > 0) { out.push(`[… +${dropped} passing tests]`); dropped = 0; }
	};
	for (const line of lines) {
		if (KEEP_PATTERN.test(line) || TEST_SUMMARY_PATTERN.test(line)) { flushDropped(); out.push(line); continue; }
		if (TEST_PASS_PATTERN.test(line)) { dropped++; continue; }
		flushDropped();
		out.push(line);
	}
	flushDropped();
	return out.join('\n');
};

/**
 * ls: for a long flat/`-la` listing, keep the header lines and a bounded head, then summarise the
 * tail into a count. Directory structure rarely needs every entry enumerated in context.
 */
const LS_KEEP_HEAD = 20;
const reduceLs = (output: string): string => {
	const lines = output.split('\n');
	const entryIdx = lines.filter(l => l.trim().length > 0).length;
	if (entryIdx <= LS_KEEP_HEAD) { return output; }
	const kept: string[] = [];
	let count = 0;
	let hidden = 0;
	for (const line of lines) {
		if (KEEP_PATTERN.test(line)) { kept.push(line); continue; }
		if (line.trim().length === 0) { kept.push(line); continue; }
		if (count < LS_KEEP_HEAD) { kept.push(line); count++; continue; }
		hidden++;
	}
	if (hidden > 0) { kept.push(`[… +${hidden} more entries]`); }
	return kept.join('\n');
};

/** docker: collapse layer pull/extract progress (`Pulling fs layer`, digests, `Waiting`) spam. */
const DOCKER_NOISE_PATTERN = /^\s*[0-9a-f]{12}:\s|(Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Extracting|Already exists)\s*$/i;
const reduceDocker = (output: string): string => {
	const lines = output.split('\n');
	const out: string[] = [];
	let dropped = 0;
	const flushDropped = () => {
		if (dropped > 0) { out.push(`[… +${dropped} layer progress lines]`); dropped = 0; }
	};
	for (const line of lines) {
		if (KEEP_PATTERN.test(line)) { flushDropped(); out.push(line); continue; }
		if (DOCKER_NOISE_PATTERN.test(line)) { dropped++; continue; }
		flushDropped();
		out.push(line);
	}
	flushDropped();
	return out.join('\n');
};

/** find: a long path listing — keep a bounded head, summarise the rest into a count (like ls). */
const reduceFind = (output: string): string => reduceLs(output);

/** install: drop "already satisfied"/download/progress spam; keep errors, warnings and the tail. */
const INSTALL_NOISE_PATTERN = /^\s*(Requirement already satisfied|Downloading|Downloaded|Collecting|Using cached|Fetching|Resolving|Get:|Hit:|Ign:|Reading (package lists|state)|Building dependency|Preparing to unpack|Unpacking|Selecting previously|Setting up|added \d+ packages?|Fetching package|==> (Downloading|Pouring|Fetching)|remote:)\b/i;
const reduceInstall = (output: string): string => {
	const lines = output.split('\n');
	const out: string[] = [];
	let dropped = 0;
	const flush = () => { if (dropped > 0) { out.push(`[… +${dropped} progress lines]`); dropped = 0; } };
	for (const line of lines) {
		if (KEEP_PATTERN.test(line)) { flush(); out.push(line); continue; }
		if (INSTALL_NOISE_PATTERN.test(line)) { dropped++; continue; }
		flush();
		out.push(line);
	}
	flush();
	return out.join('\n');
};

const PROFILES: Record<Exclude<CommandKind, 'unknown'>, (output: string) => string> = {
	git: reduceGit,
	test: reduceTest,
	ls: reduceLs,
	docker: reduceDocker,
	find: reduceFind,
	install: reduceInstall,
};

/**
 * Compress terminal output using a command-aware profile (when `useProfiles`) followed by the
 * generic condenser. Always safe to substitute for the original: returns the input unchanged when
 * it is short or neither stage produced a meaningful win.
 */
export const compressCommandOutput = (command: string, output: string, useProfiles: boolean): string => {
	if (!output) { return output; }

	let working = output;
	if (useProfiles && output.split('\n').length >= PROFILE_MIN_LINES) {
		const kind = detectCommandKind(command);
		if (kind !== 'unknown') {
			const reduced = PROFILES[kind](output);
			if (reduced.length <= output.length * MIN_GAIN_RATIO) { working = reduced; }
		}
	}

	// Generic second stage — collapses whatever line-run noise the profile left (or all of it when
	// the command was unknown / profiles are off).
	return condenseTerminalOutput(working);
};

/**
 * Compress an opaque tool result (e.g. MCP output) with the GENERIC condenser only. No profile is
 * applied because the command shape is unknown — aggressive filtering could drop the one line that
 * mattered. Safe drop-in: returns the input unchanged when nothing meaningful compressed.
 */
export const compressGenericToolOutput = (output: string): string => {
	if (!output) { return output; }
	return condenseTerminalOutput(output);
};
