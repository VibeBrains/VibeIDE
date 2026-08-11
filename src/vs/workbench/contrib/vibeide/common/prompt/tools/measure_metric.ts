/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const MEASURE_METRIC_TOOL: ToolDef<'measure_metric'> = {
	name: 'measure_metric',
	// Запускает процесс, поэтому проходит через тот же гейт, что и терминал. Команду при этом
	// выбирает не модель, а настройка проекта — подменить измеритель на удобный нельзя.
	approvalType: 'terminal',
	description: `Runs the project's measurement command and answers whether the change is an improvement — with a number, not an impression.

Use it for tasks that have a metric rather than a right answer: make this faster, shrink the bundle, raise coverage, cut token spend. Take a 'baseline' measurement BEFORE touching anything, then a 'candidate' one after each change.

The verdict is decided here, not by you:
- 'keep' — the metric improved beyond the noise threshold. Keep the change and carry on.
- 'discard' — the metric got worse. Roll the change back before trying anything else.
- 'noise' — the change is within measurement jitter. Roll it back too: an unprovable change is not worth its risk.
- 'unmeasured' — the command produced no number. Fix the measurement, do not guess at the result.

Two rules make the loop honest, and both are enforced outside your control: every run gets the same time budget, and the measurement command and its config are read-only for the duration. A metric you could edit would measure nothing.

When 'configured' is false the project has not set a measurement command — say so and ask for one instead of inventing a benchmark.`,
	params: {
		purpose: { description: `'baseline' for the reference measurement taken before any change, 'candidate' for a measurement after one.` },
		summary: { description: `One short line describing what this attempt changed, for the optimization log. Omit for the baseline.` },
	},
};
