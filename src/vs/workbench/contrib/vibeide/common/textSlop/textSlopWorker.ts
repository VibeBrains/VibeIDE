/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The text-slop detector, run where a runaway pattern can be killed
 *
 * `.vibe/slop.json` comes with the repository, possibly someone else's, and a JavaScript regex cannot be interrupted
 * on the thread it runs on: `(a+)+$` over thirty letters takes seconds, over forty — hours. The window runs this in
 * a web worker and terminates it when a check outlives its budget (`slopWatchdog.ts`)
 * The shipped catalogue alone also costs about three seconds on a 1 MB text — off the window thread too
 */

import { SLOP_CATALOG_JSONC } from '../slopCatalog.generated.js';
import { applySlopOverrides, compileSlopCatalog, CompiledSlopCatalog, lexicalSlopCatalog, NO_SLOP_OVERRIDES, parseSlopCatalog, parseSlopOverrides } from './slopCatalog.js';
import { analyzeTextSlop, SlopReport } from './textSlop.js';

/** One check: texts against the shipped catalogue, with or without the project's own rules */
export interface SlopWorkerRequest {
	/** The raw `.vibe/slop.json`; absent — the shipped catalogue alone */
	readonly overrides?: string;
	/** Project rule ids left out — the ones that already outlived the budget */
	readonly exclude?: readonly string[];
	/** Time this one project rule alone, nothing else — how the watchdog finds which rule hangs */
	readonly only?: string;
	/** List and template rules only — what one line of a page is judged by */
	readonly lexical?: boolean;
	readonly texts: readonly string[];
}

export interface SlopWorkerReply {
	/** One report per text, in order; absent when the build carries no catalogue that parses */
	readonly reports: readonly SlopReport[] | undefined;
	readonly warnings: readonly string[];
}

/** The shipped catalogue, compiled once per worker: it is the same for every project and every check */
export function compileShippedSlopCatalog(): { readonly catalog: CompiledSlopCatalog | undefined; readonly warnings: readonly string[] } {
	const warnings: string[] = [];
	const parsed = parseSlopCatalog(SLOP_CATALOG_JSONC, warning => warnings.push(warning));
	return { catalog: parsed ? compileSlopCatalog(parsed, warning => warnings.push(warning)) : undefined, warnings };
}

/** One request against an already compiled shipped catalogue — pure, so the whole decision is testable without a worker */
export function runSlopRequest(request: SlopWorkerRequest, shipped: { readonly catalog: CompiledSlopCatalog | undefined; readonly warnings: readonly string[] }): SlopWorkerReply {
	if (!shipped.catalog) {
		return { reports: undefined, warnings: shipped.warnings };
	}
	const warnings = [...shipped.warnings];
	const parsed = request.overrides === undefined ? NO_SLOP_OVERRIDES : parseSlopOverrides(request.overrides, warning => warnings.push(warning));
	const excluded = new Set((request.exclude ?? []).map(id => id.toUpperCase()));
	const only = request.only?.toUpperCase();
	const overrides = { ...parsed, rules: parsed.rules.filter(rule => only ? rule.id.toUpperCase() === only : !excluded.has(rule.id.toUpperCase())) };
	let catalog = applySlopOverrides(overrides, shipped.catalog, warning => warnings.push(warning));
	if (only) {
		// Timing one rule: the shipped ones would only add their own cost to the measurement.
		catalog = { ...catalog, rules: catalog.rules.filter(compiled => compiled.rule.id.toUpperCase() === only) };
	}
	if (request.lexical) {
		catalog = lexicalSlopCatalog(catalog);
	}
	const finalCatalog = catalog;
	return { reports: request.texts.map(text => analyzeTextSlop(text, finalCatalog)), warnings };
}

/** The worker's side of the channel */
export class TextSlopWorker {
	private _shipped: ReturnType<typeof compileShippedSlopCatalog> | undefined;

	$check(request: SlopWorkerRequest): SlopWorkerReply {
		this._shipped ??= compileShippedSlopCatalog();
		return runSlopRequest(request, this._shipped);
	}
}

export function create(): TextSlopWorker {
	return new TextSlopWorker();
}
