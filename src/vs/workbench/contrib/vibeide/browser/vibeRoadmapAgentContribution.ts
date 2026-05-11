/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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

// ── Commands ──────────────────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.roadmapAgent.start',
			title: { value: localize('vibeide.roadmapAgent.start', 'VibeIDE: Start Roadmap Agent (orchestrate delegated subagents)'), original: 'VibeIDE: Start Roadmap Agent (orchestrate delegated subagents)' },
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
			{ id: 'roadmap', label: 'docs/roadmap.md', description: 'Project roadmap ([ ] items)' },
			{ id: 'plan', label: '.vibe/plans/*.plan.md', description: 'Persisted agent plan' },
			{ id: 'custom', label: 'Custom path...', description: 'Enter file path manually' },
		], {
			title: localize('vibeide.roadmapAgent.source', 'Roadmap Agent: Choose source of truth'),
		});

		if (!sourceChoice) { return; }

		let sourcePath = '';
		if (sourceChoice.id === 'custom') {
			const input = await quickInput.input({ prompt: 'Enter file path relative to workspace root' });
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
			prompt: localize('vibeide.roadmapAgent.items', 'Paste pending items (one per line, or leave empty to read from file in Phase 3b)'),
			placeHolder: localize('vibeide.roadmapAgent.itemsPlaceholder', '- [ ] Implement X\n- [ ] Add Y'),
		});

		const items = (itemsRaw ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('- [ ]') || l.startsWith('[ ]'));

		if (items.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.roadmapAgent.noItems', 'No pending items found. Phase 3b: automatic parsing from {0}.', sourcePath),
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

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.roadmapAgent.previewDelegation',
			title: { value: localize('vibeide.roadmapAgent.previewDelegation', 'VibeIDE: Preview Roadmap Delegation (which items go to subagents?)'), original: 'VibeIDE: Preview Roadmap Delegation' },
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
