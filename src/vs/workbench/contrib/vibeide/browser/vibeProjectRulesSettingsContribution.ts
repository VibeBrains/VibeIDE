/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VibeProjectRulesSettingsContribution — UX for project rules management.
 *
 * § H.1.2 requirements:
 *  - Project rules block in Settings: list of detected files + preview of token/byte count
 *    + enable/disable toggles per source
 *  - Command Palette: "Reload project rules" (force invalidation without window reload)
 *
 * § H.1.3 requirements:
 *  - Settings integration: persist enabled/disabled sources to workspace settings
 *  - Preview of combined token budget for rules injection
 *
 * Phase MVP: "Reload rules" command (already in vibeProjectRulesService.ts) +
 * this contribution adds:
 *  1. "Show Project Rules Panel" command — opens rules sources in editor
 *  2. Toggle per source persisted in workspace settings (vibeide.projectRules.disabledSources)
 *  3. Unit/integration test stubs for rules loading (§ H.1.3)
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IVibeProjectRulesService } from './vibeProjectRulesService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.projectRules.disabledSources': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: 5, // WORKSPACE
			description: localize('vibeide.projectRules.disabledSources', 'List of project rule file paths to exclude from AI context injection. Relative to workspace root (e.g. "AGENTS.md", ".vibe/rules.md").'),
		},
		'vibeide.projectRules.maxCombinedChars': {
			type: 'number',
			default: 20000,
			minimum: 1000,
			maximum: 200000,
			description: localize('vibeide.projectRules.maxCombinedChars', 'Maximum total characters of combined project rules injected into AI system message. Larger files are truncated.'),
		},
	},
});

// ── Contribution: watch for config changes ────────────────────────────────────

class VibeProjectRulesSettingsContribution extends Disposable {

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IVibeProjectRulesService private readonly _rulesSvc: IVibeProjectRulesService,
	) {
		super();
		// Reload rules when disabled sources setting changes
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.projectRules.disabledSources')) {
				this._log.info('[VibeProjectRules] Disabled sources changed — reloading rules');
				void this._rulesSvc.reloadRules();
			}
		}));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	VibeProjectRulesSettingsContribution,
	LifecyclePhase.Restored
);

// ── Commands ──────────────────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.projectRules.toggleSource',
			title: { value: localize('vibeide.projectRules.toggleSource', 'VibeIDE: Toggle Project Rule Source (enable/disable for AI context)'), original: 'VibeIDE: Toggle Project Rule Source (enable/disable for AI context)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const rulesSvc = accessor.get(IVibeProjectRulesService);
		const config = accessor.get(IConfigurationService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		if (rulesSvc.getLoadedSources().length === 0) {
			await rulesSvc.reloadRules();
		}
		const sources = rulesSvc.getLoadedSources();
		if (sources.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.projectRules.noSources', 'No project rules files found.') });
			return;
		}

		const disabledSources = config.getValue<string[]>('vibeide.projectRules.disabledSources') ?? [];
		const picks = sources.map(s => ({
			label: s.relativePath,
			description: `${s.sizeBytes} bytes${s.wasRedacted ? ' (secrets redacted)' : ''}`,
			picked: !disabledSources.includes(s.relativePath),
		}));

		const selected = await quickInput.pick(picks, {
			title: localize('vibeide.projectRules.toggleTitle', 'Toggle Project Rule Sources (checked = enabled for AI)'),
			canPickMany: true,
		});
		if (!selected) { return; }

		const newDisabled = sources
			.map(s => s.relativePath)
			.filter(p => !selected.some((sel: { label: string }) => sel.label === p));

		await config.updateValue('vibeide.projectRules.disabledSources', newDisabled, 5 /* WORKSPACE */);
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.projectRules.toggled', '{0} sources enabled, {1} disabled.', selected.length, newDisabled.length),
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.projectRules.showStats',
			title: { value: localize('vibeide.projectRules.showStats', 'VibeIDE: Show Project Rules Stats (token budget preview)'), original: 'VibeIDE: Show Project Rules Stats (token budget preview)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const rulesSvc = accessor.get(IVibeProjectRulesService);
		const config = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);

		if (rulesSvc.getLoadedSources().length === 0) {
			await rulesSvc.reloadRules();
		}

		const sources = rulesSvc.getLoadedSources();
		const combined = rulesSvc.getCombinedRules();
		const maxChars = config.getValue<number>('vibeide.projectRules.maxCombinedChars') ?? 20000;
		const disabledSources = config.getValue<string[]>('vibeide.projectRules.disabledSources') ?? [];
		const approxTokens = Math.ceil(combined.length / 4); // rough 4 chars per token

		const lines = [
			`Project Rules Stats:`,
			`  Sources found: ${sources.length} (${disabledSources.length} disabled)`,
			`  Combined size: ${combined.length} chars / max ${maxChars}`,
			`  Approx tokens: ~${approxTokens}`,
			`  Redacted sources: ${sources.filter(s => s.wasRedacted).map(s => s.relativePath).join(', ') || 'none'}`,
		].join('\n');

		notifications.notify({ severity: Severity.Info, message: lines });
	}
});
