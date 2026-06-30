/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * FIM context-collection contract (1018) — pure types + budgeter.
 *
 * The roadmap calls out that FIM input is "scattered without an explicit
 * contract". This module defines what goes in: current file (split around
 * the cursor), open tabs, recent edits, project rules, optional AST
 * snippet, optional skill discoveries. A budget enforcer trims each piece
 * proportionally when total chars exceed `maxContextChars`.
 *
 * Pure: no FS reads, no editor state — caller assembles the inputs and
 * feeds them in.
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface FIMCurrentFile {
	/** Lines BEFORE the cursor, ordered top → cursor. */
	prefix: string;
	/** Lines AFTER the cursor, ordered cursor → bottom. */
	suffix: string;
	uri: string;
	languageId: string;
}

export interface FIMOpenTab {
	uri: string;
	languageId: string;
	/** Compressed snippet — up to a few hundred chars per tab. */
	snippet: string;
}

export interface FIMRecentEdit {
	uri: string;
	timestamp: number;
	/** A short diff hunk; max 500 chars. */
	hunk: string;
}

export interface FIMContext {
	currentFile: FIMCurrentFile;
	openTabs: ReadonlyArray<FIMOpenTab>;
	recentEdits: ReadonlyArray<FIMRecentEdit>;
	projectRules?: string;
	astSnippet?: string;
	skillDiscoveries?: string;
}

export interface FIMBudgetConfig {
	/** Hard cap on serialised context. Default 8 000 chars. */
	maxContextChars: number;
	/** Min chars reserved for current file (prefix + suffix). Default 50%. */
	minCurrentFileShare: number;
}

export const FIM_BUDGET_DEFAULTS: FIMBudgetConfig = {
	maxContextChars: 8_000,
	minCurrentFileShare: 0.5,
};

export interface FIMBudgetReport {
	totalChars: number;
	currentFileChars: number;
	openTabsChars: number;
	recentEditsChars: number;
	projectRulesChars: number;
	astSnippetChars: number;
	skillDiscoveriesChars: number;
	trimmed: ReadonlyArray<'open-tabs' | 'recent-edits' | 'ast-snippet' | 'project-rules' | 'skill-discoveries'>;
}

/**
 * Compute the total char count + which sections were trimmed. Pure.
 *
 * Trimming rules (executed in this order while over budget):
 *   1. Drop skill-discoveries entirely.
 *   2. Drop AST snippet.
 *   3. Drop project rules.
 *   4. Drop oldest recent edits one by one.
 *   5. Drop least-relevant open tabs (last in array).
 *   6. If still over, the current file gets a balanced left/right trim
 *      around the cursor — see `trimCurrentFileToBudget`.
 *
 * Returns the report so the runtime can display "context trimmed" hint.
 */
export function reportFIMBudget(
	ctx: FIMContext,
	config: FIMBudgetConfig = FIM_BUDGET_DEFAULTS,
): FIMBudgetReport {
	const trimmed: Array<'open-tabs' | 'recent-edits' | 'ast-snippet' | 'project-rules' | 'skill-discoveries'> = [];
	let openTabsChars = sum(ctx.openTabs.map(t => t.snippet.length));
	let recentEditsChars = sum(ctx.recentEdits.map(e => e.hunk.length));
	let projectRulesChars = ctx.projectRules?.length ?? 0;
	let astSnippetChars = ctx.astSnippet?.length ?? 0;
	let skillDiscoveriesChars = ctx.skillDiscoveries?.length ?? 0;
	const currentFileChars = ctx.currentFile.prefix.length + ctx.currentFile.suffix.length;

	let total = currentFileChars + openTabsChars + recentEditsChars + projectRulesChars + astSnippetChars + skillDiscoveriesChars;

	if (total > config.maxContextChars && skillDiscoveriesChars > 0) {
		trimmed.push('skill-discoveries');
		total -= skillDiscoveriesChars;
		skillDiscoveriesChars = 0;
	}
	if (total > config.maxContextChars && astSnippetChars > 0) {
		trimmed.push('ast-snippet');
		total -= astSnippetChars;
		astSnippetChars = 0;
	}
	if (total > config.maxContextChars && projectRulesChars > 0) {
		trimmed.push('project-rules');
		total -= projectRulesChars;
		projectRulesChars = 0;
	}
	if (total > config.maxContextChars && recentEditsChars > 0) {
		trimmed.push('recent-edits');
		total -= recentEditsChars;
		recentEditsChars = 0;
	}
	if (total > config.maxContextChars && openTabsChars > 0) {
		trimmed.push('open-tabs');
		total -= openTabsChars;
		openTabsChars = 0;
	}

	return {
		totalChars: total,
		currentFileChars,
		openTabsChars,
		recentEditsChars,
		projectRulesChars,
		astSnippetChars,
		skillDiscoveriesChars,
		trimmed,
	};
}

function sum(ns: ReadonlyArray<number>): number {
	let s = 0;
	for (const n of ns) { s += n; }
	return s;
}

/**
 * Sentinel — thrown by future consumers when the context cannot fit even
 * after dropping every optional section. Not used in this pure module
 * yet; kept for typed catch sites in the runtime.
 */
export class FIMBudgetExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FIMBudgetExceededError';
	}
}

/**
 * Trim the current file's prefix+suffix down to `targetChars` while
 * keeping the cursor centred. Pure.
 *
 * Splits the budget evenly between prefix (kept from the END) and suffix
 * (kept from the START). Empty input returns empty.
 */
export function trimCurrentFileToBudget(
	current: FIMCurrentFile,
	targetChars: number,
): FIMCurrentFile {
	if (targetChars <= 0) {
		return { ...current, prefix: '', suffix: '' };
	}
	const total = current.prefix.length + current.suffix.length;
	if (total <= targetChars) { return current; }
	const halfBudget = Math.floor(targetChars / 2);
	const prefix = current.prefix.slice(Math.max(0, current.prefix.length - halfBudget));
	const suffix = current.suffix.slice(0, halfBudget);
	return { ...current, prefix, suffix };
}
