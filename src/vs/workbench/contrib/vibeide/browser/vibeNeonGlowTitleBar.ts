/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { append, EventHelper, type EventLike } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Toggle } from '../../../../base/browser/ui/toggle/toggle.js';
import { IAction } from '../../../../base/common/actions.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { MenuId, registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';

export const CONFIG_NEON_EDITOR_GLOW = 'vibeide.theme.neonEditorGlow';

/** Command id shared by Action2, Command Palette, and IActionViewItemService registration. */
export const VIBEIDE_TOGGLE_NEON_GLOW_COMMAND_ID = 'vibeide.theme.toggleNeonEditorGlow';

/** True when workbench theme is `vibe-neon` (toggle applies; `vibe-neon-noglow` stays CSS-managed only). */
export const NeonGlowTitleBarToggleVisible = new RawContextKey<boolean>('vibeide.neonGlowTitleBarToggleVisible', false);

/** FA6 solid `toggle-on` / `toggle-off` (private use U+F205 / U+F204). */
const neonGlowToggleIconOn = registerVibeideFaSolidIcon('vibeide-neon-editor-glow-on', '\uf205', localize('vibeideNeonGlowIconOn', '\u041d\u0435\u043e\u043d\u043e\u0432\u043e\u0435 \u0441\u0432\u0435\u0447\u0435\u043d\u0438\u0435 \u0440\u0435\u0434\u0430\u043a\u0442\u043e\u0440\u0430 \u0432\u043a\u043b\u044e\u0447\u0435\u043d\u043e'));
const neonGlowToggleIconOff = registerVibeideFaSolidIcon('vibeide-neon-editor-glow-off', '\uf204', localize('vibeideNeonGlowIconOff', '\u041d\u0435\u043e\u043d\u043e\u0432\u043e\u0435 \u0441\u0432\u0435\u0447\u0435\u043d\u0438\u0435 \u0440\u0435\u0434\u0430\u043a\u0442\u043e\u0440\u0430 \u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u043e'));

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeideTheme',
	order: 39,
	title: localize('vibeideThemeConfigurationTitle', 'VibeIDE — Тема'),
	type: 'object',
	properties: {
		[CONFIG_NEON_EDITOR_GLOW]: {
			type: 'boolean',
			default: true,
			description: localize('vibeide.theme.neonEditorGlowDescription', 'При использовании цветовой темы Vibe Neon добавляет неоновое свечение к подсветке синтаксиса в редакторе.'),
			scope: ConfigurationScope.WINDOW,
		},
	},
});

/** Native toggle row in Command Center (right of VibeIDE agent icon). */
class NeonGlowCommandCenterSwitchViewItem extends BaseActionViewItem {

	private _toggle: Toggle | undefined;

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(undefined, action, options);
	}

	protected override getTooltip(): string | undefined {
		return localize(
			'vibeide.toggleNeonEditorGlowTooltip',
			'Переключить неоновое свечение текста редактора (тема Vibe Neon).',
		);
	}

	override onClick(event: EventLike, _preserveFocus = false): void {
		EventHelper.stop(event, true);
	}

	private _readGlow(): boolean {
		return this._configurationService.getValue<boolean>(CONFIG_NEON_EDITOR_GLOW) ?? true;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('vibeide-neon-glow-command-center-item');

		const tooltip = this.getTooltip() ?? '';

		const glowOn = this._readGlow();
		this._toggle = this._register(new Toggle({
			isChecked: glowOn,
			title: tooltip,
			icon: glowOn ? neonGlowToggleIconOn : neonGlowToggleIconOff,
			inputActiveOptionBorder: undefined,
			inputActiveOptionForeground: undefined,
			inputActiveOptionBackground: undefined,
			skipInlineCheckedStyles: true,
		}));

		append(container, this._toggle.domNode);

		this._register(this._toggle.onChange(() => {
			if (this._toggle) {
				const next = this._toggle.checked;
				this._toggle.setIcon(next ? neonGlowToggleIconOn : neonGlowToggleIconOff);
				void this._configurationService.updateValue(CONFIG_NEON_EDITOR_GLOW, next, ConfigurationTarget.USER);
			}
		}));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_NEON_EDITOR_GLOW) && this._toggle) {
				const on = this._readGlow();
				this._toggle.checked = on;
				this._toggle.setIcon(on ? neonGlowToggleIconOn : neonGlowToggleIconOff);
			}
		}));

		this.updateAriaLabel();
		this.updateTooltip();
	}
}

class NeonGlowCommandCenterViewItemContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideNeonGlowCommandCenterSwitch';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		const glowConfigChanged = Event.filter(
			configurationService.onDidChangeConfiguration,
			e => e.affectsConfiguration(CONFIG_NEON_EDITOR_GLOW),
		);
		this._register(actionViewItemService.register(
			MenuId.CommandCenter,
			VIBEIDE_TOGGLE_NEON_GLOW_COMMAND_ID,
			(action, options, insta) => insta.createInstance(NeonGlowCommandCenterSwitchViewItem, action, options),
			glowConfigChanged,
		));
	}
}

registerWorkbenchContribution2(NeonGlowCommandCenterViewItemContribution.ID, NeonGlowCommandCenterViewItemContribution, WorkbenchPhase.AfterRestored);

registerAction2(class VibeideToggleNeonEditorGlow extends Action2 {

	static readonly ID = VIBEIDE_TOGGLE_NEON_GLOW_COMMAND_ID;

	constructor() {
		super({
			id: VibeideToggleNeonEditorGlow.ID,
			title: localize2('vibeide.toggleNeonEditorGlow', 'Переключить неоновое свечение редактора Vibe Neon'),
			tooltip: localize(
				'vibeide.toggleNeonEditorGlowTooltip',
				'Переключить неоновое свечение текста редактора (тема Vibe Neon).',
			),
			category: Categories.View,
			f1: true,
			icon: neonGlowToggleIconOff,
			toggled: {
				title: localize('vibeide.neonGlowEnabled', 'Неоновое свечение редактора включено'),
				icon: neonGlowToggleIconOn,
				condition: ContextKeyExpr.equals(`config.${CONFIG_NEON_EDITOR_GLOW}`, true),
			},
			menu: [{
				id: MenuId.CommandCenter,
				order: 10002,
				when: ContextKeyExpr.equals(NeonGlowTitleBarToggleVisible.key, true),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const cur = configurationService.getValue<boolean>(CONFIG_NEON_EDITOR_GLOW) ?? true;
		await configurationService.updateValue(CONFIG_NEON_EDITOR_GLOW, !cur, ConfigurationTarget.USER);
	}
});
