/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Release smoke checker (1163) — pure helper.
 *
 * After a release build, the runner spawns the produced binary, captures
 * its stdout/stderr + exit code + how long it took to print the welcome
 * marker, and feeds those data points here. The checker decides whether
 * the release passes the acceptance gate.
 *
 * Acceptance:
 *   - exitCode === 0
 *   - stdout contains the welcome marker (default "VibeIDE ready")
 *   - stderr contains no fatal markers (default ["FATAL", "Uncaught"])
 *   - timeToReadyMs ≤ maxTimeToReadyMs (default 30s)
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface SmokeRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timeToReadyMs: number;
	durationMs: number;
}

export interface SmokeAcceptanceConfig {
	welcomeMarker: string;
	fatalStderrMarkers: ReadonlyArray<string>;
	maxTimeToReadyMs: number;
	maxDurationMs: number;
}

export const SMOKE_DEFAULTS: SmokeAcceptanceConfig = {
	welcomeMarker: 'VibeIDE ready',
	fatalStderrMarkers: ['FATAL', 'Uncaught'],
	maxTimeToReadyMs: 30_000,
	maxDurationMs: 60_000,
};

export type SmokeFailure =
	| { kind: 'non-zero-exit'; exitCode: number }
	| { kind: 'no-welcome-marker' }
	| { kind: 'fatal-stderr'; marker: string }
	| { kind: 'too-slow-to-ready'; timeToReadyMs: number; limitMs: number }
	| { kind: 'too-slow-overall'; durationMs: number; limitMs: number };

export interface SmokeAcceptanceResult {
	pass: boolean;
	failures: ReadonlyArray<SmokeFailure>;
}

/**
 * Apply the acceptance gate to a single smoke run. Pure — collects ALL
 * failures so the report shows everything at once.
 */
export function evaluateSmokeRun(
	result: SmokeRunResult,
	config: SmokeAcceptanceConfig = SMOKE_DEFAULTS,
): SmokeAcceptanceResult {
	const failures: SmokeFailure[] = [];

	if (result.exitCode !== 0) {
		failures.push({ kind: 'non-zero-exit', exitCode: result.exitCode });
	}
	if (!result.stdout.includes(config.welcomeMarker)) {
		failures.push({ kind: 'no-welcome-marker' });
	}
	for (const marker of config.fatalStderrMarkers) {
		if (result.stderr.includes(marker)) {
			failures.push({ kind: 'fatal-stderr', marker });
		}
	}
	if (result.timeToReadyMs > config.maxTimeToReadyMs) {
		failures.push({
			kind: 'too-slow-to-ready',
			timeToReadyMs: result.timeToReadyMs,
			limitMs: config.maxTimeToReadyMs,
		});
	}
	if (result.durationMs > config.maxDurationMs) {
		failures.push({
			kind: 'too-slow-overall',
			durationMs: result.durationMs,
			limitMs: config.maxDurationMs,
		});
	}
	return { pass: failures.length === 0, failures };
}

/**
 * Render a markdown summary of the smoke result for CI / GitHub Release
 * description. Pure — caller writes this where it wants.
 */
export function renderSmokeSummary(
	result: SmokeRunResult,
	acceptance: SmokeAcceptanceResult,
): string {
	const lines: string[] = [];
	lines.push(`# Release smoke — ${acceptance.pass ? 'PASS' : 'FAIL'}`);
	lines.push('');
	lines.push(`- exit code: ${result.exitCode}`);
	lines.push(`- time to "ready": ${result.timeToReadyMs} ms`);
	lines.push(`- total duration: ${result.durationMs} ms`);
	lines.push(`- stdout bytes: ${result.stdout.length}`);
	lines.push(`- stderr bytes: ${result.stderr.length}`);
	if (!acceptance.pass) {
		lines.push('');
		lines.push('## Failures');
		for (const f of acceptance.failures) {
			lines.push(`- ${describeSmokeFailure(f)}`);
		}
	}
	return lines.join('\n');
}

export function describeSmokeFailure(f: SmokeFailure): string {
	switch (f.kind) {
		case 'non-zero-exit':
			return `Exit code ${f.exitCode} (expected 0).`;
		case 'no-welcome-marker':
			return 'stdout did not contain the welcome marker.';
		case 'fatal-stderr':
			return `stderr contained fatal marker: \`${f.marker}\`.`;
		case 'too-slow-to-ready':
			return `Time-to-ready ${f.timeToReadyMs}ms exceeded budget ${f.limitMs}ms.`;
		case 'too-slow-overall':
			return `Total duration ${f.durationMs}ms exceeded budget ${f.limitMs}ms.`;
	}
}
