/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * npm scripts ↔ CLI alignment check (1137) — pure helper.
 *
 * The roadmap requires every `npm run vibe:*` to be a thin wrapper around
 * `node scripts/vibe.js <args>` — one source of truth for the CLI. This
 * helper is the static check that surfaces violations: scripts that have
 * inline logic, custom args order, or a body that doesn't reach
 * `scripts/vibe.js`.
 *
 * Usage by a CI workflow / `vibe doctor --self-check`:
 *
 *   const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
 *   const result = checkNpmCliAlignment(pkg.scripts ?? {});
 *   if (result.violations.length > 0) ...
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface AlignmentViolation {
	scriptName: string;
	scriptBody: string;
	reason: 'not-a-vibe-script' | 'does-not-call-vibe-js' | 'has-extra-pre-pipe-logic' | 'has-extra-post-pipe-logic';
}

export interface AlignmentReport {
	checked: number;
	aligned: ReadonlyArray<string>;
	violations: ReadonlyArray<AlignmentViolation>;
}

/**
 * Inspect `package.json` scripts. Pure.
 *
 * Aligned shape (any of):
 *   "vibe:foo": "node scripts/vibe.js foo"
 *   "vibe:foo": "node scripts/vibe.js foo bar"
 *   "vibe:foo": "node ./scripts/vibe.js foo"
 *
 * Not aligned (examples surfaced):
 *   "vibe:foo": "tsc && node scripts/vibe.js foo"           → has-extra-pre-pipe-logic
 *   "vibe:foo": "node scripts/vibe.js foo && echo done"     → has-extra-post-pipe-logic
 *   "vibe:foo": "node scripts/some-other.js foo"            → does-not-call-vibe-js
 *
 * Scripts not starting with `vibe:` are silently ignored — this checker
 * only looks at the vibe family.
 */
export function checkNpmCliAlignment(scripts: Readonly<Record<string, string>>): AlignmentReport {
	const aligned: string[] = [];
	const violations: AlignmentViolation[] = [];
	let checked = 0;

	for (const [name, body] of Object.entries(scripts)) {
		if (!name.startsWith('vibe:')) { continue; }
		checked++;
		const v = inspectOne(name, body);
		if (v) {
			violations.push(v);
		} else {
			aligned.push(name);
		}
	}

	return { checked, aligned, violations };
}

function inspectOne(name: string, body: string): AlignmentViolation | null {
	const trimmed = (body ?? '').trim();
	if (!trimmed) {
		return { scriptName: name, scriptBody: body, reason: 'not-a-vibe-script' };
	}
	const callIdx = findVibeCall(trimmed);
	if (callIdx < 0) {
		return { scriptName: name, scriptBody: body, reason: 'does-not-call-vibe-js' };
	}
	if (callIdx > 0) {
		return { scriptName: name, scriptBody: body, reason: 'has-extra-pre-pipe-logic' };
	}
	const after = trimmed.slice(0, callIdx).length === 0
		? trimmed.slice(callIdx + 'node scripts/vibe.js'.length).trim()
		: trimmed.slice(callIdx + 'node ./scripts/vibe.js'.length).trim();
	// `after` is the args + any trailing chained command. We split on `;`,
	// `&&`, `||`, `|` and require nothing after the first chunk.
	if (/[;&|]/.test(after) && !/^[^;&|]*$/.test(after)) {
		return { scriptName: name, scriptBody: body, reason: 'has-extra-post-pipe-logic' };
	}
	return null;
}

const VIBE_CALL_RE = /\bnode\s+\.?\/?scripts\/vibe\.js\b/;
function findVibeCall(s: string): number {
	const m = s.match(VIBE_CALL_RE);
	if (!m || m.index === undefined) { return -1; }
	// Reject calls preceded by anything other than whitespace + start.
	const before = s.slice(0, m.index).trim();
	return before.length === 0 ? m.index : m.index;
}

/**
 * Render the report for CI output / vibe doctor. Pure.
 */
export function renderAlignmentReport(report: AlignmentReport): string {
	const lines: string[] = [];
	lines.push(`# npm scripts ↔ CLI alignment — ${report.violations.length === 0 ? 'PASS' : 'FAIL'}`);
	lines.push('');
	lines.push(`Checked ${report.checked} \`vibe:*\` scripts; ${report.aligned.length} aligned, ${report.violations.length} violations.`);
	if (report.violations.length === 0) {
		return lines.join('\n');
	}
	lines.push('');
	lines.push('## Violations');
	for (const v of report.violations) {
		lines.push(`- \`${v.scriptName}\` (${v.reason}) — body: \`${v.scriptBody}\``);
	}
	return lines.join('\n');
}
