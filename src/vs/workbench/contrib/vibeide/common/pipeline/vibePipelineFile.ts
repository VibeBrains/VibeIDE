/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pipelines — a sequence of agent steps where each step picks up what the previous one produced.
 *
 * We already had the pieces: roles decide which tools an agent gets, the budget caps what it may
 * spend, the ledger records what it did, and a subagent already returns `{summary, artifacts}`.
 * What was missing is the line connecting them — «сначала спроектируй, потом реализуй, потом
 * проверь», with step three actually knowing what step two touched.
 *
 * Decisions that shape the whole feature:
 *
 * - **Artifacts are passed as PATHS, not contents.** A step that inlines every file the previous
 *   one wrote would blow the context window on the third step of any real task, and it would do so
 *   silently. Paths plus a summary let the next agent read exactly what it needs with the tools it
 *   already has.
 * - **Paths accumulate, the summary does not.** Step four can still open a file step one created —
 *   losing it would make long pipelines useless — but it hears the story only from step three.
 *   Concatenating every summary turns the prompt into a diary nobody asked for.
 * - **A failed step stops the pipeline by default.** Continuing means step three works on the
 *   assumption that step two succeeded, and the result looks like work while being founded on
 *   nothing. `continueOnFailure` exists for the genuinely independent step, and it must be typed
 *   out on purpose.
 */

/** Wire version of `.vibe/pipelines.json`. */
export const VIBE_PIPELINE_FORMAT_VERSION = 1;

/** Hard cap on steps in one pipeline — a runaway file should not spawn a hundred agents. */
export const MAX_PIPELINE_STEPS = 20;

export interface VibePipelineStep {
	/** Subagent role id (`coder`, `reviewer`, …) — decides the tool whitelist. */
	readonly role: string;
	/** What this step must do. */
	readonly task: string;
	/** Optional definition of done, handed to the agent verbatim. */
	readonly acceptance?: string;
	/** Token ceiling for this step; absent = the subagent default. */
	readonly maxTokens?: number;
	/** Tool-call ceiling for this step; absent = the subagent default. */
	readonly maxSteps?: number;
	/** Run even when an earlier step failed. Off by default — see the module comment. */
	readonly continueOnFailure?: boolean;
	/** Do not hand this step the previous artifacts (a deliberately fresh pair of eyes). */
	readonly ignorePreviousArtifacts?: boolean;
}

export interface VibePipeline {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly steps: readonly VibePipelineStep[];
}

export interface VibePipelineFile {
	readonly version: number;
	readonly pipelines: readonly VibePipeline[];
}

export interface ParsedPipelineFile {
	readonly file: VibePipelineFile;
	/** Problems that did not stop parsing — a bad pipeline is skipped, the rest still run. */
	readonly warnings: readonly string[];
}

/**
 * Parse `.vibe/pipelines.json`.
 *
 * A malformed pipeline is dropped with a warning rather than failing the whole file: one typo in
 * the fifth pipeline must not take away the four that are fine — that is the behaviour the
 * providers file already established, and users expect the same shape of forgiveness.
 */
export function parsePipelineFile(raw: unknown): ParsedPipelineFile {
	const warnings: string[] = [];
	const empty: VibePipelineFile = { version: VIBE_PIPELINE_FORMAT_VERSION, pipelines: [] };
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { file: empty, warnings: ['pipelines.json: корень должен быть объектом'] };
	}
	const obj = raw as Record<string, unknown>;
	const version = typeof obj['version'] === 'number' ? obj['version'] : VIBE_PIPELINE_FORMAT_VERSION;
	const rawPipelines = obj['pipelines'];
	if (!Array.isArray(rawPipelines)) {
		return { file: empty, warnings: ['pipelines.json: поле pipelines должно быть массивом'] };
	}

	const pipelines: VibePipeline[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < rawPipelines.length; i++) {
		const entry = rawPipelines[i];
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			warnings.push(`pipelines[${i}]: не объект — пропущен`);
			continue;
		}
		const p = entry as Record<string, unknown>;
		const id = typeof p['id'] === 'string' ? p['id'].trim() : '';
		if (!id) {
			warnings.push(`pipelines[${i}]: нет поля id — пропущен`);
			continue;
		}
		if (seenIds.has(id)) {
			// Silently keeping both would make "run pipeline X" ambiguous, and the user would never
			// know which one ran.
			warnings.push(`pipelines[${i}]: id «${id}» уже занят — пропущен`);
			continue;
		}
		const rawSteps = p['steps'];
		if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
			warnings.push(`pipelines[${i}] «${id}»: нужен непустой массив steps — пропущен`);
			continue;
		}
		if (rawSteps.length > MAX_PIPELINE_STEPS) {
			warnings.push(`pipelines[${i}] «${id}»: больше ${MAX_PIPELINE_STEPS} шагов — пропущен`);
			continue;
		}
		const steps: VibePipelineStep[] = [];
		let stepsOk = true;
		for (let j = 0; j < rawSteps.length; j++) {
			const parsedStep = parseStep(rawSteps[j]);
			if (!parsedStep.ok) {
				warnings.push(`pipelines[${i}] «${id}», шаг ${j + 1}: ${parsedStep.reason} — пайплайн пропущен`);
				stepsOk = false;
				break;
			}
			steps.push(parsedStep.value);
		}
		if (!stepsOk) { continue; }
		seenIds.add(id);
		pipelines.push({
			id,
			...(typeof p['name'] === 'string' && p['name'] ? { name: p['name'] } : {}),
			...(typeof p['description'] === 'string' && p['description'] ? { description: p['description'] } : {}),
			steps,
		});
	}
	return { file: { version, pipelines }, warnings };
}

function parseStep(raw: unknown): { ok: true; value: VibePipelineStep } | { ok: false; reason: string } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { ok: false, reason: 'не объект' }; }
	const s = raw as Record<string, unknown>;
	const role = typeof s['role'] === 'string' ? s['role'].trim() : '';
	if (!role) { return { ok: false, reason: 'нет поля role' }; }
	const task = typeof s['task'] === 'string' ? s['task'].trim() : '';
	if (!task) { return { ok: false, reason: 'нет поля task' }; }
	const positive = (key: string): number | undefined => {
		const v = s[key];
		return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
	};
	const maxTokens = positive('maxTokens');
	const maxSteps = positive('maxSteps');
	return {
		ok: true,
		value: {
			role,
			task,
			...(typeof s['acceptance'] === 'string' && s['acceptance'] ? { acceptance: s['acceptance'] } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(maxSteps !== undefined ? { maxSteps } : {}),
			...(s['continueOnFailure'] === true ? { continueOnFailure: true } : {}),
			...(s['ignorePreviousArtifacts'] === true ? { ignorePreviousArtifacts: true } : {}),
		},
	};
}

/** What one finished step leaves behind for the next one. */
export interface PipelineStepOutcome {
	readonly role: string;
	readonly status: 'success' | 'failed' | 'stopped' | 'skipped';
	readonly summary: string;
	readonly artifacts: readonly string[];
}

export interface PipelineStepInput {
	/** Goal handed to the subagent. */
	readonly goal: string;
	/** Context items (artifact paths) injected into the subagent's first message. */
	readonly contextItems: readonly string[];
}

/**
 * Build the input for step `index` from what came before.
 *
 * The previous step's story is told once, in words, and the files are listed as paths. Both parts
 * are omitted entirely when there is nothing to say — an agent told "предыдущий шаг ничего не
 * изменил" as a matter of routine starts to ignore the section.
 */
export function buildStepInput(
	step: VibePipelineStep,
	previous: readonly PipelineStepOutcome[],
): PipelineStepInput {
	if (step.ignorePreviousArtifacts || previous.length === 0) {
		return { goal: composeGoal(step), contextItems: [] };
	}
	// Deduplicated in order: the same file touched by three steps is still one file, and repeating
	// it would spend the next agent's attention on noise.
	const seen = new Set<string>();
	const artifacts: string[] = [];
	for (const outcome of previous) {
		for (const path of outcome.artifacts) {
			if (path && !seen.has(path)) { seen.add(path); artifacts.push(path); }
		}
	}
	const last = previous[previous.length - 1];
	const parts = [composeGoal(step)];
	if (last.summary) {
		parts.push(`Предыдущий шаг (${last.role}) сообщил: ${last.summary}`);
	}
	if (artifacts.length > 0) {
		parts.push(`Файлы, затронутые предыдущими шагами (прочитайте нужные сами): ${artifacts.join(', ')}`);
	}
	return { goal: parts.join('\n\n'), contextItems: artifacts };
}

function composeGoal(step: VibePipelineStep): string {
	return step.acceptance ? `${step.task}\n\nКритерий готовности: ${step.acceptance}` : step.task;
}

/**
 * Should the pipeline run this step, given what happened so far?
 *
 * Written as a separate decision rather than an `if` inside the loop because "when do we stop" is
 * the question a reader of a pipeline runner asks first.
 */
export function shouldRunStep(step: VibePipelineStep, previous: readonly PipelineStepOutcome[]): boolean {
	if (step.continueOnFailure) { return true; }
	return previous.every(o => o.status === 'success');
}
