/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which file a call lands in — decided without types, so every answer says how it was decided
 *
 * `inferred`: the called name came in through an import, and the import names the file
 * `ambiguous`: matched by the name alone — one declaration of that name in the project, or a few, the first taken
 * No link at all when the name is everywhere: a call of `get` on an unknown object pointing at one of forty `get`s
 * Would draw a dependency that does not exist, and a graph is worth having only while a link means what it says
 *
 * Pure: parsed files in, file-to-file links out
 */

import { callFamilyOf, FileCalls } from '../codeSymbols/callSites.js';
import { EdgeProvenance, resolveImportTarget } from './vibeCodeGraph.js';

export interface CallFile extends FileCalls {
	/** Absolute, forward-slash path — the same identity the graph gives the file */
	readonly path: string;
	readonly languageId: string;
}

export interface CallLink {
	readonly from: string;
	readonly to: string;
	readonly provenance: Extract<EdgeProvenance, 'inferred' | 'ambiguous'>;
}

/** A bare call may land on one of this many same-named declarations; more is guessing */
const MAX_NAME_CANDIDATES = 3;

/**
 * File-to-file call links, one per pair of files, the strongest provenance kept
 *
 * A call into the file itself is not a link; a call on an object of unknown type resolves only when its name is declared
 * exactly once in the project, because the object could be anything — a library type the index never saw
 */
export function resolveCalls(files: readonly CallFile[]): CallLink[] {
	const known = new Set(files.map(file => file.path));
	const declaredIn = new Map<string, string[]>();
	for (const file of files) {
		const family = callFamilyOf(file.languageId);
		for (const name of new Set(file.declared)) {
			const key = `${family}\u0000${name}`;
			const list = declaredIn.get(key) ?? [];
			list.push(file.path);
			declaredIn.set(key, list);
		}
	}

	const links = new Map<string, CallLink>();
	const add = (from: string, to: string, provenance: CallLink['provenance']) => {
		if (from === to) {
			return;
		}
		const key = `${from}\u0000${to}`;
		const existing = links.get(key);
		if (!existing || (existing.provenance === 'ambiguous' && provenance === 'inferred')) {
			links.set(key, { from, to, provenance });
		}
	};

	for (const file of files) {
		const family = callFamilyOf(file.languageId);
		const own = new Set(file.declared);
		const bindings = new Map(file.imports.map(binding => [binding.local, binding]));
		for (const call of file.calls) {
			// Through an import: `save()` imported by name, `util.clamp()` through a namespace or default import
			const binding = call.receiver !== undefined ? bindings.get(call.receiver) : bindings.get(call.callee);
			if (binding) {
				const target = resolveImportTarget(file.path, binding.specifier, known);
				if (target) {
					add(file.path, target.path, 'inferred');
				}
				continue;
			}
			if (call.receiver === undefined && own.has(call.callee)) {
				continue;
			}
			const candidates = (declaredIn.get(`${family}\u0000${call.callee}`) ?? []).filter(path => path !== file.path);
			const limit = call.receiver === undefined ? MAX_NAME_CANDIDATES : 1;
			if (candidates.length === 0 || candidates.length > limit) {
				continue;
			}
			add(file.path, [...candidates].sort()[0], 'ambiguous');
		}
	}
	return [...links.values()];
}
