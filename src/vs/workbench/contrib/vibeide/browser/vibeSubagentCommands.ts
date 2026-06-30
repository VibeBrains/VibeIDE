/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Palette commands for VibeIDE Subagent features.
 *
 * - vibeide.subagent.spawnExplore — spawn an explore subagent for a user-provided goal
 * - vibeide.subagent.listActive — show all active subagents for the current session
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { IVibeSubagentService } from '../common/vibeSubagentService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

// ── Spawn explore subagent ────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.subagent.spawnExplore',
			title: { value: localize('vibeide.subagent.spawnExplore', 'Субагент: запустить исследование (поиск по кодовой базе, только чтение)'), original: 'Subagent: Spawn Explore (read-only codebase search)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const subagentSvc = accessor.get(IVibeSubagentService);
		const notifications = accessor.get(INotificationService);

		const goal = await quickInput.input({
			prompt: localize('vibeide.subagent.spawnExplore.prompt', 'Что должен найти субагент исследования? (только чтение, изолированный контекст)'),
			placeHolder: localize('vibeide.subagent.spawnExplore.placeholder', 'напр. Найди все использования IVibeConstraintsService'),
		});

		if (!goal?.trim()) { return; }

		const { subagentId, awaitResult } = await subagentSvc.spawnExplore({
			parentThreadId: `palette-${Date.now()}`,
			goal: goal.trim(),
			maxSteps: 15,
			maxWallClockMs: 30_000,
		});

		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.subagent.spawned', 'Субагент исследования запущен (id: {0}). Ожидание результата...', subagentId),
		});

		try {
			const result = await awaitResult();
			const paths = result.exploreReport?.paths?.join('\n') ?? 'No paths found';
			notifications.notify({
				severity: result.status === 'success' ? Severity.Info : Severity.Warning,
				message: localize('vibeide.subagent.result',
					'Субагент исследования завершил работу ({0}): {1}\n\nПути: {2}',
					result.status,
					result.summary.slice(0, 200),
					paths.slice(0, 300)
				),
			});
		} catch (err) {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.subagent.error', 'Ошибка субагента: {0}', String(err)) });
		}
	}
});

// ── List active subagents ──────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.subagent.listActive',
			title: { value: localize('vibeide.subagent.listActive', 'Субагент: список активных субагентов'), original: 'Subagent: List Active Subagents' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const subagentSvc = accessor.get(IVibeSubagentService);
		const quickInput = accessor.get(IQuickInputService);

		// Get all subagents across all parent threads
		const allEntries = subagentSvc.getAll();

		if (allEntries.length === 0) {
			const notifications = accessor.get(INotificationService);
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.subagent.none', 'Нет активных субагентов.') });
			return;
		}

		await quickInput.pick(
			allEntries.map(e => ({
				label: localize('vibeide.subagent.listItemLabel', '{0} — {1}', String(e.type), String(e.status)),
				description: e.handoff.goal.slice(0, 80),
				detail: localize('vibeide.subagent.listItemDetail', 'id: {0} | parent: {1}', String(e.id), String(e.parentThreadId)),
			})),
			{ title: localize('vibeide.subagent.listTitle', 'Активные субагенты') }
		);
	}
});
