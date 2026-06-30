/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Semantic condenser for `run_command` terminal output (knowledge/roadmap/token-economy.md, B).
 *
 * Test runners, package managers and build tools emit hundreds of progress/"ok" lines the
 * model pays input tokens to read without gaining signal. RTK-style idea: compress BEFORE
 * the output reaches the context. Deliberately conservative — only two transformations:
 *
 *   1. Runs of IDENTICAL lines collapse to one line + `[× N]`.
 *   2. Runs of recognised NOISE lines (test-pass markers, progress bars, download/compile
 *      spam) collapse to head + `[… +N similar lines condensed]`.
 *
 * Lines near error markers, runner summary lines, and the head/tail of the output are
 * never collapsed. Unrecognised content passes through untouched — losing signal is worse
 * than spending tokens. The size-based `truncateHeadTail` clamp stays as the safety net
 * AFTER this pass.
 *
 * Pure and dependency-free → unit-testable from test/common/.
 */

/** Outputs shorter than this many lines pass through untouched — no win, citation risk. */
const CONDENSE_MIN_LINES = 80;

/** A run of IDENTICAL lines must be at least this long to collapse. */
const DUPLICATE_RUN_MIN = 4;

/** A run of NOISE lines must be at least this long to collapse. */
const NOISE_RUN_MIN = 8;

/** How many leading lines of a collapsed noise run stay visible. */
const NOISE_RUN_KEEP_HEAD = 3;

/** Lines within this distance of an error marker are never collapsed. */
const ERROR_CONTEXT_LINES = 3;

/** Head/tail of the whole output that is never collapsed (command echo / final summary). */
const PROTECTED_HEAD_LINES = 15;
const PROTECTED_TAIL_LINES = 25;

/** Error markers — anchor protected windows. Case-insensitive. */
const ERROR_PATTERN = /\b(error|err!|fail(ed|ure)?|exception|traceback|panic(ked)?|fatal|assert(ion)? ?(error|failed)|✗|✘|×)\b|^\s*at\s+\S+\(/i;

/** Runner summary lines — always kept verbatim (the actual signal of a test run). */
const SUMMARY_PATTERN = /\b(\d+\s+(passed|passing|failed|failing|pending|skipped|errors?|warnings?)|tests?:|test suites?:|test result:|exit code|errorlevel|\d+\s+vulnerabilit)/i;

/** Noise-line shapes: per-test pass markers, progress bars, fetch/compile spam, separators. */
const NOISE_PATTERNS: readonly RegExp[] = [
	/^\s*test\s+\S+\s+\.{3}\s+ok\s*$/i,                          // cargo / rust: `test foo::bar ... ok`
	/^\s*ok\s+\d+\b/,                                            // TAP: `ok 12 - description`
	/^\s*ok\s+\S+\s+[\d.]+m?s\s*$/,                              // go test: `ok package 0.123s`
	/^\s*(✓|✔|√|·|∙|PASS(ED)?)\b/,                               // jest/mocha/pytest -v pass markers
	/^\s*\S+\s+\.{2,}\s*(ok|PASSED)\s*$/i,                       // pytest verbose: `test_x.py::test ... PASSED`
	/^.*\[[=\-#>· ]{6,}\]\s*\d*/,                                // progress bars `[====>   ] 42`
	/^\s*\d{1,3}(\.\d+)?%/,                                      // percent progress lines
	/^\s*(Downloading|Downloaded|Compiling|Fetching|Resolving|Installing|Unpacking|Receiving objects|Resolving deltas|Checking out|reused \d|remote:)\b/i,
	/^\s*(npm\s+)?(warn\s+deprecated|verb|sill|http fetch)\b/i,  // npm log spam
	/^[\s.·=\-_*]{12,}$/,                                        // separator / dots-only lines
];

const isNoiseLine = (line: string): boolean => NOISE_PATTERNS.some(p => p.test(line));

/**
 * Condense terminal output. Returns the input unchanged when it is short or nothing
 * matched — the result is ALWAYS safe to hand to the model in place of the original.
 */
export const condenseTerminalOutput = (output: string): string => {
	if (!output) { return output; }
	const lines = output.split('\n');
	if (lines.length < CONDENSE_MIN_LINES) { return output; }

	// Pass 1 — protected lines: error windows, summaries, global head/tail.
	const protectedIdx = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (i < PROTECTED_HEAD_LINES || i >= lines.length - PROTECTED_TAIL_LINES) { protectedIdx.add(i); continue; }
		if (SUMMARY_PATTERN.test(lines[i])) { protectedIdx.add(i); continue; }
		if (ERROR_PATTERN.test(lines[i])) {
			for (let j = Math.max(0, i - ERROR_CONTEXT_LINES); j <= Math.min(lines.length - 1, i + ERROR_CONTEXT_LINES); j++) {
				protectedIdx.add(j);
			}
		}
	}

	// Pass 2 — walk and collapse runs among unprotected lines.
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (protectedIdx.has(i)) { out.push(lines[i]); i++; continue; }

		// Identical-line run (trimmed-right comparison so trailing spaces don't split runs).
		const key = lines[i].trimEnd();
		let runEnd = i;
		while (runEnd + 1 < lines.length && !protectedIdx.has(runEnd + 1) && lines[runEnd + 1].trimEnd() === key) { runEnd++; }
		const dupLen = runEnd - i + 1;
		if (dupLen >= DUPLICATE_RUN_MIN) {
			out.push(`${key} [× ${dupLen}]`);
			i = runEnd + 1;
			continue;
		}

		// Noise run (lines may differ but all match a noise shape).
		if (isNoiseLine(lines[i])) {
			let noiseEnd = i;
			while (noiseEnd + 1 < lines.length && !protectedIdx.has(noiseEnd + 1) && isNoiseLine(lines[noiseEnd + 1])) { noiseEnd++; }
			const noiseLen = noiseEnd - i + 1;
			if (noiseLen >= NOISE_RUN_MIN) {
				for (let k = i; k < i + NOISE_RUN_KEEP_HEAD; k++) { out.push(lines[k]); }
				out.push(`[… +${noiseLen - NOISE_RUN_KEEP_HEAD} similar lines condensed]`);
				i = noiseEnd + 1;
				continue;
			}
		}

		out.push(lines[i]);
		i++;
	}

	// Only claim a win when it actually shrank meaningfully; otherwise return the original
	// (avoids sprinkling markers into output that barely compressed).
	const condensed = out.join('\n');
	return condensed.length <= output.length * 0.9 ? condensed : output;
};
