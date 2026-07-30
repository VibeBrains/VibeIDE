/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Comparing a run with its replay — "the same goal on another model, what changed".
 *
 * The ledger already records what each run spent; this turns two records into an answer. Every
 * dimension is optional on purpose: a run that never reported steps must produce "неизвестно"
 * rather than a delta computed from a missing number. A comparison that quietly treats absence
 * as zero is worse than one that admits it cannot tell — it invents a winner.
 *
 * Pure: records in, verdict out. Cost is supplied by the caller, because pricing lives in the
 * capabilities catalogue outside this layer.
 */

import { AgentRunRecord } from './agentRunLedger.js';

export interface RunCostInput {
	/** Estimated cost in USD, or undefined when the model's price is unknown. */
	readonly originalUsd?: number;
	readonly replayUsd?: number;
}

export interface ComparisonDimension {
	readonly label: string;
	readonly original?: number;
	readonly replay?: number;
	/** `replay - original`, or undefined when either side is missing. */
	readonly delta?: number;
	/** True when at least one side had nothing to compare. */
	readonly unavailable: boolean;
	/** Formatter hint for the renderer. */
	readonly unit: 'tokens' | 'steps' | 'seconds' | 'usd';
}

export interface RunComparison {
	readonly originalRunId: string;
	readonly replayRunId: string;
	readonly originalModel: string;
	readonly replayModel: string;
	readonly dimensions: readonly ComparisonDimension[];
	/** Both runs finished successfully — a comparison against a failed run means little. */
	readonly bothSucceeded: boolean;
}

function durationSeconds(record: AgentRunRecord): number | undefined {
	return record.endedAt !== undefined ? Math.max(0, Math.round((record.endedAt - record.startedAt) / 1000)) : undefined;
}

function dimension(label: string, unit: ComparisonDimension['unit'], original?: number, replay?: number): ComparisonDimension {
	const unavailable = original === undefined || replay === undefined;
	return {
		label,
		original,
		replay,
		delta: unavailable ? undefined : replay - original,
		unavailable,
		unit,
	};
}

/** Fold two runs into the dimensions worth looking at. Pure. */
export function compareRuns(original: AgentRunRecord, replay: AgentRunRecord, costs: RunCostInput = {}): RunComparison {
	return {
		originalRunId: original.runId,
		replayRunId: replay.runId,
		originalModel: original.model ?? 'неизвестно',
		replayModel: replay.model ?? 'неизвестно',
		bothSucceeded: original.status === 'completed' && replay.status === 'completed',
		dimensions: [
			dimension('Токены', 'tokens', original.tokensUsed, replay.tokensUsed),
			dimension('Шаги', 'steps', original.stepsDone, replay.stepsDone),
			dimension('Время', 'seconds', durationSeconds(original), durationSeconds(replay)),
			dimension('Стоимость', 'usd', costs.originalUsd, costs.replayUsd),
		],
	};
}

function formatValue(value: number | undefined, unit: ComparisonDimension['unit']): string {
	if (value === undefined) {
		return '—';
	}
	switch (unit) {
		case 'usd': return `$${value.toFixed(4)}`;
		case 'seconds': return `${value.toLocaleString('ru-RU')} с`;
		default: return value.toLocaleString('ru-RU');
	}
}

/** Signed delta with the direction spelled out, because "-12%" alone reads ambiguously. */
function formatDelta(dim: ComparisonDimension): string {
	if (dim.unavailable || dim.delta === undefined) {
		return 'нельзя сравнить';
	}
	if (dim.delta === 0) {
		return 'без изменений';
	}
	const sign = dim.delta > 0 ? '+' : '−';
	const magnitude = formatValue(Math.abs(dim.delta), dim.unit);
	const share = dim.original ? ` (${dim.delta > 0 ? '+' : '−'}${Math.round(Math.abs(dim.delta) / dim.original * 100)}%)` : '';
	// Less is better for every dimension here, so the wording states the outcome, not just the sign.
	const verdict = dim.delta > 0 ? 'дороже' : 'дешевле';
	return `${sign}${magnitude}${share} — ${verdict}`;
}

/** Render the comparison as the markdown report the panel opens. Pure. */
export function renderRunComparisonMarkdown(comparison: RunComparison): string {
	const lines: string[] = [
		'# Повтор прогона: сравнение',
		'',
		`Исходный прогон на модели \`${comparison.originalModel}\`, повтор на \`${comparison.replayModel}\`.`,
		'',
	];

	if (!comparison.bothSucceeded) {
		lines.push(
			'> **Один из прогонов не завершился успешно.** Числа ниже сравнивают разное: прогон, который'
			+ ' остановился раньше, почти всегда «дешевле». Ориентируйтесь на итог, а не на дельту.',
			'',
		);
	}

	lines.push('| Что | Исходный | Повтор | Разница |', '|---|---|---|---|');
	for (const dim of comparison.dimensions) {
		lines.push(`| ${dim.label} | ${formatValue(dim.original, dim.unit)} | ${formatValue(dim.replay, dim.unit)} | ${formatDelta(dim)} |`);
	}

	lines.push(
		'',
		`Прогоны: \`${comparison.originalRunId}\` → \`${comparison.replayRunId}\`.`,
		'',
		'Повтор выполняет задачу заново, а не воспроизводит записанные шаги: если роль умеет писать файлы,'
		+ ' она сделает это ещё раз.',
		'',
	);

	return lines.join('\n') + '\n';
}
