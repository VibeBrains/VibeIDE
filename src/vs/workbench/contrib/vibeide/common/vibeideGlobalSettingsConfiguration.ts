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
					description: localize('vibeide.skills.globalPaths', 'Absolute paths of extra SKILL.md roots (parity with ~/.cursor/skills/). Workspace `.vibe/skills/` overrides same skill ids.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.skills.sessionActiveIds': {
					type: 'array',
					items: { type: 'string' },
					default: [],
					description: localize('vibeide.skills.sessionActiveIds', 'Skill ids (`name` from frontmatter) limited for GUIDELINES discovery this session. Empty = all loaded skills. Use Command Palette: “Skills — select for session”.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.auditSkillSuggestions': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.skills.auditSkillSuggestions', 'When audit logging is enabled (`vibeide.audit.enable`), append local-only events for `/skill:` usage and implicit keyword skill hints (no cloud).'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.notifyDiskDiff': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.skills.notifyDiskDiff', 'When a workspace `.vibe/skills/**` skill markdown file changes on disk, show an info notification with an optional diff against the previous in-memory snapshot.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.communityCatalogUrl': {
					type: 'string',
					default: '',
					description: localize('vibeide.skills.communityCatalogUrl', 'HTTPS URL of a community skills catalog JSON (`vibe-community-skills-catalog-v1`). Used as default for “Browse community skills catalog”. Leave empty to enter URL manually.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.discoveryDescriptionMaxChars': {
					type: 'number',
					default: 600,
					minimum: 0,
					maximum: 4096,
					description: localize('vibeide.skills.discoveryDescriptionMaxChars', 'Max characters per skill description in GUIDELINES discovery list (token/context control). 0 = no limit.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.implicitDescriptionMaxChars': {
					type: 'number',
					default: 400,
					minimum: 0,
					maximum: 4096,
					description: localize('vibeide.skills.implicitDescriptionMaxChars', 'Max characters per skill description in implicit keyword-retrieval hints block. 0 = no limit.'),
					scope: ConfigurationScope.RESOURCE,
				},
			},
		});
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(VibeideGlobalSettingsConfigurationContribution.ID, VibeideGlobalSettingsConfigurationContribution, WorkbenchPhase.BlockRestore);

