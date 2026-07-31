#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * vibe plan-merge-driver — git custom merge driver for `.vibe/plans/*.plan.md`
 * and `.vibe/plans/*.steps.json`.
 *
 * Two branches that diverge on the same plan are otherwise a manual YAML+JSON
 * disentanglement. With this driver registered, the union of step entries is
 * merged by `id`, and conflicts on a step's `state` mark that step as `paused`
 * with a `mergeConflict` marker so a human resumes deliberately.
 *
 * Register once per clone:
 *   git config merge.vibe-plan.driver "node scripts/vibe-plan-merge-driver.js %A %O %B %P"
 *   git config merge.vibe-plan.name "VibeIDE plan merger"
 *
 * Then in `.gitattributes`:
 *   .vibe/plans/*.plan.md         merge=vibe-plan
 *   .vibe/plans/*.steps.json      merge=vibe-plan
 *
 * Usage as merge driver (git invocation):
 *   node scripts/vibe-plan-merge-driver.js <current> <base> <other> <pathname>
 *
 * Exit codes follow git's convention:
 *   0 — clean merge
 *   1 — conflict markers were retained (paused step), but file is left in a
 *       valid parseable state. Treat as "merged with paused conflict".
 *   2 — IO or parse failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 4) {
	process.stderr.write('vibe plan-merge-driver: expected <current> <base> <other> <pathname>\n');
	process.exit(2);
}

const [CURRENT, BASE, OTHER, PATHNAME] = args;

function readSafe(p) {
	try {
		return fs.readFileSync(p, 'utf-8');
	} catch (e) {
		return null;
	}
}

function isJsonPath(p) {
	return /\.steps\.json$/i.test(p);
}

function isPlanMd(p) {
	return /\.plan\.md$/i.test(p);
}

function parseSteps(text) {
	if (text === null) {
		return null;
	}
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) {
			return null;
		}
		// Each entry must have at least an `id`.
		for (const step of parsed) {
			if (typeof step !== 'object' || step === null || typeof step.id !== 'string') {
				return null;
			}
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Merge two step arrays by `id`. base is the common ancestor (may be null = empty).
 * Conflict policy on field collisions:
 *   - state: if current and other differ AND neither equals base, mark merged step
 *     state as 'paused' and add `mergeConflict: { fromCurrent, fromOther }`.
 *   - other fields: prefer the side that diverged from base; if both diverged
 *     differently, prefer current (left side of merge) and append to
 *     `mergeConflict.fields` so the human notices.
 */
function mergeSteps(currentArr, baseArr, otherArr) {
	const baseById = new Map();
	for (const s of (baseArr ?? [])) {baseById.set(s.id, s);}
	const currentById = new Map();
	for (const s of currentArr) {currentById.set(s.id, s);}
	const otherById = new Map();
	for (const s of otherArr) {otherById.set(s.id, s);}

	const allIds = new Set([
		...currentById.keys(),
		...otherById.keys(),
	]);

	const merged = [];
	let hadConflict = false;

	for (const id of allIds) {
		const cur = currentById.get(id);
		const oth = otherById.get(id);
		const base = baseById.get(id);

		if (cur && !oth) { merged.push(cur); continue; }
		if (oth && !cur) { merged.push(oth); continue; }

		// Both sides have it — diff field by field.
		const out = { ...cur };
		const conflictFields = [];
		const allKeys = new Set([...Object.keys(cur), ...Object.keys(oth)]);
		for (const k of allKeys) {
			const cv = JSON.stringify(cur[k] ?? null);
			const ov = JSON.stringify(oth[k] ?? null);
			const bv = JSON.stringify((base && base[k] !== undefined) ? base[k] : null);
			if (cv === ov) {
				continue; // identical
			}
			// One side equals base — take the other.
			if (cv === bv) {
				out[k] = oth[k];
				continue;
			}
			if (ov === bv) {
				out[k] = cur[k];
				continue;
			}
			// True three-way conflict.
			if (k === 'state') {
				out.state = 'paused';
				out.mergeConflict = {
					...(out.mergeConflict || {}),
					stateFromCurrent: cur.state ?? null,
					stateFromOther: oth.state ?? null,
				};
				hadConflict = true;
			} else {
				conflictFields.push(k);
				// Prefer current (left side of merge).
				out[k] = cur[k];
			}
		}
		if (conflictFields.length > 0) {
			out.mergeConflict = {
				...(out.mergeConflict || {}),
				fields: conflictFields,
				preferred: 'current',
			};
			hadConflict = true;
		}
		merged.push(out);
	}

	return { merged, hadConflict };
}

function mergeStepsJson() {
	const cur = parseSteps(readSafe(CURRENT));
	const base = parseSteps(readSafe(BASE));
	const oth = parseSteps(readSafe(OTHER));
	if (cur === null || oth === null) {
		process.stderr.write(`vibe plan-merge-driver: failed to parse one of the inputs (${PATHNAME})\n`);
		return 2;
	}
	const { merged, hadConflict } = mergeSteps(cur, base, oth);
	const out = JSON.stringify(merged, null, '\t') + '\n';
	fs.writeFileSync(CURRENT, out);
	return hadConflict ? 1 : 0;
}

/**
 * For *.plan.md, treat the embedded ```json ... ``` machine block (planKind:
 * vibeide.agent-plan) as the steps payload, plus the surrounding markdown body.
 * If the markdown body diverges, we keep current's body and append a note;
 * the steps JSON is merged via mergeSteps.
 */
function extractEmbeddedJson(md) {
	if (md === null) {
		return null;
	}
	const m = md.match(/```json\s*\r?\n([\s\S]*?)```/);
	return m ? m[1] : null;
}

function replaceEmbeddedJson(md, newJson) {
	return md.replace(/```json\s*\r?\n[\s\S]*?```/, '```json\n' + newJson + '\n```');
}

function mergePlanMd() {
	const cur = readSafe(CURRENT);
	const base = readSafe(BASE);
	const oth = readSafe(OTHER);
	if (cur === null || oth === null) {
		process.stderr.write(`vibe plan-merge-driver: missing input for ${PATHNAME}\n`);
		return 2;
	}

	const curJson = parseSteps(extractEmbeddedJson(cur));
	const othJson = parseSteps(extractEmbeddedJson(oth));
	const baseJson = parseSteps(extractEmbeddedJson(base ?? ''));

	if (curJson === null || othJson === null) {
		// No machine block on at least one side — fall back to keeping current
		// and noting the conflict at the end.
		fs.writeFileSync(CURRENT, cur + '\n\n<!-- merge-conflict: external branch had different plan; manual review required -->\n');
		return 1;
	}

	const { merged, hadConflict } = mergeSteps(curJson, baseJson, othJson);
	const newJson = JSON.stringify(merged, null, '\t');
	let out = replaceEmbeddedJson(cur, newJson);
	if (hadConflict) {
		out = out + '\n\n<!-- merge-conflict: at least one step is paused with mergeConflict marker; review .steps -->\n';
	}
	fs.writeFileSync(CURRENT, out);
	return hadConflict ? 1 : 0;
}

function main() {
	if (isJsonPath(PATHNAME)) {
		return mergeStepsJson();
	}
	if (isPlanMd(PATHNAME)) {
		return mergePlanMd();
	}
	process.stderr.write(`vibe plan-merge-driver: unsupported path ${PATHNAME}; falling back to ours\n`);
	return 0;
}

process.exit(main());
