/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { MenuId, registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';

/**
 * «Simplified vs full» chat-controls toggle (a cycling-icon Command Center button, right of the neon
 * toggle). When ON, the chat input hides everything except the mode + model dropdowns (autopilot and
 * link-recursion are force-enabled), so the composer isn't a wall of knobs for a casual user. Read
 * in the React composer as `vibeide.chat.simplifiedControls`. Default ON (simplified).
 */
export const CONFIG_SIMPLIFIED_CONTROLS = 'vibeide.chat.simplifiedControls';

/** Command id shared by Action2 + Command Palette. */
export const VIBEIDE_TOGGLE_SIMPLIFIED_CONTROLS_COMMAND_ID = 'vibeide.chat.toggleSimplifiedControls';

// FA6 solid: `eye` (U+F06E — everything visible → full view) / `eye-slash` (U+F070 — settings hidden
// → simplified view). Cycling icons, NOT a switch: the Command Center renders the action's icon and
// swaps it on the `toggled` condition.
const iconFull = registerVibeideFaSolidIcon('vibeide-chat-controls-full', '', localize('vibeideChatControlsFull', 'Все настройки чата'));
const iconSimplified = registerVibeideFaSolidIcon('vibeide-chat-controls-simplified', '', localize('vibeideChatControlsSimplified', 'Упрощённые настройки чата'));

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeideChat',
	order: 41,
	title: localize('vibeideChatConfigurationTitle', 'VibeIDE — Чат'),
	type: 'object',
	properties: {
		[CONFIG_SIMPLIFIED_CONTROLS]: {
			type: 'boolean',
			default: true,
			description: localize('vibeide.chat.simplifiedControlsDescription', 'Упрощённый вид панели чата: под полем ввода видны только «Режим» и «Модель», остальные настройки скрыты (сохраняя значения), а автопилот и рекурсия по ссылкам принудительно включены. По умолчанию включён. Переключается иконкой в шапке рядом с тумблером неона.'),
			scope: ConfigurationScope.WINDOW,
		},
	},
});

registerAction2(class VibeideToggleSimplifiedControls extends Action2 {

	static readonly ID = VIBEIDE_TOGGLE_SIMPLIFIED_CONTROLS_COMMAND_ID;

	constructor() {
		super({
			id: VibeideToggleSimplifiedControls.ID,
			title: localize2('vibeide.toggleSimplifiedControls', 'переключить упрощённый вид настроек чата'),
			tooltip: localize('vibeide.toggleSimplifiedControlsTooltip', 'Упрощённый вид: показать только «Режим» и «Модель», спрятав остальные настройки (автопилот и рекурсия по ссылкам остаются включёнными).'),
			category: Categories.View,
			f1: true,
			// Full (not toggled) shows the `eye` icon; simplified (toggled) shows `eye-slash`.
			icon: iconFull,
			toggled: {
				title: localize('vibeide.simplifiedControlsEnabled', 'Упрощённый вид настроек чата включён'),
				icon: iconSimplified,
				condition: ContextKeyExpr.equals(`config.${CONFIG_SIMPLIFIED_CONTROLS}`, true),
			},
			menu: [{
				id: MenuId.CommandCenter,
				order: 10003, // right after the neon glow toggle (10002)
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const cur = configurationService.getValue<boolean>(CONFIG_SIMPLIFIED_CONTROLS) ?? true;
		await configurationService.updateValue(CONFIG_SIMPLIFIED_CONTROLS, !cur, ConfigurationTarget.USER);
	}
});
