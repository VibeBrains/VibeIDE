#!/usr/bin/env node
// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gate: no quirks rule may force a tool-call format onto a model whose shipped preset
 * declares one explicitly.
 *
 * Why this exists — the catalog matcher is a bare case-insensitive SUBSTRING over the model id,
 * and quirks are Tier 1 in `aiSdkAdapter.sendViaAISdk` (they beat provider capabilities outright).
 * So a family rule written for one generation reaches every future model whose id happens to
 * contain the same letters. That is not hypothetical: `match: "qwen"` with
 * `forceToolCallFormat: "xml"` was added for the 2.5 generation on the direct API and silently
 * routed `qwen3.7-plus` and `qwen3-coder-next` — both declared `toolFormat: "openai"` in our own
 * `alibaba-coding-plan` preset — through the XML grammar instead. Nothing failed loudly: the
 * models simply behaved worse than they should.
 *
 * TypeScript cannot see this (two unrelated JSON files) and unit tests over the matcher cannot
 * either (they assert the matcher's own rules, not the fleet of shipped model ids). Hence a gate.
 *
 * A conflict is resolved by narrowing the rule's `match` to the generation that actually needs
 * the force — not by loosening this check.
 *
 * Usage: node scripts/vibe-quirks-conflicts.mjs [--json]
 * Exit 1 on any conflict.
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = 'resources/model-quirks.json';
const PRESET_DIR = '.vibe-defaults/providers';

/**
 * Strip `//` line comments and trailing commas so JSONC presets parse with JSON.parse.
 * String-aware: a `//` inside a quoted value (every preset carries URLs) must survive.
 * @param {string} text
 */
function parseJsonc(text) {
	let out = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escaped) { escaped = false; }
			else if (ch === '\\') { escaped = true; }
			else if (ch === '"') { inString = false; }
			continue;
		}
		if (ch === '"') { inString = true; out += ch; continue; }
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') { i++; }
			out += '\n';
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
			i++;
			continue;
		}
		out += ch;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** @returns {{provider: string, providerName: string, modelId: string, toolFormat: string, file: string}[]} */
function collectDeclaredModels() {
	const out = [];
	for (const file of readdirSync(join(repoRoot, PRESET_DIR))) {
		if (!file.endsWith('.jsonc')) { continue; }
		const rel = `${PRESET_DIR}/${file}`;
		let parsed;
		try {
			parsed = parseJsonc(readFileSync(join(repoRoot, rel), 'utf8'));
		} catch (err) {
			// A preset we cannot parse is a failure of this gate, not a reason to skip it:
			// an unparsed preset would silently drop every model it declares.
			throw new Error(`${rel}: cannot parse — ${err instanceof Error ? err.message : String(err)}`);
		}
		for (const p of parsed?.providers ?? []) {
			for (const m of p?.models?.static ?? []) {
				if (!m?.id || !m?.toolFormat) { continue; }
				out.push({ provider: p.id ?? '', providerName: p.name ?? '', modelId: m.id, toolFormat: m.toolFormat, file: rel });
			}
		}
	}
	return out;
}

/**
 * Mirror of `matchQuirks` provider matching: an unscoped rule applies everywhere, a scoped one
 * only when its `provider` is a substring of the provider name. Both the preset `id` and `name`
 * are tried because either may be what the runtime passes as the provider name.
 * @param {{provider?: string}} rule
 * @param {{provider: string, providerName: string}} model
 */
function providerApplies(rule, model) {
	if (!rule.provider) { return true; }
	const needle = rule.provider.toLowerCase();
	return model.provider.toLowerCase().includes(needle) || model.providerName.toLowerCase().includes(needle);
}

const catalog = JSON.parse(readFileSync(join(repoRoot, CATALOG), 'utf8'));
const models = collectDeclaredModels();
const conflicts = [];

for (const rule of catalog.rules ?? []) {
	if (!rule?.forceToolCallFormat || !rule?.match) { continue; }
	const pattern = String(rule.match).toLowerCase();
	for (const model of models) {
		if (!model.modelId.toLowerCase().includes(pattern)) { continue; }
		if (!providerApplies(rule, model)) { continue; }
		conflicts.push({
			match: rule.match,
			provider: rule.provider ?? '(any)',
			forces: rule.forceToolCallFormat,
			modelId: model.modelId,
			declares: model.toolFormat,
			preset: model.file,
		});
	}
}

if (process.argv.includes('--json')) {
	console.log(JSON.stringify({ checked: models.length, conflicts }, null, 2));
} else if (conflicts.length === 0) {
	console.log(`✔ quirks/preset tool-format conflicts: none (${models.length} declared models checked)`);
} else {
	console.error(`✖ quirks rules override an explicitly declared toolFormat (${conflicts.length}):\n`);
	for (const c of conflicts) {
		console.error(`  rule match:"${c.match}" provider:${c.provider} forces ${c.forces}`);
		console.error(`    → ${c.modelId} declares toolFormat:"${c.declares}" in ${c.preset}`);
	}
	console.error(`\nNarrow the rule's \`match\` to the generation that needs the force.`);
}

process.exit(conflicts.length === 0 ? 0 : 1);
