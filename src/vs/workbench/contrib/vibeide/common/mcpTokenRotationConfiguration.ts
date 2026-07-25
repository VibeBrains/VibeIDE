/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Registers vibeide.mcp.tokenRotation.* — thresholds of the MCP token rotation policy.
// Consumer: `vibeMCPTokenRotationContribution`, which reads them into `RotationPolicyConfig`.
// Defaults match ROTATION_DEFAULTS in `mcpTokenRotationPolicy.ts`.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { RotationPolicyConfig, ROTATION_DEFAULTS } from './mcpTokenRotationPolicy.js';

export const MCP_ROTATION_REMINDER_DAYS_KEY = 'vibeide.mcp.tokenRotation.reminderDays';
export const MCP_ROTATION_HARD_LIMIT_DAYS_KEY = 'vibeide.mcp.tokenRotation.hardLimitDays';
export const MCP_ROTATION_IDLE_REVOKE_DAYS_KEY = 'vibeide.mcp.tokenRotation.idleRevokeDays';

const DAY_MS = 24 * 60 * 60 * 1000;
const MS_TO_DAYS = (ms: number) => Math.round(ms / DAY_MS);

/** Build the policy config from configured day counts; a non-positive or absent value falls back to the default. */
export function rotationConfigFromDays(days: { reminder?: unknown; hardLimit?: unknown; idleRevoke?: unknown }): RotationPolicyConfig {
	const toMs = (value: unknown, fallbackMs: number): number => {
		const numeric = typeof value === 'number' ? value : NaN;
		return Number.isFinite(numeric) && numeric > 0 ? numeric * DAY_MS : fallbackMs;
	};
	return {
		rotationReminderAfterMs: toMs(days.reminder, ROTATION_DEFAULTS.rotationReminderAfterMs),
		rotationHardLimitMs: toMs(days.hardLimit, ROTATION_DEFAULTS.rotationHardLimitMs),
		idleAutoRevokeAfterMs: toMs(days.idleRevoke, ROTATION_DEFAULTS.idleAutoRevokeAfterMs),
	};
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.mcp',
	title: localize('vibeide.mcp.title', 'VibeIDE — MCP-серверы'),
	type: 'object',
	properties: {
		[MCP_ROTATION_REMINDER_DAYS_KEY]: {
			type: 'number',
			default: MS_TO_DAYS(ROTATION_DEFAULTS.rotationReminderAfterMs),
			minimum: 1,
			description: localize('vibeide.mcp.tokenRotation.reminderDays', 'Через сколько дней после входа в MCP-сервер напоминать о смене токена. Напоминание не отзывает доступ — это подсказка обновить долгоживущую авторизацию.'),
		},
		[MCP_ROTATION_HARD_LIMIT_DAYS_KEY]: {
			type: 'number',
			default: MS_TO_DAYS(ROTATION_DEFAULTS.rotationHardLimitMs),
			minimum: 1,
			description: localize('vibeide.mcp.tokenRotation.hardLimitDays', 'Предельный возраст авторизации MCP-сервера в днях. По его достижении вход отзывается автоматически, и сервер попросит авторизоваться заново.'),
		},
		[MCP_ROTATION_IDLE_REVOKE_DAYS_KEY]: {
			type: 'number',
			default: MS_TO_DAYS(ROTATION_DEFAULTS.idleAutoRevokeAfterMs),
			minimum: 1,
			description: localize('vibeide.mcp.tokenRotation.idleRevokeDays', 'Сколько дней простоя допускается, прежде чем неиспользуемая авторизация MCP-сервера отзывается автоматически. Чем меньше значение, тем меньше «забытых» действующих доступов.'),
		},
	},
});
