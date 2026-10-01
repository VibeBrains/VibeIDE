/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideHooks, verdictOf, VIBE_HOOK_REFUSE_EXIT_CODE, VibeHookVerdict } from '../../common/hooks/hookOutcome.js';
import { GatedOutcome, gateVerdictOf, GateVerdict, StepStart, stepStart, verdictAfterGroup, waveVerdict } from '../../common/pipeline/pipelineGate.js';
import { buildStepInput, PipelineStepOutcome, stepCountsAsDone, VibePipelineStep } from '../../common/pipeline/vibePipelineFile.js';

const run = (over: { exitCode?: number | undefined; stdout?: string; stderr?: string; timedOut?: boolean } = {}) => ({
	hook: { event: 'pipelineStepEnd' as const, command: 'node gate.js', tools: [], timeoutMs: 1000, label: undefined },
	exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 5, ...over,
});

/** How each step that runs ends: its status, and the gate's word when it succeeded. */
type StepEnd = { readonly status: 'success' | 'failed'; readonly verdict?: boolean };

/**
 * The service's loop over single steps without agents: each step that runs ends as `ends` says.
 * Built from the same pure pieces the service is, so the order «failure first, then the gate» is the one under test.
 */
function simulate(steps: readonly VibePipelineStep[], ends: readonly StepEnd[]): { readonly starts: readonly StepStart[]; readonly completed: boolean } {
	const outcomes: PipelineStepOutcome[] = [];
	const starts: StepStart[] = [];
	let verdict: GateVerdict;
	steps.forEach((step, index) => {
		const start = stepStart(step, outcomes, verdict);
		starts.push(start);
		const base = { role: step.role, step: index + 1, summary: `итог ${index + 1}`, artifacts: [] };
		const end = ends[index];
		const member: GatedOutcome = start === 'run'
			? { outcome: { ...base, status: end.status }, verdict: end.status === 'success' ? end.verdict : undefined }
			: { outcome: { ...base, status: 'skipped', ...(start === 'skipByGate' ? { skippedByGate: true as const } : {}) }, verdict: undefined };
		outcomes.push(member.outcome);
		verdict = verdictAfterGroup(verdict, [member]);
	});
	return { starts, completed: outcomes.every(stepCountsAsDone) };
}

/**
 * Каскад отдельным шагом
 * Гейт `pipelineStepEnd` после каждого успешного шага решает, нужен ли следующий шаг `escalation`
 *
 * Правила VibeIDEA, кроме одного сознательного отличия: шаг, пропущенный гейтом, передаёт вердикт дальше,
 * и лестница «дешёвая → средняя → дорогая» на одном «принято» не запускает ни одной ступени.
 */
suite('pipelineGate — каскад отдельным шагом', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const draft: VibePipelineStep = { role: 'code-reviewer', task: 'черновик ревью', model: 'minimax/MiniMax-M3' };
	const mid: VibePipelineStep = { role: 'critic', task: 'доработай', model: 'zai/glm-5.3', escalation: true };
	const top: VibePipelineStep = { role: 'critic', task: 'доработай всерьёз', model: 'anthropic/claude-fable-5-1', escalation: true };
	const tail: VibePipelineStep = { role: 'planner', task: 'сведи итог' };

	test('вердикт гейта: нет хука и только сломанные — вердикта нет, код 0 — принято, код 2 и отказ JSON — не принято', () => {
		const gate = (verdicts: VibeHookVerdict[]) => gateVerdictOf(decideHooks('pipelineStepEnd', verdicts));
		const broken = verdictOf(run({ exitCode: 1 }));
		const timedOut = verdictOf(run({ exitCode: undefined, timedOut: true }));
		assert.deepStrictEqual({
			noHook: gate([]),
			onlyBroken: gate([broken, timedOut]),
			exit0: gate([verdictOf(run())]),
			exit0WithNote: gate([verdictOf(run({ stdout: 'годится' }))]),
			brokenBesideExit0: gate([broken, verdictOf(run())]),
			exit2: gate([verdictOf(run({ exitCode: VIBE_HOOK_REFUSE_EXIT_CODE, stderr: 'черновик неполон' }))]),
			deny: gate([verdictOf(run({ stdout: '{"decision":"deny","reason":"нет"}' }))]),
		}, {
			noHook: undefined,
			onlyBroken: undefined,
			exit0: true,
			exit0WithNote: true,
			brokenBesideExit0: true,
			exit2: false,
			deny: false,
		});
	});

	test('волна: принято, только если приняли все судимые; никого не судили — вердикта нет', () => {
		assert.deepStrictEqual(
			[waveVerdict([true, true]), waveVerdict([true, false]), waveVerdict([undefined, undefined]), waveVerdict([true, undefined]), waveVerdict([])],
			[true, false, undefined, true, undefined],
		);
	});

	test('лестница: «принято» о черновике проходит через пропущенную ступень, и дорогая не запускается', () => {
		assert.deepStrictEqual(simulate([draft, mid, top, tail], [{ status: 'success', verdict: true }, { status: 'success' }, { status: 'success' }, { status: 'success' }]), {
			starts: ['run', 'skipByGate', 'skipByGate', 'run'],
			completed: true,
		});
	});

	test('лестница: отказ гейта запускает следующую ступень, а её «принято» снимает дорогую', () => {
		assert.deepStrictEqual(simulate([draft, mid, top, tail], [{ status: 'success', verdict: false }, { status: 'success', verdict: true }, { status: 'success' }, { status: 'success' }]), {
			starts: ['run', 'run', 'skipByGate', 'run'],
			completed: true,
		});
	});

	test('без гейта принимать нечем — ступени эскалации выполняются все', () => {
		assert.deepStrictEqual(simulate([draft, mid, top], [{ status: 'success' }, { status: 'success' }, { status: 'success' }]), {
			starts: ['run', 'run', 'run'],
			completed: true,
		});
	});

	test('упавший черновик: шаг эскалации пропущен как после провала, если не continueOnFailure, и прогон не завершён', () => {
		assert.deepStrictEqual([
			simulate([draft, mid, tail], [{ status: 'failed' }, { status: 'success' }, { status: 'success' }]),
			simulate([draft, { ...mid, continueOnFailure: true }, tail], [{ status: 'failed' }, { status: 'success', verdict: true }, { status: 'success' }]),
		], [
			{ starts: ['run', 'skipAfterFailure', 'skipAfterFailure'], completed: false },
			{ starts: ['run', 'run', 'skipAfterFailure'], completed: false },
		]);
	});

	test('вердикт относится к одному шагу: обычный шаг между черновиком и эскалацией его гасит', () => {
		assert.deepStrictEqual(simulate([draft, tail, mid], [{ status: 'success', verdict: true }, { status: 'success' }, { status: 'success' }]), {
			starts: ['run', 'run', 'run'],
			completed: true,
		});
	});

	test('после волны вердикт — общий: шаг эскалации пропускается, только если приняли всех', () => {
		const member = (verdict: GateVerdict): GatedOutcome => ({ outcome: { role: 'code-reviewer', step: 1, wave: 'w', status: 'success', summary: '', artifacts: [] }, verdict });
		assert.deepStrictEqual(
			[verdictAfterGroup(undefined, [member(true), member(true)]), verdictAfterGroup(true, [member(true), member(false)]), verdictAfterGroup(true, [member(undefined), member(undefined)])],
			[true, false, undefined],
		);
	});

	test('следующий шаг после пропуска гейтом слышит принятый черновик как предыдущий шаг', () => {
		const accepted: PipelineStepOutcome = { role: 'code-reviewer', step: 1, status: 'success', summary: 'нашёл два дефекта', artifacts: ['src/a.ts'] };
		const spared: PipelineStepOutcome = { role: 'critic', step: 2, status: 'skipped', skippedByGate: true, summary: 'Пропущен: гейт принял', artifacts: [] };
		assert.deepStrictEqual(buildStepInput(tail, [accepted, spared], 3), {
			goal: 'сведи итог\n\nПредыдущий шаг (code-reviewer) сообщил: нашёл два дефекта\n\nФайлы, затронутые предыдущими шагами (прочитайте нужные сами): src/a.ts',
			contextItems: ['src/a.ts'],
		});
	});
});
