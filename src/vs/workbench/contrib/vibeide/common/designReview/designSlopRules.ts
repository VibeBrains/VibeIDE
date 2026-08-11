/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Detectors for machine-generated design tells ("ai-slop") — pure decision layer.
 *
 * Why deterministic rules instead of asking a model "is this pretty": a model answers differently
 * on the same page twice, cannot point at the element, and costs a request. These rules read a
 * normalised snapshot of what the page ACTUALLY computed (font sizes, colours, spacing, geometry),
 * so a finding is reproducible and always carries the element it came from.
 *
 * Two things a catalogue of style rules has to get right, or it becomes noise:
 *
 * 1. A QUALITY FLOOR IS NOT A STYLE OPINION. Contrast below WCAG AA, a target too small to hit, a
 *    skipped heading level, clipped content, an image that never arrived — these are defects in any
 *    visual world. They are `floor` and no project overrides them.
 * 2. A STYLE TELL CAN BE AN IDENTITY. A pixel-art product commits to zero-blur stepped shadows; a
 *    terminal-flavoured one commits to one monospace family. Those are `drift`: true by default,
 *    and accepted — with a stated reason — when the project's `design.md` says so. An accepted
 *    finding is still reported, marked as deliberate, so the decision stays visible instead of
 *    disappearing into an ignore list.
 *
 * Provenance: the catalogue of tells is informed by the public `pbakaus/impeccable` project
 * (Apache-2.0). No code was copied — that licence does not fit this MIT tree; the checks here are
 * written from the descriptions of the antipatterns, which are facts about design, not code.
 *
 * The snapshot is produced elsewhere (preview page → chrome → service), so this module stays
 * testable without a browser.
 */

import { DesignContext, acceptedDriftFor } from '../designContext/designContextFile.js';
import { DocumentSnapshot, Finding, Rule, Severity } from './designSnapshot.js';
import { RULE_META, RuleId } from './ruleIds.js';
import { COLOR_RULES } from './rules/color.js';
import { COPY_RULES } from './rules/copy.js';
import { IMAGERY_RULES } from './rules/imagery.js';
import { LAYOUT_RULES } from './rules/layout.js';
import { MOTION_RULES } from './rules/motion.js';
import { TYPOGRAPHY_RULES } from './rules/typography.js';
import { VISUAL_RULES } from './rules/visual.js';
import { STATE_RULES } from './rules/states.js';

export {
	contrastRatio,
	hueSaturation,
	relativeLuminance,
	type DocumentSnapshot,
	type ElementSnapshot,
	type Finding,
	type RuleClass,
	type Severity,
	type ViewportLabel,
} from './designSnapshot.js';

/**
 * Every rule in the catalogue, by category. Adding a rule to its category file is the only
 * registration needed; the category arrays are the single source of truth for what runs.
 */
const RULES: readonly Rule[] = [
	...TYPOGRAPHY_RULES,
	...COLOR_RULES,
	...VISUAL_RULES,
	...STATE_RULES,
	...LAYOUT_RULES,
	...MOTION_RULES,
	...COPY_RULES,
	...IMAGERY_RULES,
];

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Runs the catalogue over a page snapshot.
 *
 * `context` is the project's design system: findings it declared deliberate come back marked
 * `accepted` instead of being dropped. Silence about a decision is how an ignore list turns into
 * folklore — the reason travels with the finding.
 *
 * Ordering is deterministic (severity, then rule, then selector) so two runs on the same page
 * produce byte-identical output — a report that reshuffles itself cannot be diffed.
 */
export function reviewDesign(doc: DocumentSnapshot, context?: DesignContext): Finding[] {
	const findings = RULES.flatMap(rule => rule(doc)).map((raw): Finding => {
		// The class is the catalogue's word, not the rule's: a project accepts drift by rule id, so
		// the two must agree by construction. An id missing from the catalogue is a programming
		// error the unit tests catch; treating it as drift here would silently make it acceptable,
		// so it stays a floor — a wrong report is better than a quietly disabled check.
		const ruleClass = RULE_META[raw.rule as RuleId]?.ruleClass ?? 'floor';
		const finding: Finding = doc.viewport
			? { ...raw, ruleClass, viewport: doc.viewport }
			: { ...raw, ruleClass };
		if (ruleClass === 'floor') {
			return finding;
		}
		const accepted = acceptedDriftFor(context, finding.rule);
		return accepted ? { ...finding, accepted: { reason: accepted.reason } } : finding;
	});
	return findings.sort((a, b) =>
		SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
		|| a.rule.localeCompare(b.rule)
		|| a.selector.localeCompare(b.selector));
}

/**
 * How many rule functions are registered.
 *
 * NOT the number a report shows: what a user calls "a rule" is a finding id, and one function can
 * emit two (wide vs negative tracking, stripes vs grid). Reports count ids (`ALL_RULE_IDS`); this
 * stays for tests that assert the catalogue is wired up at all.
 */
export const RULE_COUNT = RULES.length;

/**
 * Merges the findings of two viewport passes into one list.
 *
 * A finding that appears at both widths is a property of the page, not of the width, so it loses
 * its viewport label and is reported once — otherwise every real defect would be listed twice and
 * the width-specific ones (a card clipped only at 390px) would drown in the duplication.
 */
export function mergeViewportFindings(passes: readonly (readonly Finding[])[]): Finding[] {
	const byKey = new Map<string, { finding: Finding; viewports: Set<string> }>();
	for (const pass of passes) {
		for (const finding of pass) {
			const key = `${finding.rule}|${finding.selector}|${finding.message}`;
			const seen = byKey.get(key);
			if (seen) {
				if (finding.viewport) {
					seen.viewports.add(finding.viewport);
				}
			} else {
				byKey.set(key, { finding, viewports: new Set(finding.viewport ? [finding.viewport] : []) });
			}
		}
	}
	const merged = [...byKey.values()].map(({ finding, viewports }) => {
		if (viewports.size <= 1) {
			return finding;
		}
		const { viewport, ...rest } = finding;
		return rest as Finding;
	});
	return merged.sort((a, b) =>
		SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
		|| a.rule.localeCompare(b.rule)
		|| a.selector.localeCompare(b.selector));
}

/**
 * Counts per severity — the one-line verdict the UI shows before the list.
 *
 * Accepted findings are counted separately: they are decisions, and mixing them into the warning
 * count would make a project that documented its choices look worse than one that never did.
 */
export function summarize(findings: readonly Finding[]): {
	error: number;
	warning: number;
	info: number;
	accepted: number;
	total: number;
} {
	const live = findings.filter(finding => !finding.accepted);
	return {
		error: live.filter(finding => finding.severity === 'error').length,
		warning: live.filter(finding => finding.severity === 'warning').length,
		info: live.filter(finding => finding.severity === 'info').length,
		accepted: findings.length - live.length,
		total: live.length,
	};
}
