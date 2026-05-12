#!/usr/bin/env node
// Copyright 2026 VibeIDE Team. MIT License.
// Catch duplicate keys inside top-level `export const *S = { … }` object literals
// in the VibeIDE i18n bundles (RU is the source of truth; EN bundles get the
// same check). `tsgo --noEmit` does not flag this; `gulp compile` (full tsc)
// does — we want the cheaper local + CI signal before the slow gulp pass.
//
// Algorithm:
//   1. Parse each target .ts file via the TypeScript compiler API.
//   2. Walk the AST. For every `VariableStatement` with a single `VariableDeclaration`
//      whose initializer is an `ObjectLiteralExpression` (optionally wrapped in
//      `as const` / `satisfies`), collect property names.
//   3. Report any duplicate property name in the same object literal.
//
// Exit code is non-zero on any duplicate; CI consumes it directly.

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Bundles to scan. Add new RU/EN bundles as the i18n tree grows.
const TARGETS = [
	'src/vs/workbench/contrib/vibeide/browser/react/src/vibe-settings-tsx/vibeSettingsRu.ts',
];

/** Unwrap `as const` / `satisfies T` wrappers around an object literal. */
function unwrapToObjectLiteral(expr) {
	let e = expr;
	while (true) {
		if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
			e = e.expression;
			continue;
		}
		if (ts.isParenthesizedExpression(e)) {
			e = e.expression;
			continue;
		}
		break;
	}
	return ts.isObjectLiteralExpression(e) ? e : null;
}

/** Yield duplicates found in a single ObjectLiteralExpression as { key, lines: [n, n] }. */
function findDuplicates(objLit, source) {
	const seen = new Map(); // key → first-occurrence line (1-based)
	const dupes = [];
	for (const prop of objLit.properties) {
		// Property name node (regular property, shorthand, computed, etc.)
		let key = null;
		if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
			const nameNode = prop.name;
			if (!nameNode) continue;
			if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
				key = nameNode.text;
			} else if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) {
				key = nameNode.text;
			} else if (ts.isComputedPropertyName(nameNode)) {
				// Skip computed keys — they aren't candidates for static duplicate
				// detection (could be runtime-distinct strings).
				continue;
			}
		} else if (ts.isSpreadAssignment(prop)) {
			// `...spread` — runtime merge, cannot statically detect overlap.
			continue;
		}
		if (key === null) continue;
		const line = source.getLineAndCharacterOfPosition(prop.getStart()).line + 1;
		if (seen.has(key)) {
			dupes.push({ key, lines: [seen.get(key), line] });
		} else {
			seen.set(key, line);
		}
	}
	return dupes;
}

async function scanFile(absPath) {
	const text = await readFile(absPath, 'utf8');
	const source = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);

	const findings = []; // { containerName, dupes: [{key, lines}] }

	const visit = (node) => {
		// Top-level `export const NAME = { … } [as const]` only — keeps the scan
		// scoped and fast.
		if (ts.isVariableStatement(node)) {
			for (const decl of node.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name)) continue;
				if (!decl.initializer) continue;
				const obj = unwrapToObjectLiteral(decl.initializer);
				if (!obj) continue;
				const dupes = findDuplicates(obj, source);
				if (dupes.length) {
					findings.push({ containerName: decl.name.text, dupes });
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	return findings;
}

async function main() {
	let bad = false;
	for (const rel of TARGETS) {
		const abs = join(ROOT, rel);
		const findings = await scanFile(abs);
		if (findings.length === 0) continue;
		bad = true;
		console.error(`vibe-i18n-dupes: duplicate keys in ${relative(ROOT, abs)}:`);
		for (const f of findings) {
			console.error(`  in export const ${f.containerName}:`);
			for (const d of f.dupes) {
				console.error(`    "${d.key}" — first at line ${d.lines[0]}, redefined at line ${d.lines[1]}`);
			}
		}
	}
	if (bad) {
		console.error('\nFix: rename one of the duplicates, or remove the redundant entry.');
		process.exit(1);
	}
	console.log(`vibe-i18n-dupes: OK — ${TARGETS.length} bundle(s) scanned, no duplicate keys.`);
}

main().catch(err => {
	console.error('vibe-i18n-dupes: unexpected error', err);
	process.exit(2);
});
