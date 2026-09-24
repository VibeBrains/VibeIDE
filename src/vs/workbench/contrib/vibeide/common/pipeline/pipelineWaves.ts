/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { effectiveWriteScope, ParsedPipelineFile, VibePipeline, VibePipelineStep, WriteScope } from './vibePipelineFile.js';

/**
 * Waves: steps that follow each other with the same `wave` label and run at once.
 *
 * The rules are VibeIDEA's (`PipelineWaves.kt`, `RolePaths.provablyDisjoint`): the shared `pipelines.json`
 * runs in both products, and a file one of them loads and the other refuses is a file nobody can rely on.
 * Running at once is safe only for steps that cannot step on each other, and every rule guards one way
 * they could:
 * - the label must not come back after another step — a wave is one run of steps, not a set scattered
 *   over the file;
 * - `offPeak` holds a step until its model's price drops, which would start the wave's steps at
 *   different times;
 * - two steps that write must write to provably separate places: each write is checked against its own
 *   step's boundary only, and two steps allowed the same file would race for it.
 *
 * VibeIDEA also refuses `escalation` and `context: "shared"` in a wave. Neither exists here: our cascade
 * lives on the step itself (`escalateTo`, `reviewWith`), so a wave step escalates and is reviewed like
 * any other, and every step already runs in its own conversation.
 *
 * Pure: steps in, verdicts out.
 */

/** A run of steps in file order: a wave, or one step on its own. Indices are inclusive. */
export interface StepGroup {
	readonly start: number;
	readonly end: number;
	/** The label — set only for a run of two or more steps: a label on one step alone runs as an ordinary step. */
	readonly wave?: string;
}

/** What a wave check needs to know about roles, from outside the pipeline file. */
export interface WaveRules {
	/** Whether a role writes files — read off its tool whitelist. */
	readonly roleMayWrite: (role: string) => boolean;
	/** The `qa` write boundary: `.vibe/roles.json` when the project declares one, the built-in list otherwise. */
	readonly qaWritePaths: readonly string[];
}

export interface WaveCheck {
	/** Reasons the pipeline must not run — it is skipped with them. */
	readonly problems: readonly string[];
	/** Worth saying, not worth refusing. */
	readonly warnings: readonly string[];
}

/** Runs of neighbours sharing a label, a label on a single step included — the unit the checks speak about. */
function labelledRuns(steps: readonly Pick<VibePipelineStep, 'wave'>[]): { start: number; end: number; label?: string }[] {
	const runs: { start: number; end: number; label?: string }[] = [];
	let start = 0;
	while (start < steps.length) {
		const label = steps[start].wave;
		let end = start;
		if (label !== undefined) {
			while (end + 1 < steps.length && steps[end + 1].wave === label) {
				end++;
			}
		}
		runs.push({ start, end, ...(label !== undefined ? { label } : {}) });
		start = end + 1;
	}
	return runs;
}

/** The steps as the pipeline runs them: each group starts when the previous one has finished. */
export function pipelineGroups(steps: readonly Pick<VibePipelineStep, 'wave'>[]): StepGroup[] {
	return labelledRuns(steps).map(run => ({
		start: run.start,
		end: run.end,
		...(run.label !== undefined && run.end > run.start ? { wave: run.label } : {}),
	}));
}

/** Whether the waves of `steps` can run at once. */
export function checkWaves(steps: readonly VibePipelineStep[], rules: WaveRules): WaveCheck {
	const problems: string[] = [];
	const warnings: string[] = [];
	const finished = new Set<string>();
	for (const run of labelledRuns(steps)) {
		const label = run.label;
		if (label === undefined) {
			continue;
		}
		if (finished.has(label)) {
			problems.push(`волна «${label}»: шаги с одной меткой должны идти подряд, а метка вернулась после другого шага`);
		}
		finished.add(label);
		const members = steps.slice(run.start, run.end + 1);
		if (members.length === 1) {
			warnings.push(`волна «${label}» из одного шага — он идёт как обычный`);
			continue;
		}
		const offPeak = members.find(step => step.offPeak);
		if (offPeak) {
			problems.push(`волна «${label}»: шаг «${offPeak.role}» с offPeak ждал бы конца пика один и развёл бы старт шагов волны во времени`);
		}
		const writers = members.filter(step => rules.roleMayWrite(step.role));
		for (let i = 0; i < writers.length; i++) {
			for (let j = i + 1; j < writers.length; j++) {
				const first = scopeOf(writers[i], rules);
				const second = scopeOf(writers[j], rules);
				if (!provablyDisjoint(first, second)) {
					problems.push(`волна «${label}»: «${writers[i].role}» (${describeScope(first)}) и «${writers[j].role}» (${describeScope(second)}) могут писать в одно место — дайте каждому paths с раздельными каталогами в начале`);
				}
			}
		}
		// A judge next to a writer reads the writer's work while it is being written: allowed, but said out loud.
		const judge = members.find(step => !rules.roleMayWrite(step.role));
		if (judge && writers.length > 0) {
			warnings.push(`волна «${label}»: «${judge.role}» идёт одновременно с «${writers[0].role}» и увидит его работу недоделанной — ревью лучше ставить следующей волной`);
		}
	}
	return { problems, warnings };
}

/**
 * The file with its wave rules applied: a pipeline whose waves cannot run at once is skipped with the
 * reasons, not run differently from what it says.
 */
export function applyWaveRules(parsed: ParsedPipelineFile, rules: WaveRules): ParsedPipelineFile {
	const warnings = [...parsed.warnings];
	const pipelines: VibePipeline[] = [];
	for (const pipeline of parsed.file.pipelines) {
		const check = checkWaves(pipeline.steps, rules);
		if (check.problems.length > 0) {
			warnings.push(...check.problems.map(problem => `«${pipeline.id}»: ${problem} — пайплайн пропущен`));
			continue;
		}
		warnings.push(...check.warnings.map(warning => `«${pipeline.id}»: ${warning}`));
		pipelines.push(pipeline);
	}
	return { file: { ...parsed.file, pipelines }, warnings };
}

/** Where the step may write — the same boundary each of its writes is checked against. */
function scopeOf(step: VibePipelineStep, rules: WaveRules): WriteScope | undefined {
	const stated = step.paths || step.denyPaths ? { ...(step.paths ? { paths: step.paths } : {}), ...(step.denyPaths ? { denyPaths: step.denyPaths } : {}) } : undefined;
	return effectiveWriteScope(step.role, stated, rules.qaWritePaths);
}

function describeScope(scope: WriteScope | undefined): string {
	return scope?.paths && scope.paths.length > 0 ? scope.paths.join(', ') : '**';
}

/**
 * Whether no path can be writable under both scopes — PROVABLY, not probably.
 *
 * Anything the proof cannot establish counts as overlap:
 * - a scope without an allow list writes anywhere;
 * - a pattern must start with a literal directory: one that opens with a double star or a wildcard, or a
 *   bare name like `*.md`, applies at any depth, and no prefix says where it ends;
 * - two literal prefixes overlap when one is the other or lies inside it, compared with case folded — on
 *   APFS and NTFS `Src/` is `src/`.
 * Deny lists, negations and comments are left out: they only narrow, and ignoring them can only err
 * towards refusing.
 */
export function provablyDisjoint(a: WriteScope | undefined, b: WriteScope | undefined): boolean {
	const left = literalPrefixes(a);
	const right = literalPrefixes(b);
	if (!left || !right) {
		return false;
	}
	return left.every(l => right.every(r => !nested(l, r) && !nested(r, l)));
}

function literalPrefixes(scope: WriteScope | undefined): string[][] | undefined {
	// `!` re-excludes and `#` is a comment in the `.gitignore` syntax of `paths`: neither widens the scope.
	const patterns = (scope?.paths ?? []).map(pattern => pattern.trim()).filter(pattern => pattern.length > 0 && !pattern.startsWith('!') && !pattern.startsWith('#'));
	if (patterns.length === 0) {
		return undefined;
	}
	const prefixes: string[][] = [];
	for (const pattern of patterns) {
		const prefix = literalPrefix(pattern);
		if (!prefix) {
			return undefined;
		}
		prefixes.push(prefix);
	}
	return prefixes;
}

/**
 * Where `pattern` is anchored: its leading literal segments, case folded, or `undefined` when it has none.
 *
 * Read by the rules of the matcher `paths` are checked with (`parseIgnore`, `.gitignore` proper): one
 * trailing slash is dropped, and a pattern is anchored at the root only by a leading slash or a slash
 * inside. So `docs/` matches a `docs` folder at ANY depth and proves nothing here, while VibeIDEA's own
 * matcher anchors it at the root — `docs/**` reads the same way in both products.
 */
export function literalPrefix(pattern: string): string[] | undefined {
	let line = pattern.trim();
	if (line.endsWith('/')) {
		line = line.slice(0, -1);
	}
	const hadLeadingSlash = line.startsWith('/');
	if (hadLeadingSlash) {
		line = line.slice(1);
	}
	if (line.length === 0 || !(hadLeadingSlash || line.includes('/'))) {
		return undefined;
	}
	const literal: string[] = [];
	for (const segment of line.split('/')) {
		// `*` and `?` are the only wildcards the matcher knows (`vibeIgnore.ts`); a bracket is literal there.
		if (segment.length === 0 || /[*?]/.test(segment)) {
			break;
		}
		literal.push(segment);
	}
	if (literal.length === 0 || literal.some(segment => segment === '.' || segment === '..')) {
		return undefined;
	}
	return literal.map(segment => segment.normalize('NFC').toLowerCase());
}

function nested(outer: readonly string[], inner: readonly string[]): boolean {
	return outer.length <= inner.length && outer.every((segment, i) => inner[i] === segment);
}
