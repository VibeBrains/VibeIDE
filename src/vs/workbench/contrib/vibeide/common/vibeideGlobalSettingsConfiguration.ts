/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

export class VibeideGlobalSettingsConfigurationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideGlobalSettingsConfiguration';

	constructor() {
		super();

		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

		registry.registerConfiguration({
			id: 'vibeide.skills',
			title: localize('vibeide.skills.title', 'VibeIDE — Agent Skills'),
			type: 'object',
			properties: {
				'vibeide.skills.globalPaths': {
					type: 'array',
					items: { type: 'string' },
					default: [],
					description: localize('vibeide.skills.globalPaths', 'Абсолютные пути дополнительных корней SKILL.md (parity с ~/.cursor/skills/). Workspace `.vibe/skills/` перекрывает скиллы с теми же идентификаторами.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.skills.sessionActiveIds': {
					type: 'array',
					items: { type: 'string' },
					default: [],
					description: localize('vibeide.skills.sessionActiveIds', 'Идентификаторы скиллов (поле `name` из frontmatter), ограниченные для GUIDELINES-выдачи в этой сессии. Пусто = все загруженные скиллы. Меняется через Command Palette: «Skills — select for session».'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.auditSkillSuggestions': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.skills.auditSkillSuggestions', 'Когда включён журнал аудита (`vibeide.audit.enable`) — записывать локальные события про использование `/skill:` и неявные keyword-подсказки скиллов (без отправки в облако).'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.notifyDiskDiff': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.skills.notifyDiskDiff', 'Когда markdown-файл скилла из workspace `.vibe/skills/**` изменился на диске — показывать info-уведомление с опциональным diff к предыдущему in-memory снапшоту.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.communityCatalogUrl': {
					type: 'string',
					default: '',
					description: localize('vibeide.skills.communityCatalogUrl', 'HTTPS URL JSON-каталога сообщества скиллов (`vibe-community-skills-catalog-v1`). Используется как значение по умолчанию для «Browse community skills catalog». Пусто — вводить URL вручную.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.discoveryDescriptionMaxChars': {
					type: 'number',
					default: 600,
					minimum: 0,
					maximum: 4096,
					description: localize('vibeide.skills.discoveryDescriptionMaxChars', 'Максимум символов на описание скилла в GUIDELINES-списке (контроль токенов/контекста). 0 = без ограничений.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.implicitDescriptionMaxChars': {
					type: 'number',
					default: 400,
					minimum: 0,
					maximum: 4096,
					description: localize('vibeide.skills.implicitDescriptionMaxChars', 'Максимум символов на описание скилла в блоке неявных keyword-подсказок. 0 = без ограничений.'),
					scope: ConfigurationScope.RESOURCE,
				},
			},
		});
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(VibeideGlobalSettingsConfigurationContribution.ID, VibeideGlobalSettingsConfigurationContribution, WorkbenchPhase.BlockRestore);

