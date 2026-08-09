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

/**
 * One entry per user-facing file format. `consumers` may list several files: a format is often
 * parsed in one place and acted on in another, and a field read anywhere counts as alive.
 *
 * `allowedUnread` — fields that intentionally reach no code, each with a reason. An unexplained
 * exception is exactly how a dead field hides in plain sight.
 *
 * `consumers` lists the places where a field must DO something. Parsers and the settings forms are
 * deliberately left out: they copy every field from JSON to object and back, so including them
 * would mark a field alive merely because the user can type it. Conversely, forgetting a real
 * consumer produces a false alarm — that happened with `icon` on first run, which is read by the
 * status-bar contribution. When the gate fires, check by grep before believing it.
 *
 * A consumer may name a single function instead of a whole file, as `path/to/file.ts#functionName`.
 * That exists for fields applied by a pure helper living next to the parser it must not drag in:
 * `order` is read only inside `sortProjectCommandsForDisplay`, which sits in the types file, and
 * the gate called it dead while all four command surfaces sorted by it. Only the named function's
 * body is scanned, and the helper must itself be called from a plain consumer — otherwise a helper
 * nobody invokes would whitewash the very field it pretends to apply.
 */
const FORMATS = [
	{
		name: '.vibe/providers.json',
		types: 'src/vs/workbench/contrib/vibeide/common/vibeProvidersFile.ts',
		interfaces: ['VibeProviderModelEntry', 'VibeProviderModelReasoning'],
		consumers: ['src/vs/workbench/contrib/vibeide/browser/vibeDynamicProvidersService.ts'],
		allowedUnread: new Map([
			['note', 'Комментарий для человека, читающего файл. В код не идёт по замыслу.'],
		]),
	},
	{
		name: '.vibe/hooks.json',
		types: 'src/vs/workbench/contrib/vibeide/common/hooks/hookConfig.ts',
		interfaces: ['VibeHook'],
		consumers: [
			'src/vs/workbench/contrib/vibeide/common/hooks/hookConfig.ts',
			'src/vs/workbench/contrib/vibeide/common/hooks/hookOutcome.ts',
			'src/vs/workbench/contrib/vibeide/electron-browser/hooks/vibeHooksService.ts',
			'src/vs/workbench/contrib/vibeide/electron-main/hooks/vibeHooksMainService.ts',
		],
		allowedUnread: new Map(),
	},
	{
		name: '.vibe/servers.json',
		types: 'src/vs/workbench/contrib/vibeide/common/vibeServer/vibeServersFile.ts',
		interfaces: ['VibeServerEntry'],
		consumers: [
			'src/vs/workbench/contrib/vibeide/common/vibeServer/vibeServersFile.ts',
			'src/vs/workbench/contrib/vibeide/browser/vibeServer/vibeServerStackService.ts',
			'src/vs/workbench/contrib/vibeide/browser/vibeServer/vibeServerRuntime.ts',
			'src/vs/workbench/contrib/vibeide/browser/vibeServer/vibeServerViewPane.ts',
		],
		allowedUnread: new Map(),
	},
	{
		name: '.vibe/commands.json',
		types: 'src/vs/workbench/contrib/vibeide/common/projectCommandsTypes.ts',
		interfaces: ['ProjectCommand'],
		consumers: [
			'src/vs/workbench/contrib/vibeide/browser/vibeCustomCommandsService.ts',
			'src/vs/workbench/contrib/vibeide/browser/vibeCustomCommandsContribution.ts',
			'src/vs/workbench/contrib/vibeide/browser/vibeProjectCommandsPopup.ts',
			'src/vs/workbench/contrib/vibeide/browser/vibeProjectCommandsTopBarContribution.ts',
			'src/vs/workbench/contrib/vibeide/browser/vibeProjectCommandsMenubarContribution.ts',
			// `order` is applied only here; the file around it is the parser, which must stay out.
			'src/vs/workbench/contrib/vibeide/common/projectCommandsTypes.ts#sortProjectCommandsForDisplay',
		],
		allowedUnread: new Map(),
	},
];

/** Slice the body of a top-level `export function name(...)` out of a source file. */
function functionBodyOf(source, fnName, file) {
	const signature = new RegExp(`function\\s+${fnName}\\s*[(<]`).exec(source);
	if (!signature) { throw new Error(`function ${fnName} not found in ${file}`); }
	const bodyStart = source.indexOf('{', signature.index + signature[0].length - 1);
	if (bodyStart === -1) { throw new Error(`function ${fnName} has no body in ${file}`); }
	let depth = 1;
	let i = bodyStart + 1;
	while (i < source.length && depth > 0) {
		if (source[i] === '{') { depth++; }
		else if (source[i] === '}') { depth--; }
		i++;
	}
	return source.slice(bodyStart, i);
}

/**
 * Read a consumer entry into source text. `path#fn` yields only that function's body, and is
 * rejected unless some whole-file consumer actually calls it.
 */
function consumerSourceOf(entry, wholeFileSources) {
	const [file, fnName] = entry.split('#');
	const source = readFileSync(join(repoRoot, file), 'utf8');
	if (!fnName) { return source; }
	const calledSomewhere = wholeFileSources.some(s => new RegExp(`\\b${fnName}\\s*\\(`).test(s));
	if (!calledSomewhere) {
		throw new Error(`consumer ${entry}: помощник не вызывается ни из одного файла-потребителя — поле остаётся мёртвым`);
	}
	return functionBodyOf(source, fnName, file);
}

/** Extract field names from an interface body. */
function fieldsOf(source, interfaceName, typesFile) {
	const start = source.indexOf(`interface ${interfaceName} {`);
	if (start === -1) { throw new Error(`interface ${interfaceName} not found in ${typesFile}`); }
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

const asJson = process.argv.includes('--json');
const reports = [];
let failed = false;

for (const fmt of FORMATS) {
	const typesSource = readFileSync(join(repoRoot, fmt.types), 'utf8');
	const wholeFileSources = fmt.consumers
		.filter(f => !f.includes('#'))
		.map(f => readFileSync(join(repoRoot, f), 'utf8'));
	const consumerSource = fmt.consumers
		.map(f => consumerSourceOf(f, wholeFileSources))
		.join('\n');

	const declared = new Set();
	for (const iface of fmt.interfaces) {
		for (const f of fieldsOf(typesSource, iface, fmt.types)) { declared.add(f); }
	}

	const consumed = new Set();
	for (const field of declared) {
		// Property ACCESS only. A bare `field:` also matches object literals a service builds for
		// its own shapes — that false positive is what let `default` look consumed while nothing
		// read it off a model entry.
		const patterns = [new RegExp(`\\.${field}\\b`), new RegExp(`\\['${field}'\\]`)];
		if (patterns.some(p => p.test(consumerSource))) { consumed.add(field); }
	}

	const unread = [...declared].filter(f => !consumed.has(f));
	const unexplained = unread.filter(f => !fmt.allowedUnread.has(f));
	const staleExceptions = [...fmt.allowedUnread.keys()].filter(f => !declared.has(f));
	if (unexplained.length > 0 || staleExceptions.length > 0) { failed = true; }

	reports.push({
		format: fmt.name,
		declared: [...declared].sort(),
		consumed: [...consumed].sort(),
		unreadButExplained: unread.filter(f => fmt.allowedUnread.has(f)).sort(),
		unexplained: unexplained.sort(),
		staleExceptions: staleExceptions.sort(),
	});

	if (!asJson) {
		console.log(`${fmt.name}: ${declared.size} полей объявлено, ${consumed.size} читается кодом.`);
		for (const f of unread.filter(x => fmt.allowedUnread.has(x)).sort()) {
			console.log(`  ~ ${f} — не читается намеренно: ${fmt.allowedUnread.get(f)}`);
		}
		for (const f of unexplained) {
			console.log(`  ✗ ${f} — объявлено в формате, но НЕ читается ни в одном потребителе:`);
			for (const c of fmt.consumers) { console.log(`      ${c}`); }
			console.log('      Либо проведите поле до дела, либо внесите его в allowedUnread с причиной.');
		}
		for (const f of staleExceptions) {
			console.log(`  ✗ ${f} — числится в allowedUnread, но такого поля в формате больше нет. Удалите исключение.`);
		}
	}
}

if (asJson) { console.log(JSON.stringify(reports, null, 2)); }
if (failed) { process.exit(1); }
