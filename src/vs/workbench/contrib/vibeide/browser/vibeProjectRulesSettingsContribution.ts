/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
			description: localize('vibeide.projectRules.disabledSources', 'Список путей к файлам правил проекта, исключаемых из инъекции в AI-контекст. Относительно корня рабочей области (например, "AGENTS.md", ".vibe/rules.md").'),
		},
		'vibeide.projectRules.maxCombinedChars': {
			type: 'number',
			default: 20000,
			minimum: 1000,
			maximum: 200000,
			description: localize('vibeide.projectRules.maxCombinedChars', 'Максимум суммарных символов объединённых правил проекта, подставляемых в системное сообщение AI. Большие файлы обрезаются.'),
		},
		'vibeide.projectRules.maxFiles': {
			type: 'number',
			default: 50,
			minimum: 1,
			maximum: 500,
			description: localize('vibeide.projectRules.maxFiles', 'Максимум файлов правил, обнаруживаемых в папках `.vibe/rules/` (защита от случайного огромного дерева). Лишние пропускаются с предупреждением в лог.'),
		},
		'vibeide.projectRules.maxFolderDepth': {
			type: 'number',
			default: 6,
			minimum: 1,
			maximum: 20,
			description: localize('vibeide.projectRules.maxFolderDepth', 'Глубина рекурсивного сканирования папок правил `.vibe/rules/`.'),
		},
		'vibeide.projectRules.maxFileBytes': {
			type: 'number',
			default: 102400,
			minimum: 1024,
			maximum: 5242880,
			description: localize('vibeide.projectRules.maxFileBytes', 'Максимальный размер одного файла правил (байты); большее обрезается.'),
		},
		'vibeide.projectRules.resolveLinks': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.projectRules.resolveLinks', 'Разрешать ссылки в правилах проекта (Cursor-style `[..](mdc:path)` и относительные `.md`-ссылки): содержимое связанных файлов подтягивается в AI-контекст отдельным пассивным блоком. Резолв только внутри рабочей области.'),
		},
		'vibeide.projectRules.resolveLinksRecursive': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.projectRules.resolveLinksRecursive', 'Рекурсивно следовать по ссылкам внутри уже подтянутых файлов (с защитой от циклов и общими лимитами). Выкл — только один уровень. Требует включённой `vibeide.projectRules.resolveLinks`.'),
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
		// Reload rules when disabled sources OR link-resolution settings change. Link toggles
		// affect which referenced files get pulled in, so a full reload re-resolves them.
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.projectRules.disabledSources')
				|| e.affectsConfiguration('vibeide.projectRules.resolveLinks')
				|| e.affectsConfiguration('vibeide.projectRules.resolveLinksRecursive')) {
				this._log.info('[VibeProjectRules] Rules/link settings changed — reloading rules');
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
			title: { value: localize('vibeide.projectRules.toggleSource', 'Переключить источник правил проекта (включить/выключить для AI-контекста)'), original: 'Toggle Project Rule Source (enable/disable for AI context)' },
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
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.projectRules.noSources', 'Файлы правил проекта не найдены.') });
			return;
		}

		const disabledSources = config.getValue<string[]>('vibeide.projectRules.disabledSources') ?? [];
		const picks = sources.map(s => ({
			label: s.relativePath,
			description: `${s.sizeBytes} bytes${s.wasRedacted ? ' (secrets redacted)' : ''}`,
			picked: !disabledSources.includes(s.relativePath),
		}));

		const selected = await quickInput.pick(picks, {
			title: localize('vibeide.projectRules.toggleTitle', 'Переключить источники правил проекта (отмеченные = включены для AI)'),
			canPickMany: true,
		});
		if (!selected) { return; }

		const newDisabled = sources
			.map(s => s.relativePath)
			.filter(p => !selected.some((sel: { label: string }) => sel.label === p));

		await config.updateValue('vibeide.projectRules.disabledSources', newDisabled, 5 /* WORKSPACE */);
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.projectRules.toggled', '{0} источников включено, {1} отключено.', selected.length, newDisabled.length),
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.projectRules.showStats',
			title: { value: localize('vibeide.projectRules.showStats', 'Показать статистику правил проекта (предпросмотр токенного бюджета)'), original: 'Show Project Rules Stats (token budget preview)' },
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
