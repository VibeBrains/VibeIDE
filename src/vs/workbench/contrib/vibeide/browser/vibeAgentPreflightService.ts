/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Collects the facts behind «Проверить запуск».
 *
 * Strictly read-only: it reads configuration, the loaded rule sets and the current model
 * selection, then hands everything to the pure `agentLaunchPreflight` evaluator. No workspace is
 * created, no provider is contacted, no file is written — the whole point is to answer "what will
 * be allowed" without paying for a run to find out.
 *
 * Tool lists come from `availableTools` (main agent) and the role registry (subagents), never
 * from a local copy of those rules: a second source would drift and quietly lie.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { LaunchPlanFacts } from '../common/agentLaunchPreflight.js';
import { evaluateRoleBudget } from '../common/agentRoleBudget.js';
import { IVibeConstraintsService } from '../common/vibeConstraintsService.js';
import { IVibePerFilePermissionsService } from '../common/vibePerFilePermissionsService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';
import { IVibeAgentRunLedgerService } from '../common/vibeAgentRunLedgerService.js';
import { IVibeVerifyGateService } from './vibeVerifyGateService.js';
import { availableTools } from '../common/prompt/prompts.js';
import { DEFAULT_SUBAGENT_TOKEN_QUOTA } from '../common/subagentIsolationPolicy.js';
import type { SubagentType } from '../common/vibeSubagentService.js';

/** Mirrors the runner defaults so the report never promises a limit the run will not honour. */
const DEFAULT_MAX_STEPS = 60;
const DEFAULT_MAX_WALL_CLOCK_SEC = 300;

export const IVibeAgentPreflightService = createDecorator<IVibeAgentPreflightService>('vibeAgentPreflightService');

export interface IVibeAgentPreflightService {
	readonly _serviceBrand: undefined;

	/** Facts for the main chat agent in its current mode. */
	collectForAgent(): LaunchPlanFacts;

	/** Facts for one subagent role, using the role's own tool whitelist and cumulative budget. */
	collectForRole(role: SubagentType): Promise<LaunchPlanFacts>;
}

class VibeAgentPreflightService extends Disposable implements IVibeAgentPreflightService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibeConstraintsService private readonly _constraints: IVibeConstraintsService,
		@IVibePerFilePermissionsService private readonly _permissions: IVibePerFilePermissionsService,
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
		@IVibeSubagentRegistryService private readonly _registry: IVibeSubagentRegistryService,
		@IVibeVerifyGateService private readonly _verifyGate: IVibeVerifyGateService,
		@IVibeAgentRunLedgerService private readonly _ledger: IVibeAgentRunLedgerService,
	) {
		super();
	}

	collectForAgent(): LaunchPlanFacts {
		const chatMode = this._settings.state.globalSettings.chatMode;
		// Same resolver the prompt builder uses — the mode→tools mapping must have one owner.
		const tools = availableTools(chatMode, undefined) ?? [];
		return this._compose({
			subject: 'agent',
			subjectName: 'Основной агент',
			allowedTools: tools.map(tool => tool.name),
		});
	}

	async collectForRole(role: SubagentType): Promise<LaunchPlanFacts> {
		const preset = this._registry.getPreset(role);
		const base = this._compose({
			subject: 'role',
			subjectName: preset.displayName,
			allowedTools: [...preset.allowedTools],
		});

		// The cumulative ceiling can refuse the run outright, so a report that omitted it would
		// promise a launch that will not happen. Reading the ledger is the only async part here.
		const budgets = this._settings.state.tokenBudgetOfRole ?? {};
		if (!budgets[role]) {
			return base;
		}
		const windowDays = this._numberConfig('vibeide.subagent.budgetWindowDays', 1);
		const state = evaluateRoleBudget(await this._ledger.getRuns(), role, budgets, Date.now(), windowDays);
		return { ...base, roleBudget: state.budget, roleBudgetSpent: state.spent, roleBudgetWindowDays: windowDays };
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private _compose(subject: Pick<LaunchPlanFacts, 'subject' | 'subjectName' | 'allowedTools'>): LaunchPlanFacts {
		const selection = this._settings.state.modelSelectionOfFeature['Chat'];
		const model = selection?.modelName ?? '(не выбрана)';
		const provider = selection?.providerName ?? '(не выбран)';
		const folders = this._workspace.getWorkspace().folders;

		return {
			...subject,
			provider,
			model,
			// An unselected model cannot be checked against the whitelist; treat it as allowed so
			// the report blames the real problem (nothing selected) rather than a phantom rule.
			modelAllowed: selection ? this._constraints.isModelAllowed(model) : true,
			workspaceName: folders.length > 0 ? folders[0].name : '(папка не открыта)',
			constraintRules: this._constraints.getRules(),
			permissions: this._permissions.getPermissions(),
			autopilot: this._settings.state.globalSettings.chatAgentAutopilot === true,
			tokenQuota: this._numberConfig('vibeide.subagent.maxTokens', DEFAULT_SUBAGENT_TOKEN_QUOTA),
			maxSteps: this._numberConfig('vibeide.subagent.maxSteps', DEFAULT_MAX_STEPS),
			maxWallClockSec: this._numberConfig('vibeide.subagent.maxWallClockSec', DEFAULT_MAX_WALL_CLOCK_SEC),
			verifyGateMode: this._verifyGate.getMode(),
			verifyCommand: this._configuration.getValue<string>('vibeide.agent.verifyGate.command') ?? '',
			runLedgerEnabled: this._ledger.isEnabled(),
		};
	}

	private _numberConfig(key: string, fallback: number): number {
		const raw = this._configuration.getValue<number>(key);
		return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
	}
}

registerSingleton(IVibeAgentPreflightService, VibeAgentPreflightService, InstantiationType.Delayed);
