/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVibeCircuitBreakerService } from '../../common/agentCircuitBreakers.js';
import { IAuditLogService } from '../../common/auditLogService.js';
import { IVibeAgentRunLedgerService } from '../../common/vibeAgentRunLedgerService.js';
import { IVibeConstraintsService } from '../../common/vibeConstraintsService.js';
import { IVibeGitWorktreeService } from '../../common/vibeGitWorktreeService.js';
import { IVibeideSettingsService } from '../../common/vibeideSettingsService.js';
import { IVibeSubagentRegistryService } from '../../common/vibeSubagentRegistryService.js';
import { IVibeSubagentRunner, SubagentRunOutcome, SubagentRunRequest } from '../../common/vibeSubagentRunner.js';
import { VibeSubagentService } from '../../common/vibeSubagentService.js';

/**
 * Stopping a run that someone is waiting for.
 *
 * A pipeline awaits every step's result; disposing a step from the dispatch panel used to drop the
 * waiter unresolved, and the pipeline then waited forever.
 */
suite('VibeSubagentService — stopping a run under way', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('whoever awaits a disposed run receives «stopped», and the run itself is cancelled', async () => {
		let runnerCancelled = false;
		const runner: Pick<IVibeSubagentRunner, 'run'> = {
			// A run that ends only when it is cancelled — the way a long step looks from outside.
			run: (request: SubagentRunRequest) => new Promise<SubagentRunOutcome>(resolve => {
				const listener = request.cancellationToken?.onCancellationRequested(() => {
					listener?.dispose();
					runnerCancelled = true;
					resolve({ status: 'failed', summary: 'отменён', artifacts: [], tokensUsedEst: 0, truncated: true, stopReason: 'отменён родителем', transcript: [] });
				});
			}),
		};
		const service = store.add(new VibeSubagentService(
			new NullLogService(),
			{ getValue: () => undefined } as unknown as IConfigurationService,
			{ append: () => { } } as unknown as IAuditLogService,
			{} as IVibeConstraintsService,
			runner as IVibeSubagentRunner,
			{ epoch: 1, allocateFence: () => 1, recordStarted: () => { }, recordUpdate: () => { }, getRuns: async () => [] } as unknown as IVibeAgentRunLedgerService,
			{ state: { tokenBudgetOfRole: {}, usdBudgetOfRole: {}, globalSettings: { chatAgentAutopilot: false } } } as unknown as IVibeideSettingsService,
			{ getPreset: () => ({ displayName: 'Ревьюер' }) } as unknown as IVibeSubagentRegistryService,
			{ isBlocking: () => false } as unknown as IVibeCircuitBreakerService,
			{} as IFileService,
			{} as IWorkspaceContextService,
			{} as IVibeGitWorktreeService,
		));
		const id = await service.spawn({ parentThreadId: 't', type: 'code-reviewer', goal: 'проверь' });
		const waiting = service.awaitResult(id);
		// Let the run reach the runner before it is stopped.
		await new Promise(resolve => setTimeout(resolve, 0));
		service.disposeSubagent(id);
		const result = await waiting;
		assert.deepStrictEqual(
			{ status: result.status, stopCode: result.stopCode, runnerCancelled, registered: service.getStatus(id) !== undefined },
			{ status: 'stopped', stopCode: 'cancelled', runnerCancelled: true, registered: false },
		);
	});
});
