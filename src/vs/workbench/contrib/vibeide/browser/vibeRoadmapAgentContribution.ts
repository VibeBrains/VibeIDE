/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeRoadmapAgentContribution — "Roadmap Agent" mode in the main window.
 *
 * Allows the user to point the agent at a source-of-truth file (docs/roadmap.md,
 * .vibe/plans/*.plan.md, or a text selection) and let the orchestrator:
 *  1. Parse pending items from the file
 *  2. Build a delegation queue (inline vs. subagent)
 *  3. Execute each item or delegate to a typed subagent
 *
 * Command: vibeide.roadmapAgent.start
 * Keyboard shortcut: not bound by default (available in palette)
 *
 * Phase MVP: command + delegation queue preview (shows what would be delegated).
 * Phase 3b: actual orchestration loop with real subagent spawning.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';
import { IVibeContextGuardService } from './vibeContextGuardService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVibeRoadmapAgentExecutor } from './vibeRoadmapAgentExecutor.js';
import { RoadmapItem } from '../common/roadmapAgentLoop.js';

// ── Commands ──────────────────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.roadmapAgent.start',
			title: { value: localize('vibeide.roadmapAgent.start', 'Запустить Roadmap Agent (оркестрация делегированных субагентов)'), original: 'Start Roadmap Agent (orchestrate delegated subagents)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const registry = accessor.get(IVibeSubagentRegistryService);
		const contextGuard = accessor.get(IVibeContextGuardService);
		const notifications = accessor.get(INotificationService);

		// Step 1: pick the source-of-truth file
		const sourceChoice = await quickInput.pick([
			{ id: 'roadmap', label: 'docs/roadmap.md', description: localize('vibeide.roadmapAgent.source.roadmapDesc', 'Роадмап проекта (пункты [ ])') },
			{ id: 'plan', label: '.vibe/plans/*.plan.md', description: localize('vibeide.roadmapAgent.source.planDesc', 'Сохранённый план агента') },
			{ id: 'custom', label: localize('vibeide.roadmapAgent.source.customLabel', 'Указать путь вручную...'), description: localize('vibeide.roadmapAgent.source.customDesc', 'Ввести путь к файлу вручную') },
		], {
			title: localize('vibeide.roadmapAgent.source', 'Roadmap Agent: выберите источник истины'),
		});

		if (!sourceChoice) { return; }

		let sourcePath = '';
		if (sourceChoice.id === 'custom') {
			const input = await quickInput.input({ prompt: localize('vibeide.roadmapAgent.customPathPrompt', 'Введите путь к файлу относительно корня рабочей области') });
			if (!input) { return; }
			sourcePath = input;
		} else {
			sourcePath = sourceChoice.label;
		}

		// Step 2: get current context fill from VibeContextGuardService
		const contextStatus = contextGuard.getStatus();
		const contextFillPct = (contextStatus?.percentUsed ?? 0) / 100;

		// Step 3: parse items from source (Phase MVP: ask user for items directly)
		const itemsRaw = await quickInput.input({
			prompt: localize('vibeide.roadmapAgent.items', 'Вставьте незавершённые пункты (по одному на строку, или оставьте пустым для чтения из файла в фазе 3b)'),
			placeHolder: localize('vibeide.roadmapAgent.itemsPlaceholder', '- [ ] Implement X\n- [ ] Add Y'),
		});

		const items = (itemsRaw ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('- [ ]') || l.startsWith('[ ]'));

		if (items.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.roadmapAgent.noItems', 'Незавершённых пунктов не найдено. Фаза 3b: автоматический разбор из {0}.', sourcePath),
			});
			return;
		}

		// Step 4: build delegation queue
		const queue = registry.buildDelegationQueue(items, contextFillPct);
		const inline = queue.filter(q => !q.shouldDelegate);
		const delegated = queue.filter(q => q.shouldDelegate);

		// Step 5: show preview (Phase MVP: show delegation plan before executing)
		const preview = [
			`📋 Roadmap Agent plan for ${sourcePath} (context fill: ${Math.round(contextFillPct * 100)}%)`,
			``,
			`✅ Inline (${inline.length} items):`,
			...inline.map(q => `  - ${q.text.slice(0, 80)}`),
			``,
			`🤖 Delegated to subagents (${delegated.length} items):`,
			...delegated.map(q => `  - [${q.delegateType}] ${q.text.slice(0, 80)} (reason: ${q.delegationReason})`),
			``,
			`Phase 3b: Click Execute to start the orchestration loop.`,
		].join('\n');

		// Show in a notification (Phase 3b: render in sidebar plan panel)
		notifications.notify({
			severity: Severity.Info,
			message: preview.slice(0, 800),
		});
	}
});

// L885 — delegate-to-subagent pipeline command. Drives IVibeRoadmapAgentExecutor
// (FSM transitionLoop + decideSubagentIsolation + worker/fork spawn) over a list
// of pasted roadmap items. Auto-approve is gated by config.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.roadmapAgent.executeDelegation',
			title: { value: localize('vibeide.roadmapAgent.executeDelegation', 'Выполнить Roadmap Agent (делегирование субагентам)'), original: 'Execute Roadmap Agent (real subagent delegation)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const dialog = accessor.get(IDialogService);
		const config = accessor.get(IConfigurationService);
		const executor = accessor.get(IVibeRoadmapAgentExecutor);
		const notifications = accessor.get(INotificationService);

		const itemsRaw = await quickInput.input({
			prompt: localize('vibeide.roadmapAgent.executeItems', 'Вставьте пункты роадмапа (по одному на строку, префикс `- [ ]` необязателен)'),
			placeHolder: localize('vibeide.roadmapAgent.executeItems.placeholder', "- [ ] Implement X\n- [ ] Add Y"),
		});
		if (!itemsRaw) { return; }

		const items: RoadmapItem[] = itemsRaw.split('\n')
			.map(l => l.replace(/^\s*-\s*\[\s*\]\s*/, '').trim())
			.filter(l => l.length > 0)
			.map((summary, i) => ({
				id: `pasted-${i + 1}`,
				summary,
				bucket: 'must-finish' as const,
				priority: 10 - Math.min(9, i),
			}));

		if (items.length === 0) {
			notifications.notify({ severity: Severity.Warning, message: 'No items to delegate.' });
			return;
		}

		const confirm = await dialog.confirm({
			type: Severity.Info,
			message: localize('vibeide.roadmapAgent.confirmExecute', 'Делегировать {0} пунктов изолированным субагентам?', items.length),
			detail: items.slice(0, 8).map(i => '• ' + i.summary).join('\n') + (items.length > 8 ? `\n…and ${items.length - 8} more` : ''),
			primaryButton: localize('vibeide.roadmapAgent.confirmExecuteBtn', 'Делегировать'),
		});
		if (!confirm.confirmed) { return; }

		const autoApprove = config.getValue<boolean>('vibeide.roadmapAgent.autoApprove') === true;
		const parentTokens = config.getValue<number>('vibeide.roadmapAgent.parentTokenBudget') ?? 50000;

		try {
			const report = await executor.execute(items, {
				autoApprove,
				parentRemainingTokens: parentTokens,
			});
			const lines = [
				`Roadmap-agent finished: ${report.summary.closed} closed / ${report.summary.blocked} blocked / ${report.summary.skipped} skipped`,
				...report.records.slice(0, 10).map(r => `• [${r.outcome}] ${r.itemId} (${r.durationMs}ms)`),
			];
			notifications.notify({ severity: Severity.Info, message: lines.join('\n') });
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: `Roadmap-agent failed: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.roadmapAgent.previewDelegation',
			title: { value: localize('vibeide.roadmapAgent.previewDelegation', 'Предпросмотр делегирования роадмапа (какие пункты уйдут субагентам?)'), original: 'Preview Roadmap Delegation' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const registry = accessor.get(IVibeSubagentRegistryService);
		const notifications = accessor.get(INotificationService);

		const presets = registry.listPresets();
		const lines = [
			'Subagent Presets:',
			...presets.map(p => `  [${p.type}] ${p.displayName} — max ${p.defaultMaxSteps} steps, ${p.defaultMaxWallClockMs / 1000}s, ${(p.defaultMaxTokens / 1000).toFixed(0)}k tokens`),
			'',
			'Delegation triggers:',
			'  - Item tagged @subagent → always delegate to implement-step',
			'  - Context fill ≥ 60% → delegate to implement-step',
			'  - Item has > 3 sub-bullets → delegate to implement-step',
		];
		notifications.notify({ severity: Severity.Info, message: lines.join('\n') });
	}
});
