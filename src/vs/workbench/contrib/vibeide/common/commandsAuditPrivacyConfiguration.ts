/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Standalone configuration registration for the Project Commands audit-log
// privacy flags (roadmap §K.4 line 351). The pure helper
// `commandsAuditPrivacy.ts` already documents the shape and the consumer
// (`IVibeCustomCommandsService.run` hookup is still backlog), but the keys
// themselves were never visible in Settings UI — registering them ahead of
// the runtime lets users review the spec and pin defaults explicitly.
//
// Mirrors the pattern of `vibeAgentBehaviorConfiguration.ts` (pure
// registration; consumer files keep their existing `getValue` calls when they
// land).

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.commands',
	title: localize('vibeide.commands.title', 'VibeIDE — Project Commands'),
	type: 'object',
	properties: {
		'vibeide.commands.audit': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.commands.audit', 'Записывать в audit log запуски Project Commands (id, имя, exit code) после secret-substitution. Off-by-default; работает только если основной audit log включён через `vibeide.audit.enable`. Тела `command` / `env-values` редактируются через redactCommandForAudit — никогда не попадают в логи.'),
		},
		'vibeide.commands.auditStdout': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.commands.auditStdout', 'Дополнительно к `vibeide.commands.audit` записывать stdout/stderr запущенных Project Commands в audit log. Off-by-default; включение увеличивает размер логов и потенциально ловит секретозависимый вывод (heuristic секрет-фильтр в redactStreamForAudit стрипает строки с ghp_/sk-/AKIA/eyJ паттернами, но не идеален).'),
		},
	},
});
