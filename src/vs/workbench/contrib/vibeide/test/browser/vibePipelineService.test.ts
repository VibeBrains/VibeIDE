/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { VibePipelineService } from '../../browser/vibePipelineService.js';
import { IVibeDynamicProvidersService } from '../../browser/vibeDynamicProvidersService.js';
import { IVibeVerifyGateService } from '../../browser/vibeVerifyGateService.js';
import { IAuditLogService } from '../../common/auditLogService.js';
import { IVibeHooksService } from '../../common/hooks/vibeHookTypes.js';
import { composePipelineBrief } from '../../common/pipeline/vibePipelineFile.js';
import { IVibeSubagentService, SubagentHandoff, SubagentResult } from '../../common/vibeSubagentService.js';
import { IVibeideSettingsService } from '../../common/vibeideSettingsService.js';
import { IVibeRunDiffService } from '../../common/vibeideSCMTypes.js';

/** Takes every step as it is handed over and answers from a script: what the next step is told is under test, not a model */
class ScriptedSubagents extends mock<IVibeSubagentService>() {
	readonly handoffs: SubagentHandoff[] = [];
	constructor(private readonly answers: Record<string, Pick<SubagentResult, 'summary' | 'artifacts'>>) { super(); }

	override async spawn(handoff: SubagentHandoff): Promise<string> {
		this.handoffs.push(handoff);
		return `agent-${this.handoffs.length}`;
	}

	override async awaitResult(subagentId: string): Promise<SubagentResult> {
		const handoff = this.handoffs[Number(subagentId.replace('agent-', '')) - 1];
		return { subagentId, status: 'success', tokensUsed: 0, ...this.answers[handoff.type] };
	}

	override async launchRefusal(): Promise<string | undefined> {
		return undefined;
	}

	override disposeSubagent(): void { }
}

/** The journal of runs is written atomically, as it is on a disk */
class AtomicInMemoryProvider extends InMemoryFileSystemProvider {
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite;
	}
}

class NoHooks extends mock<IVibeHooksService>() {
	override async run() {
		return { blocked: false, ran: false, agentMessage: undefined, brokenHooks: [] };
	}
}

/** A folder without git: nothing is pinned, and a judge's diff says so */
class NoGitRunDiff extends mock<IVibeRunDiffService>() {
	override async pin(): Promise<string | undefined> {
		return undefined;
	}
	override async release(): Promise<void> { }
}

suite('VibePipelineService — что шаг узнаёт о прогоне', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const PLANNER_SAYS = 'ВСЕ ТРЕБОВАНИЯ ВЫПОЛНЕНЫ, ОШИБОК НЕТ';

	async function runPipeline(criticFields: object) {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new AtomicInMemoryProvider())));
		const pipeline = {
			id: 'check', name: 'Экран по брифу', description: 'Собрать и проверить', steps: [
				{ role: 'planner', task: 'Разбери задачу на требования' },
				{ role: 'critic', task: 'Сверь результат с задачей', ...criticFields },
			],
		};
		await fileService.writeFile(URI.file('/ws/.vibe/pipelines.json'), VSBuffer.fromString(JSON.stringify({ version: 1, pipelines: [pipeline] })));
		const subagents = new ScriptedSubagents({
			planner: { summary: PLANNER_SAYS, artifacts: ['docs/plan.md'] },
			critic: { summary: 'ВЕРДИКТ: принято', artifacts: [] },
		});
		const service = disposables.add(new VibePipelineService(
			fileService,
			new TestContextService(testWorkspace(URI.file('/ws'))),
			subagents,
			new NoHooks(),
			new TestConfigurationService(),
			new class extends mock<IVibeideSettingsService>() { },
			new class extends mock<INotificationService>() { },
			new NoGitRunDiff(),
			new class extends mock<IVibeVerifyGateService>() { },
			new class extends mock<IVibeDynamicProvidersService>() { },
			new class extends mock<IAuditLogService>() { },
		));
		const result = await service.run('check', 'thread-1');
		const runs = (await fileService.resolve(URI.file('/ws/.vibe/local/runs'))).children ?? [];
		const briefFile = runs.length === 1 ? await fileService.readFile(URI.joinPath(runs[0].resource, 'brief.md')).then(f => f.value.toString(), () => undefined) : undefined;
		return { result, critic: subagents.handoffs[1], planner: subagents.handoffs[0], runFolders: runs.length, briefFile, pipeline };
	}

	// The seed's `screen-from-brief` was loaded for a long time by a parser that did not know the field: the
	// step judged by the story of the step before it, and nothing anywhere said so
	test('судья по брифу получает задачу прогона, а не рассказ планировщика, его файлы и дифф', async () => {
		const { result, critic, planner, runFolders, briefFile, pipeline } = await runPipeline({ againstBrief: true });
		const brief = composePipelineBrief(pipeline as never);
		assert.deepStrictEqual({
			completed: result.completed,
			plannerGoal: planner.goal,
			criticSeesBrief: critic.goal.endsWith(`\n${brief}`),
			criticHearsPlanner: critic.goal.includes(PLANNER_SAYS) || critic.goal.includes('Предыдущий шаг'),
			criticFiles: critic.contextItems,
			criticDiff: critic.diff,
			runFolders,
			briefFile,
		}, {
			completed: true,
			plannerGoal: 'Разбери задачу на требования',
			criticSeesBrief: true,
			criticHearsPlanner: false,
			criticFiles: undefined,
			criticDiff: undefined,
			runFolders: 1,
			briefFile: brief,
		});
	});

	test('без againstBrief тот же судья слышит планировщика, получает его файлы и дифф', async () => {
		const { critic } = await runPipeline({});
		assert.deepStrictEqual({
			hearsPlanner: critic.goal.includes(`Предыдущий шаг (planner) сообщил: ${PLANNER_SAYS}`),
			files: critic.contextItems,
			diff: critic.diff?.startsWith('Дифф прогона'),
		}, { hearsPlanner: true, files: ['docs/plan.md'], diff: true });
	});
});
