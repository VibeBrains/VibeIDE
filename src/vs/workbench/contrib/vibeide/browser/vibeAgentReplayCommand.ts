/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «VibeIDE: Повторить прогон роли» — run the same goal again, optionally on another model, and
 * compare the two.
 *
 * The replay RE-DOES the work; it does not re-play recorded steps. For a role that can write
 * files or run commands that means the side effects happen a second time, so such a replay is
 * confirmed explicitly and the report repeats the warning. Pretending otherwise would turn a
 * comparison feature into a way to silently duplicate edits.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeAgentRunLedgerService } from '../common/vibeAgentRunLedgerService.js';
import { IVibeSubagentService, SubagentType } from '../common/vibeSubagentService.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { AgentRunRecord, isTerminalRunStatus } from '../common/agentRunLedger.js';
import { compareRuns, renderRunComparisonMarkdown } from '../common/agentRunComparison.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { costOf as exchangeCostUsd } from '../common/spendLedger.js';

export const VIBEIDE_AGENT_REPLAY_ACTION_ID = 'vibeide.agents.replayRun';

/** Tools whose replay repeats a side effect rather than just re-reading the project. */
const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
	'edit_file', 'rewrite_file', 'create_file_or_folder', 'delete_file_or_folder', 'run_command', 'run_terminal_command',
]);

/** Cost of a finished run, or undefined when the model price is unknown — never a silent zero. */
function costOf(record: AgentRunRecord, overrides: Parameters<typeof getModelCapabilities>[2]): number | undefined {
	if (!record.provider || !record.model || record.tokensUsed === undefined) {
		return undefined;
	}
	const price = getModelCapabilities(record.provider, record.model, overrides).cost;
	// The ledger records one total, not an input/output split, so the whole amount is priced as
	// input. Both sides of the comparison are computed the same way, which is what makes the delta
	// meaningful; the absolute figure stays an estimate and is labelled as such in the report.
	return exchangeCostUsd(price, record.tokensUsed, 0, record.cachedTokens ?? 0);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_AGENT_REPLAY_ACTION_ID,
			title: localize2('vibeide.agents.replayRun', "VibeIDE: Повторить прогон роли"),
			f1: true,
			icon: Codicon.debugRestart,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Captured before the first await — the accessor is only valid synchronously.
		const ledger = accessor.get(IVibeAgentRunLedgerService);
		const subagents = accessor.get(IVibeSubagentService);
		const registry = accessor.get(IVibeSubagentRegistryService);
		const settings = accessor.get(IVibeideSettingsService);
		const quickInput = accessor.get(IQuickInputService);
		const dialogs = accessor.get(IDialogService);
		const notifications = accessor.get(INotificationService);
		const modelService = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);

		// Only runs that actually executed can be replayed meaningfully: an orphaned run has no
		// outcome to compare against, and a skipped one never ran at all — replaying it would just
		// hit the same refusal (an exhausted budget, say) and produce a comparison of two nothings.
		const finished = (await ledger.getRuns())
			.filter(run => isTerminalRunStatus(run.status) && run.status !== 'orphaned' && run.status !== 'skipped')
			.reverse();
		if (finished.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.replay.none', 'Завершённых прогонов пока нет — повторять нечего.') });
			return;
		}

		const pickedRun = await quickInput.pick(
			finished.slice(0, 50).map(run => ({
				label: run.goal.slice(0, 80) || run.runId,
				description: `${registry.getPreset(run.role as SubagentType).displayName} · ${run.model ?? 'модель неизвестна'}`,
				detail: localize('vibeide.replay.runDetail', 'токенов: {0}', (run.tokensUsed ?? 0).toLocaleString('ru-RU')),
				run,
			})),
			{ title: localize('vibeide.replay.pickRun', 'Какой прогон повторить?'), placeHolder: localize('vibeide.replay.pickRunHint', 'Задача будет выполнена заново') }
		);
		if (!pickedRun) {
			return;
		}
		const original = pickedRun.run;
		const role = original.role as SubagentType;
		const preset = registry.getPreset(role);

		const pickedModel = await quickInput.pick(
			[
				{ label: localize('vibeide.replay.sameModel', 'Та же модель'), description: original.model ?? '', selection: null },
				...settings.state._modelOptions.map(option => ({
					label: option.name,
					description: option.selection.providerName,
					selection: option.selection,
				})),
			],
			{ title: localize('vibeide.replay.pickModel', 'На какой модели повторить?'), placeHolder: localize('vibeide.replay.pickModelHint', 'Сравнение покажет разницу по токенам, шагам, времени и стоимости') }
		);
		if (!pickedModel) {
			return;
		}

		// A read-only role can be replayed freely; a writing one repeats its edits.
		if (preset.allowedTools.some(tool => SIDE_EFFECT_TOOLS.has(tool))) {
			const confirmation = await dialogs.confirm({
				type: 'warning',
				message: localize('vibeide.replay.confirmTitle', 'Роль «{0}» умеет менять файлы и запускать команды', preset.displayName),
				detail: localize('vibeide.replay.confirmDetail', 'Повтор выполняет задачу заново, а не воспроизводит записанные шаги, — правки будут сделаны второй раз. Продолжить?'),
				primaryButton: localize('vibeide.replay.confirmYes', 'Повторить'),
			});
			if (!confirmation.confirmed) {
				return;
			}
		}

		const replayId = await subagents.spawn({
			parentThreadId: original.parentThreadId,
			type: role,
			goal: original.goal,
			modelSelection: pickedModel.selection,
			replayOfRunId: original.runId,
		});

		notifications.notify({ severity: Severity.Info, message: localize('vibeide.replay.started', 'Повтор запущен. Сравнение откроется, когда прогон закончится.') });
		await subagents.awaitResult(replayId);

		const replay = (await ledger.getRuns()).find(run => run.runId === replayId);
		if (!replay) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.replay.noRecord', 'Повтор завершён, но записи о нём нет — включён ли журнал прогонов?') });
			return;
		}

		const overrides = settings.state.overridesOfModel;
		const markdown = renderRunComparisonMarkdown(
			compareRuns(original, replay, { originalUsd: costOf(original, overrides), replayUsd: costOf(replay, overrides) })
		);

		const uri = URI.parse(`untitled://vibeide-replay-${Date.now()}.md`);
		const ref = await modelService.createModelReference(uri);
		ref.object.textEditorModel?.setValue(markdown);
		ref.dispose();
		await editorService.openEditor({ resource: uri });
		try {
			await commandService.executeCommand('markdown.showPreview');
		} catch {
			// The markdown extension may be disabled — the source view is a fine outcome then.
		}
	}
});
