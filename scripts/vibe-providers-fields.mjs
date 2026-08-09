#!/usr/bin/env node
// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gate: every field of the `.vibe/providers.json` model format must be read by code.
 *
 * Why this exists — three defects of one shape landed in a single day (2026-08-09):
 *   `fim`            — declared, documented, dropped by the mapper ("the spec lied")
 *   `temperature`/`topP`/`topK` — same, and the JSON schema offered them too
 *   `reasoning.field` — same, AND used by our own shipped preset for three GLM models
 *
 * Each looked fine from every angle a developer checks: the type had the field, the spec
 * described it, the editor autocompleted it. Only the request never carried it. TypeScript
 * cannot catch this — an unread optional property is perfectly legal — so the check has to be
 * a gate, not a compiler rule.
 *
 * What it does: parses the field names out of the format types, then greps the consuming
 * service for each one. A field nobody reads is either a bug or a deliberate no-op, and a
 * deliberate no-op must be declared here with a reason.
 *
 * Usage: node scripts/vibe-providers-fields.mjs [--json]
 * Exit 1 on any unexplained field.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES_FILE = 'src/vs/workbench/contrib/vibeide/common/vibeProvidersFile.ts';
const CONSUMER_FILE = 'src/vs/workbench/contrib/vibeide/browser/vibeDynamicProvidersService.ts';

/** Interfaces whose fields must all be consumed. */
const GUARDED_INTERFACES = ['VibeProviderModelEntry', 'VibeProviderModelReasoning'];

/**
 * Fields that are intentionally never read by the consumer. Every entry needs a reason —
 * an unexplained exception is how a dead field hides in plain sight.
 */
const ALLOWED_UNREAD = new Map([
	['note', 'Комментарий для человека, читающего файл. В код не идёт по замыслу.'],
	// Known debt, tracked in roadmap («поля default/pinned у моделей не проведены в список»).
	// Kept here so the gate stays green on the existing state while still refusing NEW dead fields.
	['default', 'ДОЛГ: объявлено «модель по умолчанию», в список моделей не проведено. См. roadmap.'],
	['pinned', 'ДОЛГ: объявлено «показывать первой», в список моделей не проведено. См. roadmap.'],
]);

/** Extract field names from an interface body. */
function fieldsOf(source, interfaceName) {
	const start = source.indexOf(`interface ${interfaceName} {`);
	if (start === -1) { throw new Error(`interface ${interfaceName} not found in ${TYPES_FILE}`); }
	const bodyStart = source.indexOf('{', start) + 1;
	let depth = 1;
	let i = bodyStart;
	while (i < source.length && depth > 0) {
		if (source[i] === '{') { depth++; }
		else if (source[i] === '}') { depth--; }
		i++;
	}
	const body = source.slice(bodyStart, i - 1);
	const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	const names = [];
	for (const m of withoutComments.matchAll(/(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/g)) {
		names.push(m[1]);
	}
	return names;
}

const typesSource = readFileSync(join(repoRoot, TYPES_FILE), 'utf8');
const consumerSource = readFileSync(join(repoRoot, CONSUMER_FILE), 'utf8');

const declared = new Set();
for (const iface of GUARDED_INTERFACES) {
	for (const f of fieldsOf(typesSource, iface)) { declared.add(f); }
}

// A field counts as consumed when the service mentions it as a property access or a key.
const consumed = new Set();
for (const field of declared) {
	// Property ACCESS only. A bare `field:` also matches object literals the service builds for
	// its own shapes — that false positive is what let `default` look consumed while nothing
	// read it off a model entry.
	const patterns = [
		new RegExp(`\\.${field}\\b`),
		new RegExp(`\\['${field}'\\]`),
	];
	if (patterns.some(p => p.test(consumerSource))) { consumed.add(field); }
}

const unread = [...declared].filter(f => !consumed.has(f));
const unexplained = unread.filter(f => !ALLOWED_UNREAD.has(f));
// The reverse lie: an exception that no longer corresponds to a declared field.
const staleExceptions = [...ALLOWED_UNREAD.keys()].filter(f => !declared.has(f));
const report = {
	declared: [...declared].sort(),
	consumed: [...consumed].sort(),
	unreadButExplained: unread.filter(f => ALLOWED_UNREAD.has(f)).sort(),
	unexplained: unexplained.sort(),
	staleExceptions: staleExceptions.sort(),
};

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`providers.json format: ${declared.size} полей объявлено, ${consumed.size} читается кодом.`);
	for (const f of report.unreadButExplained) {
		console.log(`  ~ ${f} — не читается намеренно: ${ALLOWED_UNREAD.get(f)}`);
	}
	for (const f of unexplained) {
		console.log(`  ✗ ${f} — объявлено в формате, но НЕ читается в ${CONSUMER_FILE}.`);
		console.log('      Либо проведите поле до запроса, либо внесите его в ALLOWED_UNREAD с причиной.');
	}
	for (const f of staleExceptions) {
		console.log(`  ✗ ${f} — числится в ALLOWED_UNREAD, но такого поля в формате больше нет. Удалите исключение.`);
	}
}

if (unexplained.length > 0 || staleExceptions.length > 0) {
	process.exit(1);
}
