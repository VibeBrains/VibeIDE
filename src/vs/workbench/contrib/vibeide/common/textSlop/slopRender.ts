/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A text-slop report as the model reads it: the verdict first, then the findings, most severe first.
 *
 * The layout and the words are those of VibeIDEA's answer to the same tool: the `anti-slop` skill of the shared
 * `.vibe` set describes this answer, and one skill cannot describe two different ones.
 */

import { slopSeverityRank } from './slopCatalog.js';
import { SlopFinding, SlopReport } from './textSlop.js';

/** Past this many findings the answer stops being read; the number of the rest is still given. */
const MAX_FINDINGS = 30;

/** Most severe first, then in text order: what keeps the text from passing is what has to be read first. */
function ordered(findings: readonly SlopFinding[]): SlopFinding[] {
	return [...findings].sort((a, b) => slopSeverityRank(b.severity) - slopSeverityRank(a.severity) || a.line - b.line || a.column - b.column);
}

/** One decimal at most, none for a whole number: `85`, `12.5`. */
function numberOf(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function findingLine(finding: SlopFinding): string {
	const head = `- строка ${finding.line}:${finding.column} [${finding.rule}] ${finding.name} (${finding.severity}): `;
	// A project's own rule may come without a fix; an arrow pointing at nothing reads as a cut-off line.
	const fix = finding.fix ? ` → ${finding.fix}` : '';
	const density = finding.density;
	if (!density) {
		return `${head}«${finding.match}»${fix}`;
	}
	return `${head}${density.count} раз, ${numberOf(density.perThousand)} на 1000 слов, строки ${density.lines.join(', ')}${fix}`;
}

/**
 * The report as text. `warnings` are what could not be applied from the catalogue or the project's `.vibe/slop.json`:
 * a rule the project believes is on but is not is said out loud rather than dropped.
 */
export function renderSlopReport(report: SlopReport, warnings: readonly string[], maxFindings = MAX_FINDINGS): string {
	const lines = [`Нейрослоп: ${numberOf(report.score)}/100 (проход — от ${numberOf(report.passScore)}), ${report.passed ? 'проходит' : 'не проходит'}, находок: ${report.findings.length}`];
	if (report.blocking.length > 0) {
		lines.push(`Не пропускают: ${report.blocking.join(', ')}`);
	}
	const findings = ordered(report.findings);
	lines.push(...findings.slice(0, maxFindings).map(findingLine));
	if (findings.length > maxFindings) {
		lines.push(`…и ещё ${findings.length - maxFindings}`);
	}
	if (warnings.length > 0) {
		lines.push(`Предупреждения: ${warnings.join('; ')}`);
	}
	return lines.join('\n');
}
