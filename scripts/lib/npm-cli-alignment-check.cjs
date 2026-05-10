/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CJS port of `common/npmCliAlignmentCheck.ts` for use by `vibe doctor --self-check`
// (no TS compile step needed). Mirrors the TS helper exactly; the .test.cjs file
// next to this one duplicates a subset of the TS tests as a regression net.
//
// MUST stay in sync with src/vs/workbench/contrib/vibeide/common/npmCliAlignmentCheck.ts
// (checkNpmCliAlignment + renderAlignmentReport semantics).

'use strict';

const VIBE_CALL_RE = /\bnode\s+\.?\/?scripts\/vibe\.js\b/;

function findVibeCall(s) {
	const m = s.match(VIBE_CALL_RE);
	if (!m || m.index === undefined) {
		return -1;
	}
	return m.index;
}

function inspectOne(name, body) {
	const trimmed = (body == null ? '' : String(body)).trim();
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
	// Match the TS module's heuristic: skip past the call literal, then
	// reject anything else after a `;`, `&&`, `||`, `|`.
	const prefixMatch = trimmed.match(VIBE_CALL_RE);
	const tail = trimmed.slice(prefixMatch.index + prefixMatch[0].length);
	if (/[;&|]/.test(tail)) {
		return { scriptName: name, scriptBody: body, reason: 'has-extra-post-pipe-logic' };
	}
	return null;
}

function checkNpmCliAlignment(scripts) {
	const aligned = [];
	const violations = [];
	let checked = 0;

	for (const [name, body] of Object.entries(scripts || {})) {
		if (!name.startsWith('vibe:')) {
			continue;
		}
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

function renderAlignmentReport(report) {
	const lines = [];
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

module.exports = { checkNpmCliAlignment, renderAlignmentReport };
