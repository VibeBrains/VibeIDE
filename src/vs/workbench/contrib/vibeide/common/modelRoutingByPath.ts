/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Per-file model routing (929) — pure helper.
 *
 * Setting `vibeide.model.routing` is an ordered list of `{ pattern, modelId }`
 * pairs. The first matching pattern wins; if nothing matches, the runtime
 * uses the user's default model. Examples:
 *
 *   { pattern: "*.md",         modelId: "haiku" }
 *   { pattern: "**\/*.spec.ts", modelId: "sonnet" }
 *   { pattern: "src\/vs\/**",   modelId: "opus" }
 *
 * Rationale: trivial edits in markdown / tests don't need the heavyweight
 * model. Routing per-file path saves 30–60% tokens on common workflows.
 *
 * vscode-free: no imports beyond standard lib.
 */

import { matchConstraintPattern } from './vibeConstraintsService.js';

export interface ModelRoutingRule {
	pattern: string;
	modelId: string;
}

export interface ModelRoutingDecision {
	resolvedModelId: string;
	source: 'rule' | 'fallback';
	matchedPattern?: string;
}

/**
 * Resolve a file path through the routing list. Pure.
 *
 * - First matching rule wins.
 * - Empty / null path → fallback to default.
 * - Malformed rule (missing modelId or pattern) is silently skipped — the
 *   caller's settings layer is responsible for surfacing a banner.
 */
export function resolveModelForPath(
	filePath: string,
	rules: ReadonlyArray<ModelRoutingRule>,
	defaultModelId: string,
): ModelRoutingDecision {
	if (typeof filePath !== 'string' || filePath.length === 0) {
		return { resolvedModelId: defaultModelId, source: 'fallback' };
	}
	for (const rule of rules) {
		if (!rule || typeof rule.pattern !== 'string' || typeof rule.modelId !== 'string') { continue; }
		if (rule.pattern.length === 0 || rule.modelId.length === 0) { continue; }
		if (matchConstraintPattern(filePath, rule.pattern)) {
			return { resolvedModelId: rule.modelId, source: 'rule', matchedPattern: rule.pattern };
		}
	}
	return { resolvedModelId: defaultModelId, source: 'fallback' };
}

/**
 * Strict envelope decoder. Tagged result — caller decides whether to fall
 * back to "no routing" or surface a settings banner.
 */
export function decodeRoutingRules(raw: unknown): { ok: true; value: ModelRoutingRule[] } | { ok: false; reason: string } {
	if (raw === null || raw === undefined) {
		return { ok: true, value: [] };
	}
	if (!Array.isArray(raw)) {
		return { ok: false, reason: 'not-an-array' };
	}
	const rules: ModelRoutingRule[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== 'object') {
			return { ok: false, reason: `rules[${i}]:not-an-object` };
		}
		const obj = item as Record<string, unknown>;
		if (typeof obj.pattern !== 'string' || obj.pattern.length === 0) {
			return { ok: false, reason: `rules[${i}]:pattern-missing` };
		}
		if (typeof obj.modelId !== 'string' || obj.modelId.length === 0) {
			return { ok: false, reason: `rules[${i}]:modelId-missing` };
		}
		rules.push({ pattern: obj.pattern, modelId: obj.modelId });
	}
	return { ok: true, value: rules };
}

/**
 * Sanity check used by tests / settings UI: a rule with the catch-all
 * pattern `**` AT THE START shadows everything else. Returns the index of
 * the first overshadowed rule, or -1 if rules are well-ordered.
 */
export function findShadowedRule(rules: ReadonlyArray<ModelRoutingRule>): number {
	for (let i = 0; i < rules.length - 1; i++) {
		if (rules[i].pattern === '**' || rules[i].pattern === '**/*') {
			return i + 1;
		}
	}
	return -1;
}
