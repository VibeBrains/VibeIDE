#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CI helper invoked by .github/workflows/fork-changes-sync.yml on merged
// `fork-change`-labelled PRs. Builds a structured FORK_CHANGES.md entry in
// the format produced by `formatForkChangeLine` and skips on dedup.
//
// MUST stay in sync with src/vs/workbench/contrib/vibeide/common/forkChangesEntry.ts
// (formatForkChangeLine + decideForkChangeAppend semantics). Self-contained so
// CI can `node` it without compiling the TS helper.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FORK_CHANGES_PATH = 'FORK_CHANGES.md';

const KEBAB_TO_PASCAL = (s) =>
	s.split(/[-_]/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');

// Conventional-commit scope (e.g. `feat(catalog): foo`) wins; otherwise PascalCase prefix
// before `:` is taken as-is; otherwise we tag the entry as `Misc`.
export function extractServiceAndSummary(prTitle) {
	const title = String(prTitle || '').trim();
	// Conventional-commit type is always lowercase (`feat`, `fix`, `chore`, …);
	// keeping the regex case-sensitive lets PascalCase prefixes fall through.
	const conv = title.match(/^[a-z]+(?:\(([^)]+)\))?!?:\s*(.+)$/);
	if (conv) {
		const scope = conv[1];
		const rest = conv[2].trim();
		if (scope && /^[a-z0-9_-]+$/i.test(scope)) {
			return { service: KEBAB_TO_PASCAL(scope), summary: rest };
		}
		return { service: 'Misc', summary: rest };
	}
	const pascalPrefix = title.match(/^([A-Z][A-Za-z0-9_-]{0,63}):\s*(.+)$/);
	if (pascalPrefix) {
		return { service: pascalPrefix[1], summary: pascalPrefix[2].trim() };
	}
	return { service: 'Misc', summary: title || '(no title)' };
}

// Mirrors `formatForkChangeLine` + `formatPrRef` from forkChangesEntry.ts.
export function formatForkChangeLine(entry) {
	const ref = entry.prRef ? ` (${formatPrRef(entry.prRef)})` : '';
	return `- date: ${entry.date} | service: ${entry.service} | summary: ${entry.summary}${ref}`;
}

function formatPrRef(ref) {
	const trimmed = String(ref).trim();
	if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
	return trimmed;
}

// Mirrors `decideForkChangeAppend`. Returns one of:
//   { action: 'append', line }
//   { action: 'skip', reason: 'duplicate-pr' | 'duplicate-key' }
//   { action: 'reject', reason: 'empty-summary' }
export function decideForkChangeAppend(candidate, existingMarkdown) {
	if (!candidate.summary || candidate.summary.trim().length === 0) {
		return { action: 'reject', reason: 'empty-summary' };
	}
	if (candidate.prRef !== undefined) {
		const ref = formatPrRef(candidate.prRef);
		if (existingMarkdown.includes(`(${ref})`)) {
			return { action: 'skip', reason: 'duplicate-pr' };
		}
	}
	const dateKey = `date: ${candidate.date} | service: ${candidate.service} | summary: ${candidate.summary}`;
	if (existingMarkdown.includes(dateKey)) {
		return { action: 'skip', reason: 'duplicate-key' };
	}
	return { action: 'append', line: formatForkChangeLine(candidate) };
}

function isoDateUtc(now = new Date()) {
	return now.toISOString().slice(0, 10);
}

export function buildEntryFromEnv(env, now = new Date()) {
	const prNumber = env.PR_NUMBER;
	const prTitle = env.PR_TITLE;
	if (!prNumber || !prTitle) {
		throw new Error('PR_NUMBER and PR_TITLE env vars are required');
	}
	const { service, summary } = extractServiceAndSummary(prTitle);
	return {
		date: isoDateUtc(now),
		service,
		summary,
		prRef: String(prNumber),
	};
}

function main() {
	if (!existsSync(FORK_CHANGES_PATH)) {
		console.log(`${FORK_CHANGES_PATH} not found at repo root; skipping.`);
		return;
	}
	const entry = buildEntryFromEnv(process.env);
	const existing = readFileSync(FORK_CHANGES_PATH, 'utf8');
	const decision = decideForkChangeAppend(entry, existing);
	if (decision.action === 'reject') {
		console.error(`Refusing to append: ${decision.reason}`);
		process.exit(2);
	}
	if (decision.action === 'skip') {
		console.log(`Skipping append: ${decision.reason}`);
		return;
	}
	const sep = existing.endsWith('\n') ? '' : '\n';
	writeFileSync(FORK_CHANGES_PATH, `${existing}${sep}${decision.line}\n`, 'utf8');
	console.log(`Appended: ${decision.line}`);
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
	|| import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');
if (isMain) {
	main();
}
